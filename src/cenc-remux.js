// SPDX-License-Identifier: GPL-3.0-only
// Encrypted progressive MP4 -> clear fMP4 over MSE.
// Works with a dedicated pinned Librempeg WASM; never buffers an entire episode.
import { errorWith } from './logic.js';

const MAX_CORE = 24 * 1024 * 1024;
let availability = null;

export async function cencRemuxAvailable() {
  if (typeof Worker !== 'function' || typeof MediaSource !== 'function') return false;
  const coreUrl = new URL(import.meta.env.BASE_URL + 'cenc/cenc-core.wasm', location.href);
  if (!availability) {
    availability = fetch(coreUrl, { method: 'HEAD', cache: 'force-cache' })
      .then(res => res.ok &&
        /^(application\/wasm|application\/octet-stream)\b/i.test(
          res.headers.get('content-type') || '') &&
        Number(res.headers.get('content-length') || 0) < MAX_CORE)
      .catch(() => false);
  }
  return availability;
}
const waitSourceOpen = mediaSource => new Promise((resolve, reject) => {
  if (mediaSource.readyState === 'open') return resolve();
  const cleanup = () => {
    mediaSource.removeEventListener('sourceopen', opened);
    mediaSource.removeEventListener('sourceclose', closed);
  };
  const opened = () => { cleanup(); resolve(); };
  const closed = () => { cleanup(); reject(new Error('MediaSource closed')); };
  mediaSource.addEventListener('sourceopen', opened, { once: true });
  mediaSource.addEventListener('sourceclose', closed, { once: true });
});
const waitAppend = (sourceBuffer, bytes) => new Promise((resolve, reject) => {
  const cleanup = () => {
    sourceBuffer.removeEventListener('updateend', done);
    sourceBuffer.removeEventListener('error', failed);
    sourceBuffer.removeEventListener('abort', failed);
  };
  const done = () => { cleanup(); resolve(); };
  const failed = () => { cleanup(); reject(new Error('SourceBuffer append failed')); };
  sourceBuffer.addEventListener('updateend', done, { once: true });
  sourceBuffer.addEventListener('error', failed, { once: true });
  sourceBuffer.addEventListener('abort', failed, { once: true });
  try { sourceBuffer.appendBuffer(bytes); } catch (error) { cleanup(); reject(error); }
});

// Prevent the worker from fetching the rest of a paused 300-second episode.
// ACK the next fragment only when the buffered-ahead interval falls below 25s.
function waitBufferHeadroom(video, sourceBuffer, signal) {
  let end = 0;
  try {
    if (!sourceBuffer.buffered.length) return Promise.resolve();
    end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
  } catch { return Promise.resolve(); }
  if (end - video.currentTime < 40) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      for (const event of ['timeupdate', 'seeked', 'playing'])
        video.removeEventListener(event, check);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const check = () => {
      if (signal?.aborted) return finish();
      try {
        if (!sourceBuffer.buffered.length ||
            sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) -
              video.currentTime < 25) finish();
      } catch { finish(); }
    };
    for (const event of ['timeupdate', 'seeked', 'playing'])
      video.addEventListener(event, check);
    signal?.addEventListener('abort', finish, { once: true });
    check();
  });
}

/**
 * @returns {{url:string,kind:string,close:()=>Promise<void>}|null}
 * Returns immediately with an object URL. The caller must assign video.src
 * before MSE opens; Worker output waits for sourceopen/SourceBuffer ACKs.
 */
export async function openCencProgressiveStream({
  video, url, fileSize, codec, hasAac, key, signal
}) {
  if (!/^[a-f0-9]{32}$/i.test(key || '')) return null;
  const videoCodec = codec === 'hevc' ? 'hvc1' :
    codec === 'h264' ? 'avc1.42E01E' : null;
  if (!videoCodec) return null;
  const mime = 'video/mp4; codecs="' + videoCodec +
    (hasAac ? ', mp4a.40.2' : '') + '"';
  if (typeof MediaSource === 'undefined' ||
      !MediaSource.isTypeSupported?.(mime) || !video.canPlayType(mime) ||
      !await cencRemuxAvailable()) return null;
  if (signal?.aborted) throw errorWith('CANCELED', '已切換影片');

  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  const worker = new Worker(new URL('./cenc-remux-worker.js', import.meta.url), {
    type: 'module'
  });
  let closed = false, buffer = null, queued = Promise.resolve(), finished = false;
  const fail = cause => {
    if (closed) return;
    // Do not show original URL or key in logs.
    console.info('[Hongguo CENC] streaming bridge failed:', cause || 'unknown');
    try {
      if (ms.readyState === 'open' && !buffer?.updating)
        ms.endOfStream('decode');
    } catch { /* player handles video.onerror and retries */ }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    worker.postMessage({ type: 'cancel' });
    worker.terminate();
    URL.revokeObjectURL(objectUrl);
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  worker.onerror = event => {
    event.preventDefault();
    fail('worker-error');
  };
  worker.onmessage = ({ data }) => {
    if (closed || !data) return;
    if (data.type === 'error') return fail('wasm-remux');
    if (data.type === 'done') {
      finished = true;
      void queued.then(() => {
        if (!closed && ms.readyState === 'open' && !buffer?.updating)
          ms.endOfStream();
      }).catch(() => fail('finish'));
      return;
    }
    if (data.type !== 'init' && data.type !== 'media') return;
    queued = queued.then(async () => {
      await waitSourceOpen(ms);
      if (closed) return;
      if (data.type === 'init') {
        if (buffer) throw new Error('Duplicate MSE init');
        buffer = ms.addSourceBuffer(mime);
      }
      if (!buffer) throw new Error('Missing MSE initialization');
      await waitAppend(buffer, new Uint8Array(data.bytes));
      await waitBufferHeadroom(video, buffer, signal);
      if (!closed) worker.postMessage({ type: 'ack', id: data.id });
    }).catch(() => fail('source-buffer'));
  };
  worker.postMessage({ type: 'start', url, fileSize, key });
  return { url: objectUrl, kind: 'cenc-remux',
    close, mime, finished: () => finished };
}
