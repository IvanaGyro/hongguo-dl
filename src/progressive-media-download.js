// SPDX-License-Identifier: GPL-3.0-only
// Layer 1: one CDN response survives metadata probing and is handed to WASM.
import { retryAfterMs } from './retry-after.js';

const HEADER_SIZE = 64 * 1024;
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_MEDIA_FILE = 260 * 1024 * 1024;
const fail = (code, status = 0) => Object.assign(new Error(code), { code, status });
const stopped = signal => { if (signal?.aborted) throw fail('CANCELED'); };

export async function openProgressiveMediaDownload({ url, fetchImpl = fetch, signal, onStage = () => {} }) {
  stopped(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let reader = null, closed = false, handedOff = false, position = 0;
  let pending = null, prefix = new Uint8Array(0), streamEnd = 0, fileSize = 0;
  const close = () => {
    if (closed) return;
    closed = true; controller.abort();
    if (!handedOff) void reader?.cancel().catch(() => {});
    signal?.removeEventListener('abort', abort);
  };
  const ensureOpen = () => { stopped(signal); if (closed) throw fail('CANCELED'); };
  const request = async (start, end = null) => {
    ensureOpen();
    let res;
    try {
      res = await fetchImpl(url, { headers: { Range: 'bytes=' + start + '-' + (end ?? '') },
        signal: controller.signal, cache: 'no-store' });
    } catch {
      if (controller.signal.aborted) throw fail('CANCELED');
      throw fail('CENC_RANGE_HTTP');
    }
    const status = res.status;
    if (status !== 206) {
      await res.body?.cancel().catch(() => {});
      throw Object.assign(fail(status === 200 ? 'CENC_RANGE_UNSUPPORTED' :
        status === 403 ? 'CENC_SOURCE_FORBIDDEN' :
        status === 429 ? 'CENC_RATE_LIMITED' :
        status === 416 ? 'CENC_RANGE_INVALID' : 'CENC_RANGE_HTTP', status),
        { retryAfterMs: retryAfterMs(res.headers?.get?.('retry-after')) });
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
    const total = status === 200 ? Number(res.headers.get('content-length')) : Number(match?.[3]);
    const last = status === 200 ? total - 1 : Number(match?.[2]);
    const startReturned = status === 200 ? 0 : Number(match?.[1]);
    const len = Number(res.headers.get('content-length'));
    if (!res.body || !Number.isSafeInteger(total) || total < 8 || total > MAX_MEDIA_FILE ||
        startReturned !== start || !Number.isSafeInteger(last) || last < start || last >= total ||
        (end !== null && last > end) || (res.headers.has('content-length') &&
          (!Number.isSafeInteger(len) || len !== last - start + 1)) ||
        (fileSize && fileSize !== total)) {
      await res.body?.cancel().catch(() => {});
      throw fail('CENC_RANGE_INVALID');
    }
    fileSize = total;
    return { response: res, end: last + 1 };
  };
  try {
    // Begin at zero, but consume only the bytes requested by the parser.
    const opened = await request(0);
    streamEnd = opened.end;
    reader = opened.response.body.getReader();
  } catch (error) { close(); throw error; }

  // A contiguous metadata prefix remains bounded to 8 MiB + a header.
  // Seeking across a large mdat uses a separate bounded request.
  const readPrefixTo = async end => {
    while (position < end) {
      ensureOpen();
      if (position >= streamEnd) {
        await reader.cancel().catch(() => {});
        const opened = await request(position);
        streamEnd = opened.end;
        reader = opened.response.body.getReader();
      }
      let next;
      try { next = pending ? { value: pending, done: false } : await reader.read(); }
      catch { ensureOpen(); throw fail('CENC_RANGE_HTTP'); }
      pending = null;
      if (next.done || !(next.value instanceof Uint8Array) || !next.value.length)
        throw fail('CENC_RANGE_INVALID');
      const chunk = next.value;
      const used = Math.min(chunk.length, end - position);
      const copy = new Uint8Array(prefix.length + used);
      copy.set(prefix);
      copy.set(chunk.subarray(0, used), prefix.length);
      prefix = copy; position += used;
      if (used < chunk.length) pending = chunk.subarray(used);
      onStage('range.progress', { receivedBytes: position, bytes: end });
    }
  };
  const boundedRead = async (start, bytes) => {
    const opened = await request(start, start + bytes - 1);
    const reader2 = opened.response.body.getReader();
    const chunks = [];
    let count = 0;
    try {
      while (count < opened.end - start) {
        const { done, value } = await reader2.read();
        if (done || !(value instanceof Uint8Array) || !value.length || count + value.length > bytes)
          throw fail('CENC_RANGE_INVALID');
        count += value.length;
        chunks.push(value);
      }
    } finally { await reader2.cancel().catch(() => {}); }
    if (count !== bytes) throw fail('CENC_RANGE_INVALID');
    const result = new Uint8Array(bytes);
    let pos = 0;
    for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.length; }
    return result;
  };
  return {
    get fileSize() { return fileSize; },
    async read(start, bytes) {
      ensureOpen();
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(bytes) ||
          bytes < 8 || bytes > MAX_METADATA || start + bytes > fileSize)
        throw fail('CENC_RANGE_INVALID');
      onStage('range.request', { offset: start, bytes });
      let data;
      if (start + bytes <= MAX_METADATA + HEADER_SIZE && reader) {
        await readPrefixTo(start + bytes);
        data = prefix.slice(start, start + bytes);
      } else {
        await reader?.cancel().catch(() => {});
        reader = null; pending = null;
        data = await boundedRead(start, bytes);
      }
      onStage('range.response', { status: 206 });
      onStage('range.complete', { bytes: data.length });
      return { data, fileSize };
    },
    handoff() {
      ensureOpen();
      if (handedOff) throw new Error('Media stream already transferred');
      handedOff = true;
      const initialRanges = prefix.length ? [{ offset: 0, data: prefix }] : [];
      const offset = position, end = streamEnd;
      if (!reader) return { initialRanges, initialStream: null, initialOffset: offset, initialEnd: end };
      const sourceReader = reader, firstChunk = pending;
      pending = null;
      let first = true;
      const initialStream = new ReadableStream({
        async pull(out) {
          try {
            if (first) { first = false; if (firstChunk?.length) { out.enqueue(firstChunk); return; } }
            const { done, value } = await sourceReader.read();
            if (done) out.close(); else out.enqueue(value);
          } catch (error) { out.error(error); }
        },
        cancel(reason) { return sourceReader.cancel(reason).catch(() => {}); }
      });
      return { initialRanges, initialStream, initialOffset: offset, initialEnd: end };
    },
    close
  };
}
