// SPDX-License-Identifier: GPL-3.0-only
// Playback layer: MSE presentation of the media Worker's clear fMP4 output.
// The Worker (download + processing layers) owns HTTP, metadata and WASM.
import { createMediaProcessor } from './media-processor.js';
import { bvc2BridgeAvailable } from './bvc2.js';
import { errorWith } from './logic.js';
import { evictionEnd } from './mse-eviction.js';
import { retryableAvailability } from './retryable-availability.js';
import { assertHevcInitCodecMatches } from './cenc-init-codec.js';
import { alignInitialCencBufferedStart } from './mse-start-gap.js';
import { streamBufferPolicy, bufferedIntervals, bufferedAround } from './stream-buffer-policy.js';

import { MAX_REMUX_FILE_BYTES } from './media-route.js';

const MAX_CORE = 24 * 1024 * 1024;
// The Worker's route decision enforces this; metadata and native EME do not.
export const MAX_CENC_REMUX_FILE_BYTES = MAX_REMUX_FILE_BYTES;
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
// Bound remuxed lookahead independently of raw-byte download prefetch.
// Only the contiguous range at the playhead counts as available headroom.
function waitBufferHeadroom(video, sourceBuffer, signal, policy) {
  if (bufferedAround(sourceBuffer.buffered, video.currentTime).bufferedAhead < policy.ahead)
    return Promise.resolve();
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
        if (bufferedAround(sourceBuffer.buffered, video.currentTime).bufferedAhead < policy.refill) finish();
      } catch { finish(); }
    };
    for (const event of ['timeupdate', 'seeked', 'playing'])
      video.addEventListener(event, check);
    signal?.addEventListener('abort', finish, { once: true });
    check();
  });
}

const SOURCE_MESSAGES = {
  CENC_RANGE_UNSUPPORTED: '來源不支援有限的 HTTP Range（HTTP 200）',
  CENC_SOURCE_FORBIDDEN: 'CDN 拒絕存取影片（HTTP 403）',
  CENC_RANGE_INVALID: '來源回傳不符合要求的影片範圍',
  CENC_RATE_LIMITED: '來源限制請求頻率（HTTP 429）',
  CENC_RANGE_TIMEOUT: 'HTTP Range 讀取逾時',
  CENC_RANGE_HTTP: '來源 HTTP Range 請求失敗',
  CENC_SOURCE_SLOW: '來源下載速度不足以播放',
  CENC_METADATA_LIMIT: 'MP4 索引超過 8 MiB 有界串流安全限制，不能改用整檔下載',
  BVC2_ERROR: 'ByteVC2 串流需要可讀取索引的 MP4 來源'
};
// Worker events carry only fixed codes and numeric statuses, never URLs/keys.
function workerError(fields) {
  const code = typeof fields?.code === 'string' && /^[A-Z0-9_]{2,48}$/.test(fields.code)
    ? fields.code : 'CENC_UNAVAILABLE';
  const status = Number.isInteger(fields?.status) ? fields.status : 0;
  return Object.assign(errorWith(code, SOURCE_MESSAGES[code] ||
    (status ? '媒體來源讀取失敗（HTTP ' + status + '）' : '媒體來源讀取失敗')),
  { status, ...(Number.isFinite(fields?.retryAfterMs) ? { retryAfterMs: fields.retryAfterMs } : {}) });
}

/**
 * Declare a playable-media demand to the media Worker and present its clear
 * fMP4 output through MSE. The Worker opens the source, inspects metadata
 * and chooses the route; this function never probes or downloads by itself.
 * Resolves to null when the Worker reports no MSE route; `onMetadata`
 * receives the Worker's metadata and route for a browser-native fallback.
 * @returns {Promise<{url:string,kind:string,close:()=>Promise<void>}|null>}
 */
export async function openCencProgressiveStream({
  video, input, onStage = () => {}, codec, key, signal, startSeconds = 0,
  durationSeconds: durationHint = null, bridge = 'cenc', preload = false,
  remainingMediaAttempts = 20, onMetadata = () => {}, fetchImpl
}) {
  if (remainingMediaAttempts <= 0) throw Object.assign(errorWith('PLAYBACK_STEP_LIMIT', '影片資料下載已達 20 次嘗試上限'),
    { retryStep: 'media-download', stepAttempt: 20 });
  if ((key || bridge !== 'bvc2') && !/^[a-f0-9]{32}$/i.test(key || '')) return null;
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 24 * 3600)
    throw errorWith('CENC_UNAVAILABLE', '不合法的影片跳轉時間');
  if (!input?.url) return null;
  if (signal?.aborted) throw errorWith('CANCELED', '已切換影片');
  // Capability report: whether this browser can host the WASM/MSE route.
  const processing = typeof MediaSource !== 'undefined' &&
    await (bridge === 'bvc2' ? bvc2BridgeAvailable() : cencRemuxAvailable());
  if (signal?.aborted) throw errorWith('CANCELED', '已切換影片');
  const outputCodec = bridge === 'bvc2' ? 'h264' : codec;
  // Step budgets are enforced synchronously before any source is declared,
  // so an exhausted budget never reaches the network.
  onStage('metadata');
  let processor;
  try {
    processor = createMediaProcessor({ bridge, preload, onStage, fetchImpl,
      // HEVC: a precise MSE codec string must not be vetoed by canPlayType('hvc1').
      supportsType: mime => typeof MediaSource !== 'undefined' &&
        Boolean(MediaSource.isTypeSupported?.(mime)) &&
        (outputCodec === 'hevc' || Boolean(video.canPlayType?.(mime))) });
  } catch {
    throw errorWith('CENC_UNAVAILABLE', 'CENC 串流 Worker 無法建立');
  }
  let metadata = null, routeWaiter;
  const routed = new Promise((resolve, reject) => { routeWaiter = { resolve, reject }; });
  processor.onmetadata = value => { metadata = value; };
  let routeDecided = false;
  processor.onroute = value => { routeDecided = true; routeWaiter.resolve(value); };
  // A refused step budget during source opening stops this startup, exactly
  // as when the metadata probe still ran on the main thread.
  processor.onstageerror = error => {
    if (routeDecided) throw error;
    routeWaiter.reject(error);
  };
  processor.onerror = fields => routeWaiter.reject(fields?.workerError
    ? errorWith('CENC_UNAVAILABLE', 'CENC 串流 Worker 無法執行') : workerError(fields));
  const abortEarly = () => routeWaiter.reject(errorWith('CANCELED', '已切換影片'));
  signal?.addEventListener('abort', abortEarly, { once: true });
  try {
    processor.reportCapabilities({ processing: { [bridge]: Boolean(processing) } });
    processor.need({
      source: { url: input.url, proxyUrl: input.proxyUrl || null, bridge, key: key || '' },
      output: 'playable-media', codec: outputCodec, positionSeconds: startSeconds,
      durationHint: Number.isFinite(durationHint) && durationHint > 0 && durationHint <= 24 * 3600 ? durationHint : null,
      playback: { paused: true, bufferedAheadSeconds: 0, bufferTargetSeconds: 0 },
      priority: preload ? 'speculative' : 'active', processing: !preload
    });
  } catch {
    // A synchronous structured-clone/terminated-worker failure must not
    // strand the Worker before the stream reaches its caller.
    signal?.removeEventListener('abort', abortEarly);
    processor.close({ discard: true });
    throw errorWith('CENC_UNAVAILABLE', 'CENC 串流 Worker 無法啟動');
  }
  let route;
  try { route = await routed; }
  catch (error) { processor.close({ discard: true }); throw error; }
  finally { signal?.removeEventListener('abort', abortEarly); }
  onMetadata(metadata, route);
  if (route.kind !== 'mse') {
    processor.close();
    return null;
  }
  if (signal?.aborted) { processor.close({ discard: true }); throw errorWith('CANCELED', '已切換影片'); }
  const { fileSize, hasAac, videoCodec, durationSeconds } = route;
  startSeconds = route.startSeconds;
  const toMime = videoTag => 'video/mp4; codecs="' + videoTag +
    (hasAac ? ', mp4a.40.2' : '') + '"';
  let mime = route.mime;
  const policy = streamBufferPolicy({ fileSize, durationSeconds,
    saveData: Boolean(navigator.connection?.saveData), deviceMemory: navigator.deviceMemory });
  onStage('buffer.policy', policy);
  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  let objectUrlRevoked = false;
  const revokeObjectUrl = () => {
    if (objectUrlRevoked) return;
    objectUrlRevoked = true;
    URL.revokeObjectURL(objectUrl);
  };
  const internal = new AbortController();
  let closed = false, failed = false, buffer = null, queued = Promise.resolve();
  let finished = false, initialStartChecked = false;
  let generation = processor.generation, outputController = new AbortController(), seekPending = null;
  let streamHandle;
  // Playback state is demand state: pausing keeps the demand, and the
  // Worker reads ahead until the reported buffer target is satisfied.
  const setPrefetch = () => {
    if (closed || failed) return;
    let ahead = 0;
    try { ahead = bufferedAround(video.buffered, video.currentTime).bufferedAhead; } catch { ahead = 0; }
    const playback = { paused: video.paused !== false,
      bufferedAheadSeconds: Math.min(24 * 3600, Math.max(0, Math.round(ahead))),
      bufferTargetSeconds: Math.round(policy.refill) };
    const previous = processor.demand?.playback;
    if (previous && previous.paused === playback.paused &&
        previous.bufferedAheadSeconds === playback.bufferedAheadSeconds &&
        previous.bufferTargetSeconds === playback.bufferTargetSeconds) return;
    processor.need({ playback });
  };
  for (const event of ['playing', 'pause', 'ended']) video.addEventListener?.(event, setPrefetch);
  let mediaFragments = 0, mediaBytes = 0;
  // Real progressive HEVC can have its first common audio/video buffered
  // range start a few hundred milliseconds after zero (e.g. 0.16s).
  // Per MSE's readyState rules, a media clock at 0 then remains stuck at
  // HAVE_METADATA even while multiple complete fragments have been appended.
  // Only adjust a fresh zero-start HEVC stream, never indexed seeks or user
  // resume positions. Defer until metadata and media ranges are available.
  const alignFirstBuffer = () => {
    if (processor.preloading || closed || failed || initialStartChecked || outputCodec !== 'hevc' ||
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
    seekPending?.reject(errorWith(streamError?.code || 'CENC_REMUX_FAILED', '串流跳轉失敗')); seekPending = null;
    outputController.abort();
    for (const event of ['playing', 'pause', 'ended']) video.removeEventListener?.(event, setPrefetch);
    onStage('mse.failed', {
      reason: cause || 'unknown',
      code: streamError?.code || 'CENC_REMUX_FAILED',
      status: streamError?.status || 0
    });
    console.info('[Hongguo CENC] streaming bridge failed:', cause || 'unknown');
    internal.abort();
    processor.close({ discard: true });
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
    internal.abort(); outputController.abort();
    seekPending?.reject(errorWith('CANCELED', '已切換影片')); seekPending = null;
    for (const event of ['playing', 'pause', 'ended']) video.removeEventListener?.(event, setPrefetch);
    signal?.removeEventListener('abort', onAbort);
    video.removeEventListener?.('loadedmetadata', alignFirstBuffer);
    processor.close();
    revokeObjectUrl();
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    await close();
    throw errorWith('CANCELED', '已切換影片');
  }
  const trimOldMedia = async (behind = policy.behind, minimum = 8) => {
    if (buffer?.buffered.length) {
      const farEnd = buffer.buffered.end(buffer.buffered.length - 1);
      const keepUntil = video.currentTime + policy.ahead + 30;
      if (farEnd > keepUntil + 8) await waitBufferUpdate(buffer,
        () => buffer.remove(keepUntil, farEnd), internal.signal);
    }
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
  processor.onerror = fields => fields?.workerError ? fail('worker-error')
    : fail('wasm-remux', { code: fields?.code, status: fields?.status });
  processor.consume(data => {
    if (closed || failed || !data) return;
    if (data.generation !== undefined && data.generation !== generation) return;
    if (data.type === 'done') {
      finished = true;
      onStage('mse.done', { fragments: mediaFragments, bytes: mediaBytes });
      void queued.then(() => {
        if (!closed && !failed && data.generation === generation && ms.readyState === 'open' && !buffer?.updating)
          ms.endOfStream();
      }).catch(() => fail('finish'));
      return;
    }
    if (data.type !== 'init' && data.type !== 'media') return;
    const unitGeneration = generation, outputSignal = outputController.signal;
    queued = queued.then(async () => {
      if (unitGeneration !== generation) return;
      if (ms.readyState === 'ended' && buffer) buffer.timestampOffset = 0;
      await waitSourceOpen(ms, internal.signal);
      if (closed || failed) return;
      if (data.type === 'init') {
        // Each generation emits a fresh init for the same track configuration.
        if (outputCodec === 'hevc') {
          const actualCodec = assertHevcInitCodecMatches(
            new Uint8Array(data.bytes), videoCodec);
          mime = toMime(actualCodec);
          const supported = Boolean(MediaSource.isTypeSupported?.(mime));
          onStage('mse.output-codec', { codecString: actualCodec, hasAac, supported });
          if (!supported)
            throw Object.assign(new Error('HEVC output MIME unsupported'),
              { code: 'HEVC_INIT_UNSUPPORTED' });
        }
        if (!buffer) buffer = ms.addSourceBuffer(mime);
        // An empty-moov mux cannot signal the complete episode duration.
        // Set the original MP4 mvhd timeline to make distant seeks possible
        // before those media segments have been downloaded.
        if (Number.isFinite(durationSeconds) && durationSeconds > 0)
          ms.duration = durationSeconds;
      }
      if (!buffer) throw new Error('Missing MSE initialization');
      if (unitGeneration !== generation) return;
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
        if (video.paused) setPrefetch();
        if (seekPending && bufferedIntervals(video.buffered).some(([a, b]) =>
            a <= seekPending.target + 0.15 && b > seekPending.target + 0.1)) {
          const pending = seekPending; seekPending = null;
          onStage('seek.buffer-ready', { target: pending.target, generation,
            bufferedRanges: bufferedIntervals(video.buffered), ...bufferedAround(video.buffered, pending.target) });
          pending.resolve(streamHandle);
        }
      } else {
        onStage('mse.init-appended', { bytes: data.bytes.byteLength });
      }
      await waitBufferHeadroom(video, buffer, outputSignal, policy);
      if (!closed && !failed && unitGeneration === generation)
        processor.post({ type: 'ack', id: data.id });
    }).catch(error => {
      if (unitGeneration !== generation || closed) return;
      fail(error?.code === 'HEVC_INIT_MISMATCH'
      ? 'hevc-init-mismatch' : error?.code === 'HEVC_INIT_UNSUPPORTED'
        ? 'hevc-init-unsupported' : 'source-buffer');
    });
  });
  // A seek is a demand update: the same Worker, engine and byte cache serve
  // the new position, and output for the previous position is discarded.
  const seekTo = async seconds => {
    if (closed || failed || signal?.aborted) throw errorWith('CANCELED', '已切換影片');
    if (seekPending) seekPending.reject(errorWith('CANCELED', '已更新跳轉位置'));
    const ready = new Promise((resolve, reject) => { seekPending = { target: seconds, resolve, reject }; });
    finished = false;
    outputController.abort(); outputController = new AbortController();
    generation = processor.need({ positionSeconds: seconds });
    onStage('seek.request', { target: seconds, generation, workerReused: true,
      bufferedRanges: bufferedIntervals(video.buffered) });
    return ready;
  };
  streamHandle = { url: objectUrl, inPlaceSeek: true, kind: bridge === 'bvc2' ? 'bvc2-transcode' : 'cenc-remux',
    close, seekTo, startProcessing: () => processor.startProcessing(),
    pauseProcessing: () => processor.pauseProcessing(),
    activate: () => {
      if (failed || closed) throw errorWith('CENC_REMUX_FAILED', '預載串流已失效');
      processor.activate();
      setPrefetch();
    }, get mime() { return mime; },
    durationSeconds, startSeconds, snapshot: () => processor.snapshot(), finished: () => finished || processor.finished() };
  return streamHandle;
}
