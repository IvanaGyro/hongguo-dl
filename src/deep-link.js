// URL parameters are public shareable series IDs, not trusted media URLs.
// Supports ?id=123, ?id=123&id=456, ?id=123,456, and ?ids=123,456.
export function idsFromUrl(input, max = 20) {
  const url = typeof input === 'string' ? new URL(input, 'https://example.invalid/') : input;
  const params = url.searchParams;
  const values = [...params.getAll('id'), ...params.getAll('ids'), ...params.getAll('series_id')];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    for (const part of String(value).split(/[\s,;，、]+/)) {
      if (!/^\d{1,30}$/.test(part) || seen.has(part)) continue;
      out.push(part);
      seen.add(part);
      if (out.length >= max) return out;
    }
  }
  return out;
}
export function urlForSeriesIds(currentUrl, ids) {
  const url = new URL(currentUrl);
  url.searchParams.delete('id');
  url.searchParams.delete('ids');
  url.searchParams.delete('series_id');
  for (const id of ids) {
    if (/^\d{1,30}$/.test(String(id))) url.searchParams.append('id', String(id));
  }
  return url.href;
}
