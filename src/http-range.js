// SPDX-License-Identifier: GPL-3.0-only
// Strict, bounded HTTP 206 reader shared by the CENC Range Worker and Node tests.
export async function readVerifiedRange(fetchImpl, url, start, end, fileSize, signal) {
  const expected = end - start + 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(fileSize) || start < 0 || end < start ||
      end >= fileSize || expected > 1024 * 1024)
    throw new Error('Invalid bounded Range request');
  if (signal?.aborted) throw new Error('Canceled');
  const response = await fetchImpl(url, {
    headers: { Range: 'bytes=' + start + '-' + end },
    signal, cache: 'no-store'
  });
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Canceled');
  }
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error('HTTP Range unavailable (status ' + response.status + ')');
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get('content-range') || '');
  const declared = response.headers.get('content-length');
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end ||
      Number(match[3]) !== fileSize ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expected))) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Invalid Content-Range or Content-Length');
  }
  if (!response.body) throw new Error('Missing HTTP Range body');
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
      if (signal?.aborted) throw new Error('Canceled');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error('Canceled');
      if (done) break;
      if (!(value instanceof Uint8Array) || received + value.byteLength > expected)
        throw new Error('Oversized HTTP Range response');
      output.set(value, received);
      received += value.byteLength;
    }
    if (signal?.aborted) throw new Error('Canceled');
    if (received !== expected) throw new Error('Truncated HTTP Range response');
    return output;
  } finally {
    // Cancel even when the CDN streams beyond the requested byte count.
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
