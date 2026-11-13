// SPDX-License-Identifier: GPL-3.0-only
// Download-only Cloudflare Worker: static assets plus narrowly-scoped media/API access.
import appModule from './vendor/app-source.js';

const { fetchAppPlayUrl } = appModule;
const SITE = 'https://hongguoduanju.com';
const API_HOSTS = ['hongguoduanju.com'];
const MEDIA_HOSTS = [
  'qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com',
  'ibytedtos.com', 'bytevcloud.com', 'bytedance.com', 'toutiaovod.com',
  'pstatp.com', 'snssdk.com'
];
const MAX_HTML = 4 * 1024 * 1024;
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const APP_UA = 'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C)';
const ID = /^\d{1,30}$/;
const isHost = (host, suffixes) => suffixes.some(s => host === s || host.endsWith('.' + s));

export function safeUrl(raw, allowed) {
  let u;
  try { u = new URL(raw); } catch { throw httpError(400, 'INVALID_URL', '無效的網址'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      !isHost(u.hostname.toLowerCase(), allowed) || u.href.length > 8192) {
    throw httpError(403, 'HOST_NOT_ALLOWED', '網址不在允許的官方媒體來源清單');
  }
  return u;
}
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function asJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}
async function fetchLimited(url, { maxBytes = MAX_HTML, accept = 'text/html', timeout = 10000 } = {}) {
  let target = safeUrl(url, API_HOSTS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    for (let i = 0; i < 4; i++) {
      const response = await fetch(target.href, { redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': WEB_UA, 'Accept': accept, 'Referer': SITE + '/' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.get('location')) throw httpError(502, 'BAD_REDIRECT', '來源網站跳轉缺少地址');
        target = safeUrl(new URL(response.headers.get('location'), target).href, API_HOSTS);
        continue;
      }
      if (!response.ok) throw httpError(response.status, 'UPSTREAM_HTTP', '官方頁面回傳 HTTP ' + response.status);
      if (Number(response.headers.get('content-length')) > maxBytes)
        throw httpError(502, 'RESPONSE_TOO_LARGE', '官方頁面超過大小限制');
      if (!response.body) throw httpError(502, 'EMPTY_RESPONSE', '官方頁面沒有回傳內容');
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) { await reader.cancel(); throw httpError(502, 'RESPONSE_TOO_LARGE', '官方頁面超過大小限制'); }
        chunks.push(value);
      }
      const combined = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder().decode(combined);
    }
    throw httpError(502, 'TOO_MANY_REDIRECTS', '官方頁面跳轉次數過多');
  } finally { clearTimeout(timer); }
}
export function readRouterData(html) {
  const match = String(html).match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
  if (!match) throw httpError(502, 'NO_ROUTER_DATA', '官方頁面沒有劇集資料');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw httpError(502, 'INCOMPLETE_DATA', '官方劇集資料不完整');
}
export function parseInput(input) {
  const text = String(input || '').trim();
  if (ID.test(text)) return { kind: 'series', seriesId: text };
  // Direct video URLs are supported without search, but only from known video CDNs.
  let u;
  try { u = new URL(text); } catch { throw httpError(400, 'INVALID_INPUT', '請輸入劇集 ID、官方分享網址或媒體直連網址'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 8192) throw httpError(400, 'INVALID_INPUT', '只接受 HTTPS 網址');
  if (isHost(u.hostname, MEDIA_HOSTS)) {
    safeUrl(text, MEDIA_HOSTS);
    return { kind: 'media', url: u.href };
  }
  safeUrl(text, API_HOSTS);
  if (u.hostname === 'hongguoduanju.com' && u.pathname.startsWith('/video/public/'))
    return { kind: 'media', url: u.href };
  const id = u.searchParams.get('video_series_id') || u.searchParams.get('series_id') ||
    /^\/player\/(\d{1,30})(?:\/|$)/.exec(u.pathname)?.[1];
  if (!ID.test(id || '')) throw httpError(400, 'ID_NOT_FOUND', '網址中找不到劇集 ID；請貼官方劇集或播放頁連結');
  return { kind: 'series', seriesId: id };
}
export function parseEpisodes(html, seriesId) {
  const data = readRouterData(html).loaderData || {};
  const record = data['player_(series_id)/page'] || data['player_(series_id)/(vid)/page'] || data.detail_page;
  const info = record?.seriesDetail;
  if (!record || record.isSuccess === false || String(info?.series_id || '') !== String(seriesId) ||
      (record.series_id != null && String(record.series_id) !== String(seriesId)) ||
      !Array.isArray(info?.vid_list)) throw httpError(502, 'INVALID_SERIES', '官方頁面無法確認劇集 ID 或分集列表');
  const ids = info.vid_list.map(String);
  if (!ids.length || ids.some(id => !ID.test(id)) || new Set(ids).size !== ids.length)
    throw httpError(502, 'INVALID_EPISODES', '官方分集列表無效');
  const available = info.accessible_episode_cnt != null && /^\d+$/.test(String(info.accessible_episode_cnt))
    ? Math.min(Number(info.accessible_episode_cnt), ids.length) : null;
  return {
    kind: 'series', seriesId, title: String(info.series_name || '未命名短劇').slice(0, 160),
    total: ids.length, accessible: available,
    episodes: ids.map((vid, i) => ({ vid, index: i + 1, available: available == null ? null : i < available }))
  };
}
async function loadSeries(seriesId) {
  let error;
  for (const path of ['/detail?series_id=' + encodeURIComponent(seriesId), '/player/' + encodeURIComponent(seriesId)]) {
    try { return parseEpisodes(await fetchLimited(SITE + path), seriesId); }
    catch (e) { error = e; }
  }
  throw error;
}
export function findPublicMedia(html, sid, vid) {
  const data = readRouterData(html).loaderData?.['player_(series_id)/(vid)/page'];
  if (!data || data.isSuccess === false || data.protectedPlayback === true ||
      String(data.vid || '') !== vid || String(data.series_id || '') !== sid ||
      String(data.seriesDetail?.series_id || '') !== sid ||
      data.publicVideoSeo?.available !== true ||
      String(data.publicVideoSeo.itemId || '') !== vid ||
      String(data.publicVideoSeo.seriesId || '') !== sid) return null;
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(script[1])) continue;
    let video;
    try { video = JSON.parse(script[2]); } catch { continue; }
    if (video?.['@type'] !== 'VideoObject') continue;
    try {
      const canonical = new URL(video.url);
      const uri = new URL(String(video.contentUrl).replace(/\\\//g, '/').replace(/&amp;/g, '&'));
      const validCanonical = canonical.origin === SITE && (canonical.pathname === '/player/' + sid + '/' + vid ||
        (canonical.pathname === '/player/' + sid && uri.origin === SITE && uri.pathname.startsWith('/video/public/' + vid + '/')));
      if (validCanonical && (!video['@id'] || video['@id'] === video.url) &&
          (uri.origin === SITE || isHost(uri.hostname, MEDIA_HOSTS)) &&
          uri.protocol === 'https:' && !uri.username && !uri.password) {
        return { url: uri.href, codec: 'unknown', contentKey: null, source: 'web', quality: 'public' };
      }
    } catch { /* Ignore unrelated JSON-LD. */ }
  }
  return null;
}
async function loadSource(sid, vid, codec, quality, channel = 'auto') {
  if (!ID.test(sid) || !ID.test(vid)) throw httpError(400, 'INVALID_ID', '劇集或分集 ID 無效');
  if (!['auto', 'h264', 'hevc', 'bytevc2'].includes(codec)) throw httpError(400, 'INVALID_CODEC', '不支援的編碼篩選');
  if (!['auto', '720p', '1080p'].includes(quality)) throw httpError(400, 'INVALID_QUALITY', '不支援的畫質篩選');
  if (!['auto', 'web', 'app'].includes(channel))
    throw httpError(400, 'INVALID_SOURCE_CHANNEL', '不支援的來源查詢方式');
  let webError = '';
  if (channel !== 'app') {
    try {
      const html = await fetchLimited(SITE + '/player/' + sid + '/' + vid, { timeout: 4500 });
      const media = findPublicMedia(html, sid, vid);
      if (media) return { variants: [media], sourceChannel: 'web' };
    } catch (error) { webError = error.message; }
    if (channel === 'web')
      throw httpError(404, 'PUBLIC_SOURCE_UNAVAILABLE',
        '目前沒有已確認可直接讀取的公開網頁片源');
  }
  try {
    // Source metadata is complete. Quality and codec are a client-side
    // selection policy, not a Worker concern.
    const result = await fetchAppPlayUrl(vid, { quality: 'auto' });
    const variants = result.variants || [result];
    if (!variants.length) throw httpError(404, 'SOURCE_UNAVAILABLE', '本集沒有可用片源');
    return { variants: variants.map(v => ({ url: v.url, codec: v.codec, quality: v.quality,
      contentKey: v.contentKey || null, source: v.source, width: v.width || null,
      height: v.height || null, duration: v.duration || null })), sourceChannel: 'app' };
  } catch (e) {
    // Preserve upstream error codes for actionable diagnostics, but never leak request credentials.
    const message = String(e.message || 'App 取源失敗').slice(0, 250);
    throw httpError(e.status && e.status >= 400 ? e.status : 502,
      e.code || 'SOURCE_UNAVAILABLE', webError ? message + '；官網來源：' + webError : message);
  }
}
async function relayMedia(request, raw) {
  const endpoint = new URL(request.url);
  const urlParam = endpoint.searchParams.get('url');
  if (!urlParam) throw httpError(400, 'MISSING_URL', '缺少媒體網址');
  let target = safeUrl(urlParam, [...MEDIA_HOSTS, ...API_HOSTS]);
  if (target.hostname === 'hongguoduanju.com' && !target.pathname.startsWith('/video/public/'))
    throw httpError(403, 'HOST_NOT_ALLOWED', '官網僅允許公開影片端點');
  const range = request.headers.get('range');
  if (range && !/^bytes=\d*-\d*$/.test(range)) throw httpError(400, 'INVALID_RANGE', 'Range 格式無效');
  for (let i = 0; i < 5; i++) {
    const headers = new Headers({
      'User-Agent': endpoint.searchParams.get('profile') === 'app' ? APP_UA : WEB_UA,
      'Referer': target.hostname === 'hongguoduanju.com' ? SITE + '/' : 'https://novelquickapp.com/',
      'Accept': '*/*',
      'Accept-Encoding': 'identity'
    });
    if (range) headers.set('Range', range);
    const res = await fetch(target.href, { method: request.method, headers, redirect: 'manual', cache: 'no-store' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (!res.headers.get('location')) throw httpError(502, 'BAD_REDIRECT', '媒體跳轉缺少網址');
      target = safeUrl(new URL(res.headers.get('location'), target).href, [...MEDIA_HOSTS, ...API_HOSTS]);
      continue;
    }
    if (![200, 206].includes(res.status)) {
      // An upstream 403/429 is a media-access refusal, not a BVC2/WASM
      // decoder failure. Do not echo signed URLs, headers or response bodies.
      const code = res.status === 403 ? 'MEDIA_SOURCE_FORBIDDEN' :
        res.status === 429 ? 'MEDIA_RATE_LIMITED' : 'MEDIA_HTTP';
      const message = res.status === 403
        ? '媒體 CDN 拒絕存取（HTTP 403），並非影片解碼失敗'
        : res.status === 429
          ? '媒體 CDN 限制請求頻率（HTTP 429），請勿連續重試'
          : '媒體來源回傳 HTTP ' + res.status;
      throw httpError(res.status, code, message);
    }
    const type = String(res.headers.get('content-type') || '');
    if (/text\/html|application\/json/i.test(type)) throw httpError(502, 'NOT_MEDIA', '媒體來源回傳錯誤頁面');
    const out = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'])
      if (res.headers.has(key)) out.set(key, res.headers.get(key));
    return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers: out });
  }
  throw httpError(502, 'MEDIA_REDIRECT_LOOP', '媒體跳轉次數過多');
}
// CORS is only for the public GitHub Pages frontend and explicitly configured sites.
// Origin restrictions are not authentication: use Cloudflare rate limiting for abuse protection.
export function corsOrigin(origin, requestUrl, env = {}) {
  if (!origin) return null;
  const siteOrigin = new URL(requestUrl).origin;
  if (origin === siteOrigin || origin === 'https://ivanagyro.github.io') return origin;
  const extras = String(env.FRONTEND_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (extras.includes(origin)) return origin;
  const host = new URL(requestUrl).hostname;
  if (['localhost', '127.0.0.1'].includes(host) &&
      /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
  return null;
}
function withCors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // When hosted on GitHub Pages, this Worker handles API routes only.
    if (!url.pathname.startsWith('/api/'))
      return asJson({ error: { code: 'NOT_FOUND', message: '此 Worker 僅提供 /api/*' } }, 404);

    const origin = request.headers.get('Origin');
    const allowed = corsOrigin(origin, request.url, env);
    if (origin && !allowed)
      return asJson({ error: { code: 'CROSS_ORIGIN', message: '不接受此來源的請求' } }, 403);

    // GitHub Pages and Worker are separate origins, so browser preflight must succeed.
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers.get('Access-Control-Request-Method') || 'GET';
      const requestedHeaders = request.headers.get('Access-Control-Request-Headers') || '';
      if (!['GET', 'HEAD'].includes(requestedMethod) ||
          requestedHeaders.split(',').some(x => x.trim() && !['accept', 'range'].includes(x.trim().toLowerCase())))
        return withCors(asJson({ error: { code: 'CORS_PREFLIGHT', message: '不支援的預檢方法或標頭' } }, 403), allowed);
      const headers = new Headers({
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Range',
        'Access-Control-Max-Age': '86400'
      });
      if (allowed) {
        headers.set('Access-Control-Allow-Origin', allowed);
        headers.set('Vary', 'Origin');
      }
      return new Response(null, { status: 204, headers });
    }

    try {
      if (url.pathname === '/api/health') return withCors(asJson({
        ok: true, runtime: 'cloudflare-worker', sourceChannels: true
      }), allowed);
      if (request.method !== 'GET' && request.method !== 'HEAD')
        throw httpError(405, 'METHOD_NOT_ALLOWED', '不支援的 HTTP 方法');
      let response;
      if (url.pathname === '/api/series') {
        const parsed = parseInput(url.searchParams.get('input') || '');
        if (parsed.kind === 'media') response = asJson({ kind: 'direct', title: '直接媒體網址',
          total: 1, episodes: [{ vid: 'direct', index: 1, url: parsed.url }] });
        else response = asJson(await loadSeries(parsed.seriesId));
      } else if (url.pathname === '/api/source') {
        response = asJson(await loadSource(url.searchParams.get('sid') || '',
          url.searchParams.get('vid') || '', url.searchParams.get('codec') || 'auto',
          url.searchParams.get('quality') || 'auto',
          url.searchParams.get('channel') || 'auto'));
      } else if (url.pathname === '/api/media') {
        response = await relayMedia(request);
      } else throw httpError(404, 'NOT_FOUND', '不存在的 API');
      return withCors(response, allowed);
    } catch (error) {
      return withCors(asJson({ error: { code: String(error.code || 'UNEXPECTED'),
        message: String(error.message || '未知錯誤').slice(0, 300) } },
        Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502), allowed);
    }
  }
};
