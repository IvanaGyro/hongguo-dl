// SPDX-License-Identifier: GPL-3.0-only
// Dedicated Worker: bounded HTTP Range reads -> Librempeg Asyncify AVIO ->
// complete clear fMP4 init/media units. Main thread ACK provides backpressure.
import { createFmp4Assembler } from './fmp4-assembler.js';
import { readVerifiedRange } from './http-range.js';
import { verifyCencRuntimeBundle, readLimitedAsset } from './cenc-bundle.js';

const WINDOW = 256 * 1024;
const MAX_FILE = 260 * 1024 * 1024;
let started = false, controller = null, pendingAck = null, seq = 0;

const sendUnit = (type, data) => new Promise((resolve, reject) => {
  if (controller.signal.aborted) return reject(new Error('Canceled'));
  if (pendingAck) return reject(new Error('Transport already awaiting ACK'));
  const id = ++seq;
  pendingAck = { id, resolve, reject };
  self.postMessage({ type, id, bytes: data.buffer }, [data.buffer]);
});

async function run({ url, key, fileSize, startSeconds = 0 }) {
  if (started) throw new Error('Streaming worker already started');
  started = true;
  if (!Number.isSafeInteger(fileSize) || fileSize < 8 || fileSize > MAX_FILE)
    throw new Error('Invalid source byte count');
  if (!/^[a-f0-9]{32}$/i.test(key || '')) throw new Error('Invalid CENC key');
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 24 * 3600)
    throw new Error('Invalid CENC seek time');
  const mediaUrl = new URL(url, self.location.origin);
  if (!['http:', 'https:'].includes(mediaUrl.protocol) ||
      !mediaUrl.pathname.endsWith('/api/media'))
    throw new Error('Invalid media proxy endpoint');
  controller = new AbortController();
  let cacheStart = -1, cacheBytes = new Uint8Array(0);
  const readRange = async (start, wanted) => {
    if (controller.signal.aborted) throw new Error('Canceled');
    if (!Number.isInteger(start) || start < 0 || start >= fileSize ||
        !Number.isInteger(wanted) || wanted < 1 || wanted > 1024 * 1024)
      throw new Error('Invalid AVIO read request');
    if (start >= cacheStart && start + wanted <= cacheStart + cacheBytes.length)
      return cacheBytes.subarray(start - cacheStart, start - cacheStart + wanted);
    const end = Math.min(fileSize, start + Math.max(wanted, WINDOW)) - 1;
    // No response.arrayBuffer(): a misbehaving CDN must not allocate beyond
    // the requested 256 KiB window even if it lies about Content-Length.
    const bytes = await readVerifiedRange(fetch, mediaUrl.href, start, end,
      fileSize, controller.signal);
    cacheStart = start;
    cacheBytes = bytes;
    return bytes.subarray(0, wanted);
  };
  const assembler = createFmp4Assembler({
    onInit: data => sendUnit('init', data),
    onMedia: data => sendUnit('media', data)
  });
  const base = new URL(import.meta.env.BASE_URL + 'cenc/', self.location.href);
  const moduleUrl = new URL('cenc-core.mjs', base);
  const wasmUrl = new URL('cenc-core.wasm', base);
  const manifestUrl = new URL('manifest.json', base);
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
  await verifyCencRuntimeBundle(manifest, moduleBytes, wasmBytes);
  if (controller.signal.aborted) throw new Error('Canceled');
  const { default: createModule } = await import(/* @vite-ignore */ moduleUrl.href);
  const core = await createModule({
    wasmBinary: wasmBytes, readRange, writeChunk: data => assembler.push(data)
  });
  if (core._cenc_remux_available() !== 1)
    throw new Error('WASM missing MOV demuxer or MP4 muxer');
  if (startSeconds > 0.5 && typeof core._cenc_stream_remux_at !== 'function')
    throw new Error('CENC remux WASM seek API unavailable');
  const ret = startSeconds > 0.5
    ? await core.ccall('cenc_stream_remux_at', 'number',
      ['number', 'string', 'number'], [fileSize, key, startSeconds], { async: true })
    : await core.ccall('cenc_stream_remux', 'number',
      ['number', 'string'], [fileSize, key], { async: true });
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
    // No signed media URL or CENC key in this error.
    self.postMessage({ type: 'error', detail: String(error?.message || 'Remux failed').slice(0, 160) });
  });
};
