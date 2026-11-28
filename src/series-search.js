// SPDX-License-Identifier: GPL-3.0-only
// Series search by title: input classification, /api/search routes and result cards.

// Only an explicit scheme marks a URL (the Worker requires one too), so dotted
// titles such as "No.1" or "S.H.E" stay searches.
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** True when lookup input is a title keyword rather than an ID, ID list or URL. */
export function isSearchKeyword(input) {
  const text = String(input || '').trim();
  if (!text || /^\d+(?:[\s,;，、]+\d+)*$/.test(text)) return false;
  return !URL_LIKE.test(text);
}

export function searchRoute(query, page = 1, cursor = null) {
  const params = new URLSearchParams({ q: query });
  if (page > 1) { params.set('page', String(page)); params.set('cursor', cursor || ''); }
  return '/api/search?' + params;
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Only the official public image host may supply a cover.
const safeCover = value => typeof value === 'string' &&
  /^https:\/\/p3-novel\.byteimg\.com\/novel-pic\/[A-Za-z0-9_~:.-]+$/.test(value) ? value : null;

/** One clickable card per series: cover, title, episode count and intro. */
export function searchCardsHtml(items) {
  return items.map(item => {
    const cover = safeCover(item.cover);
    return '<li><button type="button" class="search-card" data-search-id="' + escape(item.seriesId) + '">' +
      '<span class="search-cover">' + (cover
        ? '<img src="' + escape(cover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
        : '') + '</span>' +
      '<span class="search-text"><span class="search-title">' + escape(item.title) + '</span>' +
      (Number.isSafeInteger(item.episodes) && item.episodes > 0
        ? '<span class="search-meta">全 ' + item.episodes + ' 集</span>' : '') +
      (item.intro ? '<span class="search-intro">' + escape(item.intro) + '</span>' : '') +
      '</span></button></li>';
  }).join('');
}

/** Appends a page to accumulated results without repeating a series. */
export function mergeSearchItems(current, incoming) {
  const seen = new Set(current.map(item => item.seriesId));
  return [...current, ...incoming.filter(item => !seen.has(item.seriesId) && seen.add(item.seriesId))];
}
