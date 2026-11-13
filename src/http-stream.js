// SPDX-License-Identifier: GPL-3.0-only
// Pull one persistent response as AVIO needs bytes. Timers cover active I/O,
// never time deliberately spent waiting for the player's buffer backpressure.
import { RANGE_TIMEOUT_MS, rangeTiming } from './range-deadline.js';
const fail = (code, status = 0) => Object.assign(new Error(code), { code, status });
const KEEP = 2 * 1024 * 1024;
export function createHttpStreamReader({ fetchImpl, url, fileSize, signal,
  recovery, timeoutMs = RANGE_TIMEOUT_MS, onResponse = () => {}, onChunk = () => {} }) {
  let session = null, base = 0, length = 0, head = 0, closed = false;
  const bytes = new Uint8Array(8 * 1024 * 1024);
  let requests = 0, receivedBytes = 0, validator = null;
  const drop = () => {
    const old = session;
    session = null;
    if (old) {
      old.controller.abort();
      void old.reader?.cancel().catch(() => {});
    }
  };
  const close = () => { closed = true; drop(); signal?.removeEventListener('abort', close); };
  signal?.addEventListener('abort', close, { once: true });
  const check = () => {
    if (closed || signal?.aborted) throw fail('CANCELED');
  };
  async function io(action) {
    check();
    let timer, onAbort;
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => { drop(); reject(fail('CENC_RANGE_TIMEOUT')); }, timeoutMs);
      onAbort = () => reject(fail('CANCELED'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(action), interrupted]); }
    catch (error) {
      check();
      throw /^CENC_[A-Z_]+$/.test(error?.code || '') || error?.code === 'CANCELED'
        ? error : fail('CENC_RANGE_HTTP');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  async function open(offset) {
    drop();
    const current = { controller: new AbortController(), reader: null, end: fileSize };
    session = current;
    const started = performance.now();
    requests++;
    const response = await io(async () => {
      const result = await fetchImpl(url, {
        headers: { Range: 'bytes=' + offset + '-' }, signal: current.controller.signal, cache: 'no-store'
      });
      if (session !== current || closed) {
        void result.body?.cancel().catch(() => {});
        throw fail('CANCELED');
      }
      return result;
    });
    // An adapter may finish after a timeout/cancellation. Dispose that response.
    if (session !== current || closed) {
      void response.body?.cancel().catch(() => {});
      throw fail('CANCELED');
    }
    onResponse({ requests, receivedBytes, status: response.status,
      headerMs: performance.now() - started, ...rangeTiming(response) });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    const full = response.status === 200 && offset === 0;
    const valid = response.status === 206 && match && Number(match[1]) === offset &&
      Number(match[2]) >= offset && Number(match[2]) < fileSize && Number(match[3]) === fileSize;
    const length = response.headers.get('content-length');
    const expected = full ? fileSize : valid ? Number(match[2]) - offset + 1 : 0;
    if ((!full && !valid) || (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) || !response.body) {
      void response.body?.cancel().catch(() => {});
      const status = response.status;
      throw fail(status === 403 ? 'CENC_SOURCE_FORBIDDEN' : status === 429 ? 'CENC_RATE_LIMITED' :
        status >= 400 && status !== 416 ? 'CENC_RANGE_HTTP' : 'CENC_RANGE_INVALID', status);
    }
    const tag = response.headers.get('etag');
    if (validator && tag && validator !== tag) {
      void response.body.cancel().catch(() => {});
      throw fail('CENC_RANGE_INVALID');
    }
    if (tag) validator = tag;
    current.end = offset + expected;
    current.reader = response.body.getReader();
  }
  async function fill(end) {
    while (base + length < end) {
      check();
      const offset = base + length;
      if (!session || offset === session.end) await open(offset);
      const { done, value } = await io(() => session.reader.read());
      if (done) throw fail('CENC_RANGE_HTTP'); // Premature EOF can resume at offset.
      if (!(value instanceof Uint8Array) || value.length > 4 * 1024 * 1024 ||
          offset + value.length > session.end) throw fail('CENC_RANGE_INVALID');
      if (!value.length) throw fail('CENC_RANGE_INVALID');
      if (head + length + value.length > bytes.length) {
        bytes.copyWithin(0, head, head + length); head = 0;
      }
      if (length + value.length > bytes.length) throw fail('CENC_RANGE_INVALID');
      onChunk(offset, value);
      bytes.set(value, head + length); length += value.length;
      receivedBytes += value.length;
    }
  }
  return {
    async read(start, wanted) {
      check();
      if (!Number.isSafeInteger(start) || start < 0 || start >= fileSize ||
          !Number.isInteger(wanted) || wanted < 1 || wanted > 1024 * 1024)
        throw fail('CENC_RANGE_INVALID');
      const end = Math.min(fileSize, start + wanted);
      if (start < base || start > base + length) {
        drop(); base = start; head = 0; length = 0;
      }
      const once = async () => {
        try { await fill(end); }
        catch (error) { drop(); throw error; }
        return bytes.slice(head + start - base, head + end - base);
      };
      const output = recovery ? await recovery.read(once, signal) : await once();
      // Keep a small rewind window, regardless of total episode length.
      if (end - base > KEEP) {
        const trim = end - base - KEEP;
        base += trim; head += trim; length -= trim;
      }
      return output;
    },
    close,
    get stats() { return { requests, receivedBytes, cachedBytes: length }; }
  };
}
