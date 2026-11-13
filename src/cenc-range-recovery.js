// SPDX-License-Identifier: GPL-3.0-only
// Retry transient Range failures without discarding the current demuxer or
// buffered media. Never retry initial 403, HTTP 429 or malformed byte ranges.
// Initial network/5xx retry is opt-in when no untried alternate source exists.
const canceled = () => Object.assign(new Error('Canceled'), { code: 'CANCELED' });

export function waitForRangeRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(canceled());
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(canceled());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createCencRangeRecovery({
  maxRetries = 2, delayMs = 900, retryInitial = false,
  wait = waitForRangeRetry, onRetry = () => {}
} = {}) {
  let successes = 0, retries = 0;
  return {
    async read(readOnce, signal) {
      for (;;) {
        if (signal?.aborted) throw canceled();
        try {
          const bytes = await readOnce();
          successes++;
          return bytes;
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 0;
          const transient = error?.code === 'CENC_RANGE_TIMEOUT' ||
            error?.code === 'CENC_RANGE_HTTP' &&
              (status === 0 || status === 408 || status >= 500 && status <= 599);
          const recoverable = transient || error?.code === 'CENC_SOURCE_FORBIDDEN';
          // Allow just one initial transient retry. Once media has succeeded,
          // use the shared lifetime budget, including intermittent HTTP 403.
          const initialAllowed = retryInitial && transient && retries === 0;
          if (signal?.aborted || !recoverable ||
              successes === 0 && !initialAllowed || retries >= maxRetries) throw error;
          retries++;
          onRetry({ code: error.code, status, attempt: retries, delayMs,
            remaining: maxRetries - retries });
          await wait(delayMs, signal);
        }
      }
    },
    get totalRetries() { return retries; }
  };
}
