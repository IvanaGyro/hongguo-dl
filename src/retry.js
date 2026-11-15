import { playbackStepNames } from './playback-attempts.js';
// Consecutive identical errors, rather than a fixed retry count, determine
// when a job stops. A separate safety ceiling prevents alternating failures
// from retrying indefinitely when the server is permanently unavailable.
export function recordFailure(previous, error, repeatedLimit, attemptLimit = 20,
  { retryForbidden = false, retryRateLimited = false } = {}) {
  const step = error.retryStep;
  const scoped = step ? previous?.byStep?.[step] : previous;
  const key = String(error.code || 'UNKNOWN') + '\u0000' + String(error.message || '');
  const streak = scoped?.key === key ? (scoped.streak || 0) + 1 : 1;
  const attempts = Math.max((scoped?.attempts || 0) + 1, step ? Number(error.stepAttempt) || 0 : 0);
  const rateLimited = error.status === 429 || ['CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED', 'HTTP_429'].includes(error.code);
  const stoppedBy = error.code === 'PLAYBACK_STEP_LIMIT' || step && attempts >= attemptLimit ? 'step-limit' : ['CANCELED', 'HLS_DRM', 'INVALID_KEY', 'CENC_METADATA_LIMIT',
    'CENC_SOURCE_FORBIDDEN', 'CENC_SOURCE_EXHAUSTED', 'CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED', 'CENC_RANGE_INVALID',
    'CENC_RANGE_UNSUPPORTED'].includes(error.code) &&
    !(retryForbidden && error.code === 'CENC_SOURCE_FORBIDDEN') && !(retryRateLimited && rateLimited)
    ? 'not-retryable' : streak >= repeatedLimit ? 'repeated'
    : attempts >= attemptLimit ? 'total-limit' : null;
  const backoff = Math.min(8000, 700 * (2 ** Math.min(4, (step ? attempts : streak) - 1)));
  return { key, streak, attempts, stoppedBy, retry: !stoppedBy, step,
    ...(step ? { byStep: { ...previous?.byStep, [step]: { key, streak, attempts } } } : {}),
    delay: Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : rateLimited && retryRateLimited ? Math.max(8000, backoff) : backoff };
}

// Keep retry explanations short and independent of signed media URLs.
export function playbackErrorSummary(error) {
  const code = error?.code || '';
  if (error?.retryStep === 'device-register') return '裝置註冊 API 失敗' +
    (error.status >= 400 ? '（HTTP ' + error.status + '）' : '');
  if (error?.stage === 'source-api' || code === 'EMPTY_RESPONSE') {
    const status = error?.status >= 400 && error.status <= 599 ? '（HTTP ' + error.status + '）' : '';
    return (code === 'EMPTY_RESPONSE' ? '片源 API 回傳空白資料' : '片源 API 讀取失敗') + status;
  }
  if (['CENC_SOURCE_FORBIDDEN', 'MEDIA_SOURCE_FORBIDDEN', 'HTTP_403'].includes(code))
    return 'CDN 拒絕存取（HTTP 403）';
  if (['CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED', 'HTTP_429'].includes(code))
    return '來源限制請求頻率（HTTP 429）';
  const messages = {
    CENC_RANGE_TIMEOUT: '影片來源回應逾時', PLAYBACK_TIMEOUT: '載入影片逾時', PLAYBACK_ERROR: '影片解碼或串流中斷',
    CENC_RANGE_HTTP: '影片範圍讀取失敗', CENC_RANGE_INVALID: '來源回傳的影片範圍無效',
    CENC_SOURCE_SLOW: '影片來源下載速度持續不足',
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
  const rawDetail = String(error?.message || '未知播放錯誤').slice(0, 180);
  const detail = error?.stage === 'source-api'
    ? playbackErrorSummary(error) + ' · ' + rawDetail : rawDetail;
  const code = error?.code ? ' [' + error.code + ']' : '';
  const stepName = failure.step ? (playbackStepNames[failure.step] || failure.step) : '';
  if (failure.retry && stepName) return stepName + '第 ' + failure.attempts + '/20 次未成功 · ' + playbackErrorSummary(error) +
    ' · ' + (failure.delay / 1000).toFixed(1) + ' 秒後重試此步驟';
  if (failure.retry) return playbackErrorSummary(error) + ' · ' +
    (failure.delay / 1000).toFixed(1) + ' 秒後進行第 ' + failure.attempts + ' 次重試';
  if (failure.stoppedBy === 'step-limit') return '已停止播放 · ' + stepName + '已達 20 次嘗試上限 · ' +
    playbackErrorSummary(error) + '；請稍後重新整理頁面再試';
  const reason = failure.stoppedBy === 'repeated'
    ? '連續相同錯誤 ' + failure.streak + ' 次'
    : failure.stoppedBy === 'total-limit'
      ? '累計失敗 ' + failure.attempts + ' 次（安全上限）'
      : '此錯誤不可重試';
  return '已停止播放 · ' + reason + code + ' · ' + detail;
}
