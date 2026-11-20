// Pure helpers shared with browser code and Node unit tests.
export function safeName(input, fallback = 'video') {
  const name = String(input || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 90);
  return name || fallback;
}
export function normalizeWorkerOrigin(input) {
  const text = String(input || '').trim().replace(new RegExp('/+$'), '');
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('請輸入有效的 Cloudflare Worker HTTPS 網址'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (local && url.protocol === 'http:')) ||
      url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('Worker API 必須是 HTTPS 網域根目錄（本機 localhost 可使用 HTTP）');
  }
  return url.origin;
}
// A previously saved custom origin overrides the build-time default. Invalid
// stale browser settings must not hide a valid GitHub Pages PROXY configuration.
export function chooseWorkerOrigin(saved, configured) {
  let fallback = '';
  try { fallback = normalizeWorkerOrigin(configured); } catch { /* optional build setting */ }
  if (!saved) return fallback;
  try { return normalizeWorkerOrigin(saved); } catch { return fallback; }
}
export function apiUrl(path, workerOrigin = '') {
  if (!path.startsWith('/api/')) throw new Error('不允許非 /api/ 的 Worker 路徑');
  return normalizeWorkerOrigin(workerOrigin) + path;
}
export function mediaProxyUrl(url, profile = 'web', workerOrigin = '', userAgent = '') {
  return apiUrl('/api/media?url=' + encodeURIComponent(url) +
    '&profile=' + (profile === 'app' ? 'app' : 'web') +
    (profile === 'app' && userAgent ? '&ua=' + encodeURIComponent(userAgent) : ''), workerOrigin);
}
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n < 1024) return Math.round(n) + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}
export function classifyError(error) {
  if (error?.name === 'AbortError' || error?.code === 'CANCELED') return { code: 'CANCELED', message: '使用者已取消' };
  let code = String(error?.code || 'DOWNLOAD_ERROR');
  // Older Worker deployments report upstream forbidden/rate-limit as
  // MEDIA_HTTP. Classify only the stable, exact sanitized HTTP status message,
  // never parse or display a signed URL / media response body.
  const rawMessage = String(error?.message || '');
  if (code === 'MEDIA_HTTP' && /^媒體來源回傳 HTTP 403$/.test(rawMessage))
    code = 'MEDIA_SOURCE_FORBIDDEN';
  else if (code === 'MEDIA_HTTP' && /^媒體來源回傳 HTTP 429$/.test(rawMessage))
    code = 'MEDIA_RATE_LIMITED';
  const descriptions = {
    MEMORY_LIMIT: '檔案過大，瀏覽器記憶體模式無法安全處理；請改用支援資料夾寫入的瀏覽器，或下載較小片源',
    FFMPEG_ERROR: 'FFmpeg.wasm 處理失敗：可能不支援此影片編碼、加密方式或媒體格式',
    FFMPEG_LIMIT: 'FFmpeg.wasm 的記憶體限制：請選擇較短分集或原始串流下載',
    NO_DIRECTORY: '儲存資料夾不可使用，請重新選擇',
    UNSUPPORTED_FORMAT: '不支援 HLS（.m3u8）媒體網址；請改用 MP4 媒體直連或官方劇集網址',
    INCOMPLETE: '下載內容不完整，收到的位元組數與 Content-Length 不符',
    EMPTY_MEDIA: '媒體內容為空，請重新取得來源',
    SOURCE_UNAVAILABLE: '目前無法取得片源，請重試或確認官方是否提供本集',
    ERR_NETWORK: '連線無法建立，請檢查網路或 Cloudflare Worker 與來源主機的連線',
    CODEC_UNAVAILABLE: '所選編碼沒有可用片源，請改選不限編碼'
  };
  const message = code === 'MEDIA_SOURCE_FORBIDDEN'
    ? '媒體 CDN 拒絕存取（HTTP 403），不是影音解碼失敗；請確認官方影片仍可存取'
    : code === 'MEDIA_RATE_LIMITED'
      ? '媒體 CDN 限制請求頻率（HTTP 429），請勿連續重試'
      : rawMessage || descriptions[code] || '下載失敗';
  return { code, message: message.slice(0, 300),
    ...(error?.stage === 'source-api' ? { stage: 'source-api' } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.retryStep === 'string' ? { retryStep: error.retryStep, stepAttempt: error.stepAttempt } : {}),
    ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {})
  };
}
export function errorWith(code, message) {
  return Object.assign(new Error(message), { code });
}
// HLS playlists are not supported. Detect them only to reject them early,
// before any media request is made.
export function isHlsUrl(url) {
  try { return /\.m3u8$/i.test(new URL(url).pathname); } catch { return false; }
}
export function assertSupportedMediaUrl(url) {
  if (isHlsUrl(url)) throw errorWith('UNSUPPORTED_FORMAT',
    '不支援 HLS（.m3u8）媒體網址；請改用 MP4 媒體直連或官方劇集網址');
}
export function displayStatus(status) {
  return ({ queued: '等待中', resolving: '取得片源', downloading: '下載中', processing: '處理媒體', completed: '完成',
    failed: '失敗', canceled: '已取消' })[status] || status;
}
