// SPDX-License-Identifier: GPL-3.0-only
// Encrypted progressive MP4 -> clear fMP4 over MSE.
// Works with a dedicated pinned Librempeg WASM; never buffers an entire episode.
import { bvc2BridgeAvailable } from './bvc2.js';
import { errorWith } from './logic.js';
import { evictionEnd } from './mse-eviction.js';
import { retryableAvailability } from './retryable-availability.js';
import { assertHevcInitCodecMatches } from './cenc-init-codec.js';
import { alignInitialCencBufferedStart } from './mse-start-gap.js';

const MAX_CORE = 24 * 1024 * 1024;
const checkCencCore = retryableAvailability(async () => {
  const coreUrl = new URL((import.meta.env?.BASE_URL || '/') + 'cenc/cenc-core.wasm',
    location.href);
  const res = await fetch(coreUrl, { method: 'HEAD', cache: 'force-cache' });
  return res.ok &&
    /^(application\/wasm|application\/octet-stream)\b/i.test(
      res.headers.get('content-type') || '') &&
    Number(res.headers.get('content-length') || 0) < MAX_CORE;
});

export async function cencRemuxAvailable() {
  if (typeof Worker !== 'function' || typeof MediaSource !== 'function')
    return false;
  // Temporary deployment races or HEAD failures must be retryable.
  return checkCencCore();
}
const waitSourceOpen = (mediaSource, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('CENC stream canceled'));
  if (mediaSource.readyState === 'open') return resolve();
  // Once MSE entered 'ended' it cannot emit sourceopen again. Fail promptly
  // instead of leaving a queued Worker unit waiting for an impossible event.
  if (mediaSource.readyState === 'ended')
    return reject(new Error('MediaSource ended before fragment append'));
  const cleanup = () => {
    mediaSource.removeEventListener('sourceopen', opened);
    mediaSource.removeEventListener('sourceclose', closed);
    signal?.removeEventListener('abort', canceled);
  };
  const opened = () => { cleanup(); resolve(); };
  const closed = () => { cleanup(); reject(new Error('MediaSource closed')); };
  const canceled = () => { cleanup(); reject(new Error('CENC stream canceled')); };
  mediaSource.addEventListener('sourceopen', opened, { once: true });
  mediaSource.addEventListener('sourceclose', closed, { once: true });
  signal?.addEventListener('abort', canceled, { once: true });
  if (signal?.aborted) canceled();
});
const waitBufferUpdate = (sourceBuffer, action, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('CENC stream canceled'));
  const cleanup = () => {
    sourceBuffer.removeEventListener('updateend', done);
    sourceBuffer.removeEventListener('error', failed);
    sourceBuffer.removeEventListener('abort', failed);
    signal?.removeEventListener('abort', canceled);
  };
  const done = () => { cleanup(); resolve(); };
  const failed = () => { cleanup(); reject(new Error('SourceBuffer operation failed')); };
  const canceled = () => { cleanup(); reject(new Error('CENC stream canceled')); };
  sourceBuffer.addEventListener('updateend', done, { once: true });
  sourceBuffer.addEventListener('error', failed, { once: true });
  sourceBuffer.addEventListener('abort', failed, { once: true });
  signal?.addEventListener('abort', canceled, { once: true });
  try {
    if (signal?.aborted) return canceled();
    action();
  } catch (error) { cleanup(); reject(error); }
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
  video, url, fileSize, onStage = () => {}, codec, hasAac, key, signal,
  startSeconds = 0, durationSeconds = null, videoCodecString = null, bridge = 'cenc'
}) {
  if ((key || bridge !== 'bvc2') && !/^[a-f0-9]{32}$/i.test(key || '')) return null;
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 24 * 3600)
    throw errorWith('CENC_UNAVAILABLE', '不合法的影片跳轉時間');
  const videoCodec = codec === 'hevc' ?
    (/^hvc1\.[A-C]?\d{1,2}\.[a-fA-F0-9]{1,8}\.[LH]\d{1,3}(?:\.[a-fA-F0-9]{2}){0,6}$/.test(
      videoCodecString || '') ? videoCodecString : null) :
    codec === 'h264' ? (bridge === 'bvc2' ? 'avc1.42C01F' : 'avc1.42E01E') : null;
  if (!videoCodec) return null;
  const toMime = videoTag => 'video/mp4; codecs="' + videoTag +
    (hasAac ? ', mp4a.40.2' : '') + '"';
  let mime = toMime(videoCodec);
  // At this point the encrypted source's hvcC is known, but the Librempeg
  // MOV muxer has not emitted its clear hvc1/hev1 sample entry yet. Permit
  // either preflight declaration, and require the *actual* init MIME at append.
  const alternateMime = codec === 'hevc' ? toMime('hev1' + videoCodec.slice(4)) : null;
  if (typeof MediaSource === 'undefined' ||
      !(MediaSource.isTypeSupported?.(mime) ||
        (alternateMime && MediaSource.isTypeSupported?.(alternateMime))) ||
      (codec !== 'hevc' && !video.canPlayType(mime)) ||
      !await (bridge === 'bvc2' ? bvc2BridgeAvailable() : cencRemuxAvailable())) return null;
  if (signal?.aborted) throw errorWith('CANCELED', '已切換影片');

  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  let objectUrlRevoked = false;
  const revokeObjectUrl = () => {
    if (objectUrlRevoked) return;
    objectUrlRevoked = true;
    URL.revokeObjectURL(objectUrl);
  };
  let worker;
  try {
    worker = bridge === 'bvc2'
      ? new Worker(new URL('./bvc2-stream-worker.js', import.meta.url), { type: 'module' })
      : new Worker(new URL('./cenc-remux-worker.js', import.meta.url), { type: 'module' });
  } catch {
    // No stream object was returned, so no caller can close this URL for us.
    revokeObjectUrl();
    throw errorWith('CENC_UNAVAILABLE', 'CENC 串流 Worker 無法建立');
  }
  const internal = new AbortController();
  let closed = false, failed = false, buffer = null, queued = Promise.resolve();
  let finished = false, initialStartChecked = false;
  let mediaFragments = 0, mediaBytes = 0;
  // Real progressive HEVC can have its first common audio/video buffered
  // range start a few hundred milliseconds after zero (e.g. 0.16s).
  // Per MSE's readyState rules, a media clock at 0 then remains stuck at
  // HAVE_METADATA even while multiple complete fragments have been appended.
  // Only adjust a fresh zero-start HEVC stream, never indexed seeks or user
  // resume positions. Defer until metadata and media ranges are available.
  const alignFirstBuffer = () => {
    if (closed || failed || initialStartChecked || codec !== 'hevc' ||
        startSeconds > 0.01 || video.readyState < 1 ||
        !video.buffered?.length) return;
    try {
      const firstStart = video.buffered.start(0);
      const firstEnd = video.buffered.end(0);
      if (firstEnd - firstStart < 0.1) return;
      // Attempt only once when real buffered media is available. A gap larger
      // than 0.5s indicates a different timeline defect, not harmless preroll.
      initialStartChecked = true;
      alignInitialCencBufferedStart(video, startSeconds);
      video.removeEventListener?.('loadedmetadata', alignFirstBuffer);
    } catch { /* video src may have been replaced during cancellation */ }
  };
  video.addEventListener?.('loadedmetadata', alignFirstBuffer);
  // Terminate directly: posting cancel first can resume an interrupted AVIO
  // sample with EIO before termination, producing spurious MOV corruption logs.
  // Termination itself stops Worker fetches and discards its pending ACK.
  // Stop Range fetch and pending ACK *before* reporting the media error.
  // SourceBuffer errors are not permitted to leave a live WASM worker behind.
  const fail = (cause, streamError = null) => {
    if (closed || failed) return;
    failed = true;
    onStage('mse.failed', {
      reason: cause || 'unknown',
      code: streamError?.code || 'CENC_REMUX_FAILED',
      status: streamError?.status || 0
    });
    console.info('[Hongguo CENC] streaming bridge failed:', cause || 'unknown');
    internal.abort();
    worker.terminate();
    video.removeEventListener?.('loadedmetadata', alignFirstBuffer);
    const endWithError = () => {
      if (closed) return;
      if (buffer?.updating) {
        buffer.addEventListener('updateend', endWithError, { once: true });
        return;
      }
      try {
        if (ms.readyState === 'open') ms.endOfStream('decode');
      } catch { /* video.onerror and retries own the failure */ }
    };
    if (ms.readyState === 'open') endWithError();
    else if (ms.readyState === 'closed')
      ms.addEventListener('sourceopen', endWithError, { once: true });
    // The caller may never reach a normal teardown after a Worker crash.
    // Revocation is idempotent with close() and never logs the media URL.
    revokeObjectUrl();
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    internal.abort();
    signal?.removeEventListener('abort', onAbort);
    video.removeEventListener?.('loadedmetadata', alignFirstBuffer);
    worker.terminate();
    revokeObjectUrl();
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    await close();
    throw errorWith('CANCELED', '已切換影片');
  }
  const trimOldMedia = async (behind = 30, minimum = 8) => {
    const end = evictionEnd(buffer?.buffered, video.currentTime, behind, minimum);
    if (end !== null) await waitBufferUpdate(buffer,
      () => buffer.remove(0, end), internal.signal);
    return end !== null;
  };
  const append = async bytes => {
    // Normal playback retains only the recent rewind window. If MSE reaches
    // quota first, attempt a stronger eviction and retry the same unit once.
    await trimOldMedia();
    try {
      await waitBufferUpdate(buffer, () => buffer.appendBuffer(bytes), internal.signal);
    } catch (error) {
      if (error?.name !== 'QuotaExceededError' || !await trimOldMedia(10, 1))
        throw error;
      await waitBufferUpdate(buffer, () => buffer.appendBuffer(bytes), internal.signal);
    }
  };
  worker.onerror = event => {
    event.preventDefault();
    fail('worker-error');
  };
  worker.onmessage = ({ data }) => {
    if (closed || failed || !data) return;
    if (data.type === 'stage') {
      if (['wasm-download', 'wasm-verify', 'wasm-start', 'first-fragment',
        'media-range', 'media-range-failed', 'media-range-retry'].includes(data.stage))
        onStage(data.stage, data.stage === 'media-range' ? {
          requests: data.requests, receivedBytes: data.receivedBytes,
          fetchMs: data.fetchMs
        } : data.stage === 'media-range-failed' ? {
          request: data.request, code: data.code, status: data.status,
          offset: data.offset, bytes: data.bytes, fetchMs: data.fetchMs
        } : data.stage === 'media-range-retry' ? {
          status: data.status, attempt: data.attempt,
          delayMs: data.delayMs, remaining: data.remaining
        } : {});
      return;
    }
    if (data.type === 'error') return fail('wasm-remux', {
      code: data.code, status: data.status
    });
    if (data.type === 'done') {
      finished = true;
      onStage('mse.done', { fragments: mediaFragments, bytes: mediaBytes });
      void queued.then(() => {
        if (!closed && !failed && ms.readyState === 'open' && !buffer?.updating)
          ms.endOfStream();
      }).catch(() => fail('finish'));
      return;
    }
    if (data.type !== 'init' && data.type !== 'media') return;
    queued = queued.then(async () => {
      await waitSourceOpen(ms, internal.signal);
      if (closed || failed) return;
      if (data.type === 'init') {
        if (buffer) throw new Error('Duplicate MSE init');
        if (codec === 'hevc') {
          const actualCodec = assertHevcInitCodecMatches(
            new Uint8Array(data.bytes), videoCodec);
          mime = toMime(actualCodec);
          if (!MediaSource.isTypeSupported?.(mime))
            throw Object.assign(new Error('HEVC output MIME unsupported'),
              { code: 'HEVC_INIT_UNSUPPORTED' });
        }
        buffer = ms.addSourceBuffer(mime);
        // An empty-moov mux cannot signal the complete episode duration.
        // Set the original MP4 mvhd timeline to make distant seeks possible
        // before those media segments have been downloaded.
        if (Number.isFinite(durationSeconds) && durationSeconds > 0)
          ms.duration = durationSeconds;
      }
      if (!buffer) throw new Error('Missing MSE initialization');
      await append(new Uint8Array(data.bytes));
      if (data.type === 'media') {
        mediaFragments++;
        mediaBytes += data.bytes.byteLength;
        if (mediaFragments <= 3 || mediaFragments % 12 === 0) {
          let bufferEnd = 0;
          try {
            if (buffer.buffered.length)
              bufferEnd = buffer.buffered.end(buffer.buffered.length - 1);
          } catch { /* buffer changed during teardown */ }
          onStage('mse.media-appended', {
            fragments: mediaFragments, bytes: mediaBytes,
            time: video.currentTime, bufferEnd
          });
        }
        alignFirstBuffer();
      } else {
        onStage('mse.init-appended', { bytes: data.bytes.byteLength });
      }
      await waitBufferHeadroom(video, buffer, internal.signal);
      if (!closed && !failed) worker.postMessage({ type: 'ack', id: data.id });
    }).catch(error => fail(error?.code === 'HEVC_INIT_MISMATCH'
      ? 'hevc-init-mismatch' : error?.code === 'HEVC_INIT_UNSUPPORTED'
        ? 'hevc-init-unsupported' : 'source-buffer'));
  };
  try {
    worker.postMessage({ type: 'start', url, fileSize, key, startSeconds });
  } catch {
    // A synchronous structured-clone/terminated-worker failure must not
    // strand the object URL or worker before the stream reaches its caller.
    await close();
    throw errorWith('CENC_UNAVAILABLE', 'CENC 串流 Worker 無法啟動');
  }
  const seekTo = async seconds => {
    if (closed || signal?.aborted) throw errorWith('CANCELED', '已切換影片');
    await close();
    const replacement = await openCencProgressiveStream({
      video, url, fileSize, codec, hasAac, key, signal, onStage,
      startSeconds: seconds, durationSeconds, videoCodecString, bridge
    });
    if (!replacement) throw errorWith('CENC_UNAVAILABLE', '無法建立跳轉串流');
    return replacement;
  };
  return { url: objectUrl, kind: bridge === 'bvc2' ? 'bvc2-transcode' : 'cenc-remux',
    close, seekTo, get mime() { return mime; },
    durationSeconds, finished: () => finished };
}
