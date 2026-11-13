// Consecutive identical errors, rather than a fixed retry count, determine
// when a job stops. A separate safety ceiling prevents alternating failures
// from retrying indefinitely when the server is permanently unavailable.
export function recordFailure(previous, error, repeatedLimit, attemptLimit = 20,
  { retryForbidden = false } = {}) {
  const key = String(error.code || 'UNKNOWN') + '\u0000' + String(error.message || '');
  const streak = previous?.key === key ? (previous.streak || 0) + 1 : 1;
  const attempts = (previous?.attempts || 0) + 1;
  const stoppedBy = ['CANCELED', 'HLS_DRM', 'INVALID_KEY', 'CENC_METADATA_LIMIT',
    'CENC_SOURCE_FORBIDDEN', 'CENC_SOURCE_EXHAUSTED', 'CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED', 'CENC_RANGE_INVALID',
    'CENC_RANGE_UNSUPPORTED'].includes(error.code) &&
    !(retryForbidden && error.code === 'CENC_SOURCE_FORBIDDEN')
    ? 'not-retryable' : streak >= repeatedLimit ? 'repeated'
    : attempts >= attemptLimit ? 'total-limit' : null;
  return { key, streak, attempts, stoppedBy, retry: !stoppedBy,
    delay: Math.min(8000, 700 * (2 ** Math.min(4, streak - 1))) };
}

// Keep retry explanations short and independent of signed media URLs.
export function playbackErrorSummary(error) {
  const code = error?.code || '';
  if (['CENC_SOURCE_FORBIDDEN', 'MEDIA_SOURCE_FORBIDDEN', 'HTTP_403'].includes(code))
    return 'CDN 拒絕存取（HTTP 403）';
  if (['CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED', 'HTTP_429'].includes(code))
    return '來源限制請求頻率（HTTP 429）';
  const messages = {
    CENC_RANGE_TIMEOUT: '影片來源回應逾時', PLAYBACK_TIMEOUT: '載入影片逾時', PLAYBACK_ERROR: '影片解碼或串流中斷',
    CENC_RANGE_HTTP: '影片範圍讀取失敗', CENC_RANGE_INVALID: '來源回傳的影片範圍無效',
    CENC_UNAVAILABLE: '串流初始化失敗',
    CENC_SOURCE_EXHAUSTED: '同畫質來源均拒絕存取或失效',
    CENC_REMUX_FAILED: '增量封裝器中斷',
    FFMPEG_ERROR: '影片處理工具失敗',
    ERR_NETWORK: '網路連線失敗', INCOMPLETE: '影片下載不完整',
    EMPTY_MEDIA: '來源沒有影片資料', SOURCE_UNAVAILABLE: '暫時無法取得片源'
  };
  return messages[code] || '載入影片失敗';
}

export function playbackAttemptMessage(message, attempt = 0, error = null) {
  return attempt > 0
    ? '第 ' + attempt + ' 次重試 · ' + playbackErrorSummary(error) + ' · ' + message
    : message;
}

// Always distinguish the repeated-error threshold from the overall safety cap.
// Include the last actual error so a failed real source is diagnosable rather
// than a misleading "one identical error" after twenty alternating failures.
export function playbackFailureMessage(failure, error, repeatedLimit = 5) {
  const detail = String(error?.message || '未知播放錯誤').slice(0, 180);
  const code = error?.code ? ' [' + error.code + ']' : '';
  if (failure.retry) return playbackErrorSummary(error) + ' · ' +
    (failure.delay / 1000).toFixed(1) + ' 秒後進行第 ' + failure.attempts + ' 次重試';
  const reason = failure.stoppedBy === 'repeated'
    ? '連續相同錯誤 ' + failure.streak + ' 次'
    : failure.stoppedBy === 'total-limit'
      ? '累計失敗 ' + failure.attempts + ' 次（安全上限）'
      : '此錯誤不可重試';
  return '已停止播放 · ' + reason + code + ' · ' + detail;
}
