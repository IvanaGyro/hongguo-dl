// SPDX-License-Identifier: GPL-3.0-only
// Bound the entire small Range operation (headers AND body), not an episode.
// Race the task as well as aborting fetch: adapters need not honor AbortSignal.
export const RANGE_TIMEOUT_MS = 10000;
export function withRangeDeadline(run, signal, timeoutMs = RANGE_TIMEOUT_MS) {
  const canceled = () => Object.assign(new Error('Canceled'), { code: 'CANCELED' });
  if (signal?.aborted) return Promise.reject(canceled());
  const controller = new AbortController();
  let timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => { reject(canceled()); controller.abort(); };
    timer = setTimeout(() => {
      reject(Object.assign(new Error('影片 Range 請求逾時'), { code: 'CENC_RANGE_TIMEOUT' }));
      controller.abort();
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  let task;
  try { task = Promise.resolve(run(controller.signal)); }
  catch (error) { task = Promise.reject(error); }
  return Promise.race([task, interrupted]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

// The proxy publishes only its own upstream-header duration. Do not interpret
// the residual client time as proof of Worker queueing or a specific network hop.
export function rangeTiming(response) {
  const header = response.headers?.get?.('server-timing') || '';
  const match = /(?:^|,)\s*upstream\s*;\s*dur=([0-9]+(?:\.[0-9]+)?)(?=\s*(?:,|$))/.exec(header);
  const ms = match ? Number(match[1]) : NaN;
  return Number.isFinite(ms) ? { upstreamMs: ms } : {};
}
