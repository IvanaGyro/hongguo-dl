import { retryAfterMs } from './retry-after.js';
// SPDX-License-Identifier: GPL-3.0-only
// Pull one persistent response as AVIO needs bytes. Timers cover active I/O,
// never time deliberately spent waiting for the player's buffer backpressure.
import { RANGE_TIMEOUT_MS, rangeTiming } from './range-deadline.js';
const fail = (code, status = 0) => Object.assign(new Error(code), { code, status });
const KEEP = 2 * 1024 * 1024;
export function createHttpStreamReader({ fetchImpl, url, fileSize, signal,
  recovery, timeoutMs = RANGE_TIMEOUT_MS, onResponse = () => {}, onRequest = () => {}, onChunk = () => {}, externalCache = null,
  maxPacketBytes = 4 * 1024 * 1024, durationSeconds = 0, onSlow = () => {},
  initialStream = null, initialOffset = 0, initialEnd = 0, initialEtag = null }) {
  let session = null, base = 0, length = 0, head = 0, closed = false;
  const bytes = externalCache ? null : new Uint8Array(8 * 1024 * 1024);
  let networkOffset = 0;
  let requests = 0, receivedBytes = 0;
  // Preserve the original response validator when adopting its body.
  let validator = initialStream && typeof initialEtag === 'string' ? initialEtag : null;
  const requiredRate = durationSeconds > 0 ? fileSize / durationSeconds : 0;
  let sampleBytes = 0, activeMs = 0, bytesPerSecond = 0;
  if (initialStream) {
    if (!(initialStream instanceof ReadableStream) ||
        !Number.isSafeInteger(initialOffset) || initialOffset < 0 ||
        !Number.isSafeInteger(initialEnd) || initialOffset > initialEnd ||
        initialEnd > fileSize)
      throw fail('CENC_RANGE_INVALID');
    // A layer-one response has already supplied the metadata prefix. The
    // transferred body resumes at initialOffset, with no new HTTP fetch.
    session = { controller: { abort() {} }, reader: initialStream.getReader(), end: initialEnd };
    networkOffset = initialOffset;
    requests = 1;
  }
  const measure = (bytesRead, elapsed) => {
    sampleBytes += bytesRead; activeMs += elapsed;
    bytesPerSecond = sampleBytes * 1000 / Math.max(1, activeMs);
    // Measure only awaited body I/O, never time paused at MSE/decoder ACKs.
    if (activeMs < Math.min(8000, timeoutMs)) return;
    const slow = requiredRate > 0 && bytesPerSecond < requiredRate &&
      (!externalCache || externalCache.firstMissing(0, fileSize) !== null);
    const fields = { bytesPerSecond, requiredBytesPerSecond: requiredRate, activeMs };
    sampleBytes = 0; activeMs = 0;
    if (slow) { onSlow(fields); throw fail('CENC_SOURCE_SLOW'); }
  };
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
  const check = readSignal => {
    if (closed || signal?.aborted || readSignal?.aborted) throw fail('CANCELED');
  };
  async function io(action, readSignal) {
    check(readSignal);
    let timer, onAbort;
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => { drop(); reject(fail('CENC_RANGE_TIMEOUT')); }, timeoutMs);
      onAbort = () => { reject(fail('CANCELED')); drop(); };
      readSignal?.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => { check(readSignal); return action(); }), interrupted]); }
    catch (error) {
      check(readSignal);
      throw /^CENC_[A-Z_]+$/.test(error?.code || '') || error?.code === 'CANCELED'
        ? error : fail('CENC_RANGE_HTTP');
    } finally {
      clearTimeout(timer);
      readSignal?.removeEventListener('abort', onAbort);
    }
  }
  async function open(offset, readSignal) {
    drop();
    const current = { controller: new AbortController(), reader: null, end: fileSize };
    session = current;
    const started = performance.now();
    requests++;
    onRequest({ requests, offset });
    const response = await io(async () => {
      const result = await fetchImpl(url, {
        headers: { Range: 'bytes=' + offset + '-' }, signal: current.controller.signal, cache: 'no-store'
      });
      if (session !== current || closed) {
        void result.body?.cancel().catch(() => {});
        throw fail('CANCELED');
      }
      return result;
    }, readSignal);
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
      throw Object.assign(fail(status === 403 ? 'CENC_SOURCE_FORBIDDEN' : status === 429 ? 'CENC_RATE_LIMITED' :
        status >= 400 && status !== 416 ? 'CENC_RANGE_HTTP' : 'CENC_RANGE_INVALID', status), { retryAfterMs: retryAfterMs(response.headers.get('retry-after')) });
    }
    const tag = response.headers.get('etag');
    if (validator && tag && validator !== tag) {
      void response.body.cancel().catch(() => {});
      throw fail('CENC_RANGE_INVALID');
    }
    if (tag) validator = tag;
    networkOffset = offset;
    current.end = offset + expected;
    current.reader = response.body.getReader();
  }
  async function fill(end, readSignal) {
    while (base + length < end) {
      check(readSignal);
      const offset = base + length;
      if (!session || offset === session.end) await open(offset, readSignal);
      const started = performance.now();
      const { done, value } = await io(() => session.reader.read(), readSignal);
      check(readSignal);
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
      measure(value.length, performance.now() - started);
    }
  }
  async function readExternal(start, end, readSignal) {
    let result = externalCache.read(start, end - start);
    while (!result) {
      const missing = externalCache.firstMissing(start, end);
      // An AVIO read can jump a little beyond the metadata prefix (e.g.
      // 100658 after 65536). Consume the existing body instead of reopening
      // a second, overlapping Range. Distant seeks still open a new Range.
      if (!session || networkOffset > missing || networkOffset === session.end ||
          missing - networkOffset > 256 * 1024)
        await open(missing, readSignal);
      const started = performance.now();
      const { done, value } = await io(() => session.reader.read(), readSignal);
      check(readSignal);
      if (done) throw fail('CENC_RANGE_HTTP');
      if (!(value instanceof Uint8Array) || !value.length || value.length > maxPacketBytes ||
          networkOffset + value.length > session.end) throw fail('CENC_RANGE_INVALID');
      // A cached/adapter response can legitimately deliver a whole short
      // episode in one packet. Store it directly in the bounded sparse cache;
      // never force it through the demuxer's small rewind buffer.
      onChunk(networkOffset, value);
      networkOffset += value.length; receivedBytes += value.length;
      measure(value.length, performance.now() - started);
      result = externalCache.read(start, end - start);
    }
    return result;
  }
  return {
    async read(start, wanted, { signal: requestedSignal, speculative = false } = {}) {
      const readSignal = requestedSignal && signal ? AbortSignal.any([requestedSignal, signal]) : requestedSignal || signal;
      check(readSignal);
      if (!Number.isSafeInteger(start) || start < 0 || start >= fileSize ||
          !Number.isInteger(wanted) || wanted < 1 || wanted > 1024 * 1024)
        throw fail('CENC_RANGE_INVALID');
      const end = Math.min(fileSize, start + wanted);
      if (externalCache) {
        const once = async () => {
          try { return await readExternal(start, end, readSignal); }
          catch (error) { drop(); throw error; }
        };
        return recovery && !speculative ? recovery.read(once, readSignal) : once();
      }
      if (start < base || start > base + length) {
        drop(); base = start; head = 0; length = 0;
      }
      const once = async () => {
        try { await fill(end, readSignal); }
        catch (error) { drop(); throw error; }
        return bytes.slice(head + start - base, head + end - base);
      };
      const output = recovery && !speculative ? await recovery.read(once, readSignal) : await once();
      // Keep a small rewind window, regardless of total episode length.
      if (end - base > KEEP) {
        const trim = end - base - KEEP;
        base += trim; head += trim; length -= trim;
      }
      return output;
    },
    close,
    get stats() { return { requests, receivedBytes, cachedBytes: length, bytesPerSecond,
      position: session ? externalCache ? networkOffset : base + length : null }; }
  };
}
