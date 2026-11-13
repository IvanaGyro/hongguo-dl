// SPDX-License-Identifier: GPL-3.0-only
// CDN-first media I/O. Access-token URLs must never be included in diagnostics.
import { mediaProxyUrl } from './logic.js';
const CDN_DOMAINS = [
  'qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com',
  'ibytedtos.com', 'bytevcloud.com', 'bytedance.com', 'toutiaovod.com',
  'pstatp.com', 'snssdk.com'
];
export function isApprovedDirectMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (!url.port || url.port === '443') && CDN_DOMAINS.some(domain =>
        url.hostname === domain || url.hostname.endsWith('.' + domain));
  } catch { return false; }
}
export function isAcceptedMediaTransportUrl(value, baseOrigin = '') {
  try {
    const url = new URL(value, baseOrigin || undefined);
    return isApprovedDirectMediaUrl(url.href) ||
      ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === '/api/media' &&
      (url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}
export function createMediaTransport({ directUrl, proxyUrl, fetchImpl = fetch,
  onFallback = () => {}, direct = true } = {}) {
  if (!proxyUrl) throw new TypeError('Missing media proxy endpoint');
  let useDirect = direct && isApprovedDirectMediaUrl(directUrl);
  const fetchMedia = async (_url, options = {}) => {
    if (!useDirect) return fetchImpl(proxyUrl, options);
    let response;
    try {
      response = await fetchImpl(directUrl, { ...options, mode: 'cors', credentials: 'omit' });
    } catch {
      if (options.signal?.aborted) throw Object.assign(new Error('Canceled'), { code: 'CANCELED' });
      useDirect = false;
      onFallback('cors-or-network');
      return fetchImpl(proxyUrl, options);
    }
    const range = options.headers?.Range || options.headers?.range;
    const validRange = !range || /^bytes \d+-\d+\/\d+$/.test(
      response.headers.get('content-range') || '');
    if (response.status === 429) return response;
    if ([400, 403, 405, 416].includes(response.status) ||
        (range && (response.status !== 206 || !validRange))) {
      await response.body?.cancel().catch(() => {});
      useDirect = false;
      onFallback('range-or-access');
      return fetchImpl(proxyUrl, options);
    }
    return response;
  };
  return { fetch: fetchMedia, get mode() { return useDirect ? 'direct' : 'proxy'; } };
}
export function createMediaTransportForSource(url, profile, workerOrigin,
  fetchImpl = fetch, onFallback = () => {}) {
  return createMediaTransport({ directUrl: url,
    proxyUrl: mediaProxyUrl(url, profile, workerOrigin), fetchImpl, onFallback });
}
