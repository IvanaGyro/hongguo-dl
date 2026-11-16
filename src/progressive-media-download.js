// SPDX-License-Identifier: GPL-3.0-only
// Layer 1: one CDN response survives metadata probing and is handed to WASM.
import { retryAfterMs } from './retry-after.js';
import { withRangeDeadline, RANGE_TIMEOUT_MS } from './range-deadline.js';

const HEADER_SIZE = 64 * 1024;
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_SEQUENTIAL_SKIP = 256 * 1024;
const fail = (code, status = 0) => Object.assign(new Error(code), { code, status });
const stopped = signal => { if (signal?.aborted) throw fail('CANCELED'); };

export async function openProgressiveMediaDownload({ url, fetchImpl = fetch, signal, onStage = () => {}, timeoutMs = RANGE_TIMEOUT_MS }) {
  stopped(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let reader = null, closed = false, handedOff = false, position = 0;
  let pending = null, prefix = new Uint8Array(0), streamEnd = 0, fileSize = 0;
  let validator = null;
  const close = () => {
    if (closed) return;
    closed = true; controller.abort();
    if (!handedOff) void reader?.cancel().catch(() => {});
    signal?.removeEventListener('abort', abort);
  };
  const ensureOpen = () => { stopped(signal); if (closed) throw fail('CANCELED'); };
  const request = async (start, end = null, deadline = Infinity) => {
    ensureOpen();
    if (Date.now() >= deadline) throw fail('CENC_RANGE_TIMEOUT');
    let res;
    try {
      res = await withRangeDeadline(localSignal =>
        fetchImpl(url, { headers: { Range: 'bytes=' + start + '-' + (end ?? '') },
          signal: AbortSignal.any([controller.signal, localSignal]), cache: 'no-store' }),
      controller.signal, Math.min(timeoutMs, Math.max(0, deadline - Date.now())));
    } catch (error) {
      if (error?.code === 'CENC_RANGE_TIMEOUT') {
        controller.abort();
        throw error;
      }
      if (controller.signal.aborted) throw fail('CANCELED');
      throw fail('CENC_RANGE_HTTP');
    }
    const status = res.status;
    onStage('range.response', { status });
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
    if (!res.body || !Number.isSafeInteger(total) || total < 8 ||
        startReturned !== start || !Number.isSafeInteger(last) || last < start || last >= total ||
        (end !== null && last > end) || (res.headers.has('content-length') &&
          (!Number.isSafeInteger(len) || len !== last - start + 1)) ||
        (fileSize && fileSize !== total)) {
      await res.body?.cancel().catch(() => {});
      throw fail('CENC_RANGE_INVALID');
    }
    const tag = res.headers.get('etag');
    if (validator && tag && validator !== tag) {
      await res.body?.cancel().catch(() => {});
      throw fail('CENC_RANGE_INVALID');
    }
    if (tag) validator = tag;
    fileSize = total;
    return { response: res, end: last + 1 };
  };
  try {
    // Stage the metadata request before HTTP headers, including failed CDNs.
    onStage('range.request', { part: 'header', offset: 0, bytes: HEADER_SIZE });
    const opened = await request(0);
    streamEnd = opened.end;
    reader = opened.response.body.getReader();
  } catch (error) { close(); throw error; }

  // A contiguous metadata prefix remains bounded to 8 MiB + a header.
  // Seeking across a large mdat uses a separate bounded request.
  const readPrefixTo = async (end, deadline) => {
    while (position < end) {
      ensureOpen();
      if (position >= streamEnd) {
        await reader.cancel().catch(() => {});
        const opened = await request(position, null, deadline);
        streamEnd = opened.end;
        reader = opened.response.body.getReader();
      }
      let next;
      try {
        next = pending ? { value: pending, done: false } :
          await withRangeDeadline(() => reader.read(), controller.signal,
            Math.min(timeoutMs, Math.max(0, deadline - Date.now())));
      } catch (error) {
        if (error?.code === 'CENC_RANGE_TIMEOUT') {
          controller.abort();
          throw error;
        }
        ensureOpen();
        throw fail('CENC_RANGE_HTTP');
      }
      pending = null;
      if (next.done || !(next.value instanceof Uint8Array) || !next.value.length)
        throw fail('CENC_RANGE_INVALID');
      const chunk = next.value;
      if (position + chunk.length > streamEnd) throw fail('CENC_RANGE_INVALID');
      const used = Math.min(chunk.length, end - position);
      const copy = new Uint8Array(prefix.length + used);
      copy.set(prefix);
      copy.set(chunk.subarray(0, used), prefix.length);
      prefix = copy; position += used;
      if (used < chunk.length) pending = chunk.subarray(used);
      onStage('range.progress', { receivedBytes: position, bytes: end });
    }
  };
  const boundedRead = async (start, bytes, deadline) => {
    const opened = await request(start, start + bytes - 1, deadline);
    const reader2 = opened.response.body.getReader();
    const chunks = [];
    let count = 0;
    try {
      while (count < opened.end - start) {
        const { done, value } = await withRangeDeadline(() => reader2.read(), controller.signal,
          Math.min(timeoutMs, Math.max(0, deadline - Date.now())));
        if (done || !(value instanceof Uint8Array) || !value.length || count + value.length > bytes)
          throw fail('CENC_RANGE_INVALID');
        count += value.length;
        chunks.push(value);
      }
    } catch (error) {
      if (error?.code === 'CENC_RANGE_TIMEOUT') {
        controller.abort();
        throw error;
      }
      ensureOpen();
      if (error?.code === 'CANCELED' || error?.code?.startsWith('CENC_RANGE_')) throw error;
      throw fail('CENC_RANGE_HTTP');
    } finally { await reader2.cancel().catch(() => {}); }
    if (count !== bytes) throw fail('CENC_RANGE_INVALID');
    const result = new Uint8Array(bytes);
    let pos = 0;
    for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.length; }
    return result;
  };
  return {
    get fileSize() { return fileSize; },
    async read(start, bytes, part = 'header') {
      ensureOpen();
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(bytes) ||
          bytes < 8 || bytes > MAX_METADATA || start >= fileSize)
        throw fail('CENC_RANGE_INVALID');
      // The metadata probe requests 64 KiB even for files shorter than 64 KiB.
      const wanted = Math.min(bytes, fileSize - start);
      if (wanted < 8) throw fail('CENC_RANGE_INVALID');
      if (start !== 0) onStage('range.request', { part, offset: start, bytes: wanted });
      // Each logical metadata read has a hard 3x timeout, independent of
      // how often the CDN yields tiny chunks. Keep the per-chunk idle timeout.
      const deadline = Date.now() + timeoutMs * 3;
      let data;
      // Only scan through nearby holes. A moov box near EOF should not
      // force a whole-episode download before the first decoded frame.
      // Keep the original 0- stream alive while fetching distant metadata;
      // the worker will continue reading that same response afterwards.
      if (reader && start >= 0 && start <= position + MAX_SEQUENTIAL_SKIP &&
          start + wanted <= MAX_METADATA + HEADER_SIZE) {
        await readPrefixTo(start + wanted, deadline);
        data = prefix.slice(start, start + wanted);
      } else {
        data = await boundedRead(start, wanted, deadline);
      }
      onStage('range.complete', { part, bytes: data.length });
      return { data, fileSize };
    },
    handoff() {
      ensureOpen();
      if (handedOff) throw new Error('Media stream already transferred');
      handedOff = true;
      const initialRanges = prefix.length ? [{ offset: 0, data: prefix }] : [];
      const offset = position, end = streamEnd;
      if (!reader) return { initialRanges, initialStream: null, initialOffset: offset, initialEnd: end, initialEtag: validator };
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
      return { initialRanges, initialStream, initialOffset: offset, initialEnd: end, initialEtag: validator };
    },
    close
  };
}
