// Consecutive identical errors, rather than a fixed retry count, determine
// when a job stops. A separate safety ceiling prevents alternating failures
// from retrying indefinitely when the server is permanently unavailable.
export function recordFailure(previous, error, repeatedLimit, attemptLimit = 20,
  { retryForbidden = false } = {}) {
  const key = String(error.code || 'UNKNOWN') + '\u0000' + String(error.message || '');
  const streak = previous?.key === key ? (previous.streak || 0) + 1 : 1;
  const attempts = (previous?.attempts || 0) + 1;
  const stoppedBy = ['CANCELED', 'HLS_DRM', 'INVALID_KEY', 'CENC_METADATA_LIMIT',
    'CENC_SOURCE_FORBIDDEN', 'CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED', 'CENC_RANGE_INVALID',
    'CENC_RANGE_UNSUPPORTED'].includes(error.code) &&
    !(retryForbidden && error.code === 'CENC_SOURCE_FORBIDDEN')
    ? 'not-retryable' : streak >= repeatedLimit ? 'repeated'
    : attempts >= attemptLimit ? 'total-limit' : null;
  return { key, streak, attempts, stoppedBy, retry: !stoppedBy,
    delay: Math.min(8000, 700 * (2 ** Math.min(4, streak - 1))) };
}

// Always distinguish the repeated-error threshold from the overall safety cap.
// Include the last actual error so a failed real source is diagnosable rather
// than a misleading "one identical error" after twenty alternating failures.
export function playbackFailureMessage(failure, error, repeatedLimit = 5) {
  const detail = String(error?.message || '未知播放錯誤').slice(0, 180);
  const code = error?.code ? ' [' + error.code + ']' : '';
  if (failure.retry) return '播放重試 ' + failure.streak + '/' + repeatedLimit + code + ' · ' + detail;
  const reason = failure.stoppedBy === 'repeated'
    ? '連續相同錯誤 ' + failure.streak + ' 次'
    : failure.stoppedBy === 'total-limit'
      ? '累計失敗 ' + failure.attempts + ' 次（安全上限）'
      : '此錯誤不可重試';
  return '已停止播放 · ' + reason + code + ' · ' + detail;
}
