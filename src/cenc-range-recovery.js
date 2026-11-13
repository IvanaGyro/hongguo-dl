// SPDX-License-Identifier: GPL-3.0-only
// Recover a small number of transient mid-stream 403 responses without
// discarding all buffered fMP4. Do not retry a forbidden *initial* source,
// repeat 429, or exceed the lifetime budget for one Worker.
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
  maxRetries = 2, delayMs = 900,
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
          // HTTP 403 is normally terminal. Only permit a tiny retry budget
          // after this same source has already returned verified media bytes.
          if (signal?.aborted || error?.code !== 'CENC_SOURCE_FORBIDDEN' ||
              successes === 0 || retries >= maxRetries) throw error;
          retries++;
          onRetry({ attempt: retries, delayMs, remaining: maxRetries - retries });
          await wait(delayMs, signal);
        }
      }
    },
    get totalRetries() { return retries; }
  };
}
