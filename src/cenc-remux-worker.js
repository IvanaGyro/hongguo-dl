// SPDX-License-Identifier: GPL-3.0-only
// Dedicated Worker: persistent HTTP response reads -> Librempeg Asyncify AVIO ->
// complete clear fMP4 init/media units. Main thread ACK provides backpressure.
import { createFmp4Assembler } from './fmp4-assembler.js';
import { createHttpStreamReader } from './http-stream.js';
import { createMediaTransport, isAcceptedMediaTransportUrl } from './media-transport.js';
import { createCencRangeRecovery } from './cenc-range-recovery.js';
import { verifyCencRuntimeBundle, readLimitedAsset } from './cenc-bundle.js';

const MAX_FILE = 260 * 1024 * 1024;
let started = false, controller = null, pendingAck = null, seq = 0;
let lastRangeError = null;

const sendUnit = (type, data) => new Promise((resolve, reject) => {
  if (controller.signal.aborted) return reject(new Error('Canceled'));
  if (pendingAck) return reject(new Error('Transport already awaiting ACK'));
  const id = ++seq;
  pendingAck = { id, resolve, reject };
  self.postMessage({ type, id, bytes: data.buffer }, [data.buffer]);
});

async function run({ url, proxyUrl = null, key, fileSize, startSeconds = 0, retrySameSource = false }) {
  if (started) throw new Error('Streaming worker already started');
  started = true;
  if (!Number.isSafeInteger(fileSize) || fileSize < 8 || fileSize > MAX_FILE)
    throw new Error('Invalid source byte count');
  if (!/^[a-f0-9]{32}$/i.test(key || '')) throw new Error('Invalid CENC key');
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 24 * 3600)
    throw new Error('Invalid CENC seek time');
  const mediaUrl = new URL(url, self.location.origin);
  if (!isAcceptedMediaTransportUrl(mediaUrl.href, self.location.origin) ||
      (proxyUrl && !isAcceptedMediaTransportUrl(proxyUrl, self.location.origin)))
    throw new Error('Invalid media transport endpoint');
  const transport = createMediaTransport({
    directUrl: mediaUrl.href, proxyUrl: proxyUrl || mediaUrl.href,
    onFallback: (reason, fields) => self.postMessage({
      type: 'stage', stage: 'media.transport.fallback', reason, ...fields
    })
  });
  controller = new AbortController();
  let rangeRequests = 0, receivedBytes = 0;
  lastRangeError = null;
  const rangeRecovery = createCencRangeRecovery({
    retryInitial: retrySameSource,
    onRetry: event => self.postMessage({
      type: 'stage', stage: 'media-range-retry', code: event.code, status: event.status,
      attempt: event.attempt, delayMs: event.delayMs, remaining: event.remaining
    })
  });
  const stream = createHttpStreamReader({ fetchImpl: transport.fetch,
    url: mediaUrl.href, fileSize, signal: controller.signal, recovery: rangeRecovery,
    onResponse: fields => self.postMessage({ type: 'stage', stage: 'media-range', ...fields })
  });
  const readRange = async (start, wanted) => {
    const fetchStarted = performance.now();
    try {
      const bytes = await stream.read(start, wanted);
      rangeRequests++;
      receivedBytes = stream.stats.receivedBytes;
      if (rangeRequests <= 4 || rangeRequests % 12 === 0)
        self.postMessage({ type: 'stage', stage: 'media-range',
          requests: stream.stats.requests, receivedBytes,
          fetchMs: Math.round(performance.now() - fetchStarted) });
      return bytes;
    } catch (error) {
      lastRangeError = {
        code: /^CENC_[A-Z_]{2,45}$/.test(error?.code || '') ? error.code : 'CENC_RANGE_HTTP',
        status: Number.isInteger(error?.status) ? error.status : 0
      };
      self.postMessage({ type: 'stage', stage: 'media-range-failed',
        request: stream.stats.requests, offset: start, bytes: wanted,
        ...lastRangeError, fetchMs: Math.round(performance.now() - fetchStarted) });
      throw error;
    }
  };
  const assembler = createFmp4Assembler({
    onInit: data => sendUnit('init', data),
    onMedia: data => sendUnit('media', data)
  });
  const base = new URL(import.meta.env.BASE_URL + 'cenc/', self.location.href);
  const moduleUrl = new URL('cenc-core.mjs', base);
  const wasmUrl = new URL('cenc-core.wasm', base);
  const manifestUrl = new URL('manifest.json', base);
  self.postMessage({ type: 'stage', stage: 'wasm-download' });
  const manifestResponse = await fetch(manifestUrl, {
    signal: controller.signal, cache: 'no-store'
  });
  if (!manifestResponse.ok) throw new Error('CENC release manifest unavailable');
  const manifestBytes = await readLimitedAsset(manifestResponse, 4096);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest?.schema !== 1 ||
      !/^[a-f0-9]{64}$/.test(manifest?.files?.['cenc-core.mjs']) ||
      !/^[a-f0-9]{64}$/.test(manifest?.files?.['cenc-core.wasm']))
    throw new Error('Invalid CENC release manifest');
  // Content-address URLs prevent old HTTP cache entries from being reused
  // across Pages deployments. Verify downloaded bytes before running code.
  moduleUrl.searchParams.set('v', manifest.files['cenc-core.mjs']);
  wasmUrl.searchParams.set('v', manifest.files['cenc-core.wasm']);
  const [moduleResponse, wasmResponse] = await Promise.all([
    fetch(moduleUrl, { signal: controller.signal, cache: 'force-cache' }),
    fetch(wasmUrl, { signal: controller.signal, cache: 'force-cache' })
  ]);
  const [moduleBytes, wasmBytes] = await Promise.all([
    readLimitedAsset(moduleResponse, 1024 * 1024),
    readLimitedAsset(wasmResponse, 24 * 1024 * 1024)
  ]);
  self.postMessage({ type: 'stage', stage: 'wasm-verify' });
  await verifyCencRuntimeBundle(manifest, moduleBytes, wasmBytes);
  if (controller.signal.aborted) throw new Error('Canceled');
  const { default: createModule } = await import(/* @vite-ignore */ moduleUrl.href);
  self.postMessage({ type: 'stage', stage: 'wasm-start' });
  const core = await createModule({
    wasmBinary: wasmBytes, readRange, writeChunk: data => assembler.push(data)
  });
  if (core._cenc_remux_available() !== 1)
    throw new Error('WASM missing MOV demuxer or MP4 muxer');
  if (startSeconds > 0.5 && typeof core._cenc_stream_remux_at !== 'function')
    throw new Error('CENC remux WASM seek API unavailable');
  self.postMessage({ type: 'stage', stage: 'first-fragment' });
  const ret = startSeconds > 0.5
    ? await core.ccall('cenc_stream_remux_at', 'number',
      ['number', 'string', 'number'], [fileSize, key, startSeconds], { async: true })
    : await core.ccall('cenc_stream_remux', 'number',
      ['number', 'string'], [fileSize, key], { async: true });
  stream.close();
  if (ret !== 0) {
    // Only expose the fixed stage name from C; no original URL/key.
    throw new Error(core.UTF8ToString(core._cenc_remux_error()) || 'Remux failed');
  }
  assembler.finish();
  self.postMessage({ type: 'done' });
}

self.onmessage = ({ data }) => {
  if (data?.type === 'ack' && pendingAck?.id === data.id) {
    const pending = pendingAck;
    pendingAck = null;
    pending.resolve();
    return;
  }
  if (data?.type === 'cancel') {
    controller?.abort();
    pendingAck?.reject(new Error('Canceled'));
    pendingAck = null;
    return;
  }
  if (data?.type !== 'start') return;
  void run(data).catch(error => {
    if (controller?.signal.aborted) return;
    // The Worker receives a proxied, signed URL and a CENC key. A native
    // fetch/decoder error can include either; never relay arbitrary messages.
    // The main thread handles all failures through the same resource cleanup.
    self.postMessage({ type: 'error',
      code: lastRangeError?.code || 'CENC_REMUX_FAILED',
      status: lastRangeError?.status || 0 });
  });
};
