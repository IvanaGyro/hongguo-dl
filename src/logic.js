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
    HLS_DRM: '此 HLS 使用目前不支援的加密或 DRM 方式',
    HLS_LIVE: '不支援尚未結束的直播 HLS 清單',
    HLS_MANIFEST: 'HLS 清單無效或包含不支援的語法',
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
  return { code, message: message.slice(0, 300) };
}
export function errorWith(code, message) {
  return Object.assign(new Error(message), { code });
}
export function isHlsUrl(url) {
  try { return /\.m3u8$/i.test(new URL(url).pathname); } catch { return false; }
}
export function selectHlsVariant(text, manifestUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    let next = i + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    if (!lines[next] || lines[next].trim().startsWith('#')) throw errorWith('HLS_MANIFEST', 'HLS 主清單缺少子清單網址');
    const bandwidth = Number(/\bBANDWIDTH=(\d+)/.exec(lines[i])?.[1] || 0);
    variants.push({ url: new URL(lines[next].trim(), manifestUrl).href, bandwidth });
  }
  return variants.sort((a, b) => b.bandwidth - a.bandwidth)[0]?.url || null;
}
export function assertHlsManifest(text) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw errorWith('HLS_MANIFEST', '內容不是 HLS 清單');
  if (/#EXT-X-DEFINE:/i.test(text)) throw errorWith('HLS_MANIFEST', '不支援 HLS 動態網址變數');
  if (/#EXT-X-KEY:[^\r\n]*METHOD=(?!AES-128(?:,|$)|NONE(?:,|$))/i.test(text) ||
      /#EXT-X-SESSION-KEY:[^\r\n]*METHOD=(?!AES-128(?:,|$)|NONE(?:,|$))/i.test(text))
    throw errorWith('HLS_DRM', '不支援 SAMPLE-AES / DRM HLS');
  if (!/#EXT-X-ENDLIST/i.test(text) && !/#EXT-X-STREAM-INF/i.test(text))
    throw errorWith('HLS_LIVE', '這是尚未結束的直播清單');
}
export function displayStatus(status) {
  return ({ queued: '等待中', resolving: '取得片源', downloading: '下載中', processing: '處理媒體', completed: '完成',
    failed: '失敗', canceled: '已取消' })[status] || status;
}
