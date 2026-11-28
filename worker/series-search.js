// SPDX-License-Identifier: GPL-3.0-only
// Series search through the App's native search tab (GET /reading/bookapi/search/tab/v),
// wrapped as GET /api/search?q=&page=[&cursor=] -> { items, page, hasMore, cursor }.
// Result-cell parsing follows N3urda/hongguoTV kotlin-tv/core/.../SearchPayload.kt.
import appModule from './vendor/app-source.js';

const DRAMA_TAB = 11;
const ID = /^\d{1,30}$/;
const MAX_QUERY = 80;
const MAX_PAGE = 50;
// Worst case: both tokens at their limits, every character JSON-escaped, then base64.
const MAX_CURSOR = 4096;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
const text = value => typeof value === 'string' ? value.trim()
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const stripTags = value => text(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// The App's covers are signed HEIC URLs that most browsers cannot decode. The
// same image ID is public as WebP on the official website's image host.
const COVER_ID = /^https:\/\/[a-z0-9-]+\.fqnovelpic\.com\/novel-pic\/([A-Za-z0-9_-]{8,128})(?:~|\?|$)/;
export function coverUrl(raw) {
  const id = COVER_ID.exec(text(raw))?.[1];
  return id ? 'https://p3-novel.byteimg.com/novel-pic/' + id + '~tplv-shrink:360:0.webp' : null;
}

function embeddedCells(cell) {
  let raw = cell?.lynx_data;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  return Array.isArray(raw?.cell_data) ? raw.cell_data : [];
}
function seriesFrom(video) {
  const detail = video?.video_detail && typeof video.video_detail === 'object' ? video.video_detail : {};
  // A bare string keeps the 19-digit ID exact; video_detail.series_id is a lossy JSON number.
  const id = text(video?.series_id);
  const episodes = Number(video?.episode_cnt ?? detail.episode_cnt);
  // Clips and commentary videos carry a series_id but no episode count.
  if (!ID.test(id) || !Number.isSafeInteger(episodes) || episodes <= 0) return null;
  const title = stripTags(video.series_name) || stripTags(detail.series_title) || stripTags(video.title);
  if (!title) return null;
  return { seriesId: id, title: title.slice(0, 200), cover: coverUrl(video.cover),
    intro: stripTags(detail.series_intro || video.series_intro).slice(0, 1000), episodes };
}

/** Parses one search/tab/v response into the short-drama tab's series and paging state. */
export function parseSearchResponse(data) {
  const code = Number(data?.code ?? data?.Code ?? -1);
  if (code !== 0) throw httpError(502, 'SEARCH_REJECTED', '搜尋服務暫不可用（錯誤碼 ' + (Number.isFinite(code) ? code : '?') + '）');
  const tabs = data.search_tabs ?? data.data?.search_tabs;
  if (!Array.isArray(tabs)) throw httpError(502, 'SEARCH_FORMAT', '搜尋資料格式已變更');
  const tab = tabs.find(entry => Number(entry?.tab_type) === DRAMA_TAB);
  if (!tab || !Array.isArray(tab.data)) throw httpError(502, 'SEARCH_FORMAT', '搜尋結果缺少短劇分頁');
  const items = [], seen = new Set();
  for (const cell of tab.data) {
    for (const row of [cell, ...embeddedCells(cell)]) {
      const videos = Array.isArray(row?.video_data) ? row.video_data : row?.video_data ? [row.video_data] : [];
      for (const video of videos) {
        const series = seriesFrom(video);
        if (series && !seen.has(series.seriesId)) { seen.add(series.seriesId); items.push(series); }
      }
    }
  }
  const hasMore = tab.has_more === true || tab.has_more === 1 || tab.has_more === '1' || tab.has_more === 'true';
  const nextOffset = Number(tab.next_offset);
  const next = { search_id: text(tab.search_id), passback: text(tab.passback), next_offset: nextOffset };
  // Opaque upstream tokens are never truncated: one the cursor cannot carry ends paging.
  return { items, hasMore: hasMore && validNext(next), next: hasMore && validNext(next) ? next : null };
}

const TOKEN = /^[\x21-\x7e]*$/;
function validNext(value) {
  return Boolean(value) && Number.isSafeInteger(value.next_offset) && value.next_offset >= 0 &&
    typeof value.search_id === 'string' && value.search_id.length <= 256 && TOKEN.test(value.search_id) &&
    typeof value.passback === 'string' && value.passback.length <= 1024 && TOKEN.test(value.passback);
}

// Upstream paging is by result cell offset plus a search session, not by fixed
// page size, so the next page's state travels back to the client opaquely.
// Validated tokens are printable ASCII, so their JSON is plain base64 input.
export function encodeCursor(next) {
  return next && validNext(next) ? btoa(JSON.stringify({ search_id: next.search_id, passback: next.passback,
    next_offset: next.next_offset })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
}
export function decodeCursor(raw) {
  if (!raw) return null;
  const invalid = () => httpError(400, 'INVALID_CURSOR', '搜尋分頁資料無效，請重新搜尋');
  if (raw.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let value;
  try { value = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))); } catch { throw invalid(); }
  if (!validNext(value)) throw invalid();
  return { search_id: value.search_id, passback: value.passback, next_offset: value.next_offset };
}

export function searchQuery(params) {
  const q = String(params.get('q') || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!q) throw httpError(400, 'INVALID_QUERY', '請輸入要搜尋的劇名');
  if ([...q].length > MAX_QUERY) throw httpError(400, 'INVALID_QUERY', '搜尋字詞最多 ' + MAX_QUERY + ' 字');
  const rawPage = params.get('page') || '1';
  const page = /^\d{1,2}$/.test(rawPage) ? Number(rawPage) : NaN;
  if (!(page >= 1 && page <= MAX_PAGE)) throw httpError(400, 'INVALID_PAGE', '頁碼需為 1 至 ' + MAX_PAGE);
  const cursor = decodeCursor(params.get('cursor') || '');
  if (page > 1 && !cursor) throw httpError(400, 'INVALID_CURSOR', '第 2 頁之後需要上一頁的分頁資料');
  return { q, page, cursor };
}

/** Runs one search request for a registered browser installation session. */
export async function searchSeries({ q, page, cursor }, session, { requestJson = appModule.requestJson } = {}) {
  if (!session?.identity?.device_id) throw httpError(409, 'DEVICE_REQUIRED', '請先初始化播放裝置');
  const { identity } = session;
  const signed = appModule.signedSearchRequest({ keyword: q, page, cursor, identity });
  let data;
  try {
    data = await requestJson(signed.url, { headers: signed.headers, jar: identity.cookies }, Date.now() + 10000);
  } catch (error) {
    throw Object.assign(httpError(error.status >= 400 ? error.status : 502, error.code || 'SEARCH_UNAVAILABLE',
      String(error.message || '搜尋失敗').slice(0, 250)),
    { retryAfterMs: error.retryAfterMs,
      ...(error.code === 'EMPTY_RESPONSE' ? { upstreamStatus: 200, emptyResponseCount: 1 } : {}) });
  }
  const { items, hasMore, next } = parseSearchResponse(data);
  return { items, page, hasMore: hasMore && page < MAX_PAGE, cursor: page < MAX_PAGE ? encodeCursor(next) : null };
}
