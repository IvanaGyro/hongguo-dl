// SPDX-License-Identifier: GPL-3.0-only
// Strict, bounded HTTP 206 reader shared by the CENC Range Worker and Node tests.
// Only publish fixed, sanitized error codes and numeric HTTP statuses.
import { withRangeDeadline, RANGE_TIMEOUT_MS, rangeTiming } from './range-deadline.js';
const rangeError = (code, message, status = 0) =>
  Object.assign(new Error(message), { code, status });

export function readVerifiedRange(fetchImpl, url, start, end, fileSize, signal,
  timeoutMs = RANGE_TIMEOUT_MS, onResponse = () => {}) {
  return withRangeDeadline(localSignal =>
    readVerifiedRangeOnce(fetchImpl, url, start, end, fileSize, localSignal, onResponse), signal, timeoutMs);
}
async function readVerifiedRangeOnce(fetchImpl, url, start, end, fileSize, signal, onResponse) {
  const started = performance.now();
  const expected = end - start + 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(fileSize) || start < 0 || end < start ||
      end >= fileSize || expected > 1024 * 1024)
    throw rangeError('CENC_RANGE_INVALID', 'Invalid bounded Range request');
  if (signal?.aborted) throw rangeError('CANCELED', 'Canceled');
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Range: 'bytes=' + start + '-' + end },
      signal, cache: 'no-store'
    });
  } catch {
    if (signal?.aborted) throw rangeError('CANCELED', 'Canceled');
    // Native fetch failures can contain signed query parameters.
    throw rangeError('CENC_RANGE_HTTP', 'HTTP Range connection failed');
  }
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    throw rangeError('CANCELED', 'Canceled');
  }
  onResponse({ status: response.status, headerMs: performance.now() - started, ...rangeTiming(response) });
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    const codes = {
      200: 'CENC_RANGE_UNSUPPORTED',
      403: 'CENC_SOURCE_FORBIDDEN',
      416: 'CENC_RANGE_INVALID',
      429: 'CENC_RATE_LIMITED'
    };
    throw rangeError(codes[status] || 'CENC_RANGE_HTTP',
      'HTTP Range unavailable (status ' + status + ')', status);
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get('content-range') || '');
  const declared = response.headers.get('content-length');
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end ||
      Number(match[3]) !== fileSize ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expected))) {
    await response.body?.cancel().catch(() => {});
    throw rangeError('CENC_RANGE_INVALID', 'Invalid Content-Range or Content-Length');
  }
  if (!response.body) throw rangeError('CENC_RANGE_INVALID', 'Missing HTTP Range body');
  const reader = response.body.getReader();
  // The provided fetch implementation may be a streaming adapter rather
  // than a native fetch that automatically propagates AbortSignal to body.
  // Cancel outstanding reader.read() immediately on episode switches.
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const output = new Uint8Array(expected);
  let received = 0;
  try {
    while (true) {
      if (signal?.aborted) throw rangeError('CANCELED', 'Canceled');
      let packet;
      try { packet = await reader.read(); }
      catch {
        if (signal?.aborted) throw rangeError('CANCELED', 'Canceled');
        // Do not propagate a URL-bearing body stream exception to the Worker.
        throw rangeError('CENC_RANGE_HTTP', 'HTTP Range body read failed');
      }
      const { done, value } = packet;
      if (signal?.aborted) throw rangeError('CANCELED', 'Canceled');
      if (done) break;
      if (!(value instanceof Uint8Array) || received + value.byteLength > expected)
        throw rangeError('CENC_RANGE_INVALID', 'Oversized HTTP Range response');
      output.set(value, received);
      received += value.byteLength;
    }
    if (signal?.aborted) throw rangeError('CANCELED', 'Canceled');
    if (received !== expected)
      throw rangeError('CENC_RANGE_INVALID', 'Truncated HTTP Range response');
    return output;
  } finally {
    // Cancel even when the CDN streams beyond the requested byte count.
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
