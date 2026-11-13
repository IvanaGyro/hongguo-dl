// SPDX-License-Identifier: GPL-3.0-only
// CDN-first media I/O. Access-token URLs must never be included in diagnostics.
import { mediaProxyUrl } from './logic.js';
// Only cache a host as proxy-preferred when its direct request fails AND
// the same media resource succeeds via the proxy. An invalid signed URL that
// fails on both paths must never poison the host for another episode.
const sessionProxyPreferredHosts = new Set();
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
  onFallback = () => {}, direct = true,
  sessionFailureCache = typeof window !== 'undefined' ? sessionProxyPreferredHosts : null
} = {}) {
  if (!proxyUrl) throw new TypeError('Missing media proxy endpoint');
  const hostname = isApprovedDirectMediaUrl(directUrl) ? new URL(directUrl).hostname : '';
  let useDirect = direct && !!hostname && !sessionFailureCache?.has(hostname);
  const markIfProxyWorks = (response, range) => {
    if (!hostname || !sessionFailureCache) return;
    if (range
      ? response.status === 206 &&
        /^bytes d+-d+/d+$/.test(response.headers.get('content-range') || '')
      : response.ok) sessionFailureCache.add(hostname);
  };
  const fetchMedia = async (_url, options = {}) => {
    if (!useDirect) return fetchImpl(proxyUrl, options);
    let response;
    try {
      response = await fetchImpl(directUrl, { ...options, mode: 'cors', credentials: 'omit' });
    } catch {
      if (options.signal?.aborted) throw Object.assign(new Error('Canceled'), { code: 'CANCELED' });
      useDirect = false;
      onFallback('cors-or-network');
      const fallback = await fetchImpl(proxyUrl, options);
      markIfProxyWorks(fallback, options.headers?.Range || options.headers?.range);
      return fallback;
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
      const fallback = await fetchImpl(proxyUrl, options);
      markIfProxyWorks(fallback, range);
      return fallback;
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
