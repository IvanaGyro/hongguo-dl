// Consecutive identical errors, rather than a fixed retry count, determine
// when a job stops. A separate safety ceiling prevents alternating failures
// from retrying indefinitely when the server is permanently unavailable.
export function recordFailure(previous, error, repeatedLimit, attemptLimit = 20) {
  const key = String(error.code || 'UNKNOWN') + '\u0000' + String(error.message || '');
  const streak = previous?.key === key ? (previous.streak || 0) + 1 : 1;
  const attempts = (previous?.attempts || 0) + 1;
  return { key, streak, attempts,
    retry: streak < repeatedLimit && attempts < attemptLimit &&
      !['CANCELED', 'HLS_DRM', 'INVALID_KEY'].includes(error.code),
    delay: Math.min(8000, 700 * (2 ** Math.min(4, streak - 1))) };
}
