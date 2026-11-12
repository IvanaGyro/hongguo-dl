// SPDX-License-Identifier: GPL-3.0-only
// Dedicated Worker: bounded HTTP Range reads -> Librempeg Asyncify AVIO ->
// complete clear fMP4 init/media units. Main thread ACK provides backpressure.
import { createFmp4Assembler } from './fmp4-assembler.js';

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

async function run({ url, key, fileSize }) {
  if (started) throw new Error('Streaming worker already started');
  started = true;
  if (!Number.isSafeInteger(fileSize) || fileSize < 8 || fileSize > MAX_FILE)
    throw new Error('Invalid source byte count');
  if (!/^[a-f0-9]{32}$/i.test(key || '')) throw new Error('Invalid CENC key');
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
    const response = await fetch(mediaUrl.href, {
      headers: { Range: 'bytes=' + start + '-' + end },
      signal: controller.signal, cache: 'no-store'
    });
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      throw new Error('HTTP Range unavailable (status ' + response.status + ')');
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== start || Number(range[2]) !== end ||
        Number(range[3]) !== fileSize)
      throw new Error('Invalid Content-Range');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - start + 1)
      throw new Error('Truncated HTTP Range response');
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
  const [{ default: createModule }, response] = await Promise.all([
    import(/* @vite-ignore */ moduleUrl.href),
    fetch(wasmUrl, { signal: controller.signal, cache: 'force-cache' })
  ]);
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 24 * 1024 * 1024)
    throw new Error('CENC remux WASM core unavailable');
  const core = await createModule({
    wasmBinary: new Uint8Array(await response.arrayBuffer()),
    readRange, writeChunk: data => assembler.push(data)
  });
  if (core._cenc_remux_available() !== 1)
    throw new Error('WASM missing MOV demuxer or MP4 muxer');
  const ret = await core.ccall('cenc_stream_remux', 'number',
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
