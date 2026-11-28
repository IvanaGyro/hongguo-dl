import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../worker/worker.js';
import { parseSearchResponse, coverUrl, encodeCursor, decodeCursor, searchQuery, searchSeries } from '../../../worker/series-search.js';

const COVER = 'https://p3-reading-sign.fqnovelpic.com/novel-pic/8452549b2f3bdfd30b7a45811c4eb640~tplv-81nmtwyey9-superreso-aifit:600:0.heic?lk3s=ae45642e&x-expires=1&x-signature=x';
const video = (id, title, extra = {}) => ({ series_id: id, title, cover: COVER, episode_cnt: 80,
  video_detail: { series_id: Number(id), series_title: title, series_intro: '契約婚姻<b>開始</b>' }, ...extra });
const response = (cells, tab = {}) => ({ code: 0, search_tabs: [
  { tab_type: 1, data: [{ video_data: [video('1', 'novel tab')] }] },
  { tab_type: 11, has_more: true, next_offset: 6, search_id: '####11@2026', passback: 'pb', data: cells, ...tab }] });

test('search parses series from direct and embedded cells of the short-drama tab only', () => {
  const page = parseSearchResponse(response([
    { video_data: [video('7705731824265202712', '意外閃婚')] },
    { lynx_data: JSON.stringify({ cell_data: [{ video_data: [video('7656365136638135358', '與你盛夏'), video('7705731824265202712', 'dup')] }] }) },
    // A clip carries a series_id but no episode count: not a series.
    { video_data: video('7681308746932309017', '閃婚盛先生 片段', { episode_cnt: undefined, video_detail: {} }) },
  ]));
  assert.deepEqual(page.items.map(x => x.seriesId), ['7705731824265202712', '7656365136638135358']);
  assert.deepEqual(page.items[0], { seriesId: '7705731824265202712', title: '意外閃婚', episodes: 80, intro: '契約婚姻開始',
    cover: 'https://p3-novel.byteimg.com/novel-pic/8452549b2f3bdfd30b7a45811c4eb640~tplv-shrink:360:0.webp' });
  assert.deepEqual(page.next, { search_id: '####11@2026', passback: 'pb', next_offset: 6 });
  assert.equal(parseSearchResponse(response([], { has_more: false })).next, null);
});

test('an upstream token the cursor cannot carry ends paging instead of being truncated', () => {
  for (const tab of [{ passback: 'has space' }, { passback: '續' }, { passback: 'p'.repeat(1025) }, { search_id: 's'.repeat(257) }]) {
    const page = parseSearchResponse(response([], tab));
    assert.equal(page.hasMore, false, JSON.stringify(tab).slice(0, 40));
    assert.equal(page.next, null);
  }
  // Tokens at their limits, full of JSON-escaped characters, still round-trip.
  const page = parseSearchResponse(response([], { search_id: '"'.repeat(256), passback: '\\'.repeat(1024) }));
  assert.equal(page.hasMore, true);
  assert.deepEqual(decodeCursor(encodeCursor(page.next)), page.next);
});

test('search rejects business errors and changed formats', () => {
  assert.throws(() => parseSearchResponse({ code: 100103 }), { code: 'SEARCH_REJECTED' });
  assert.throws(() => parseSearchResponse({ code: 0 }), { code: 'SEARCH_FORMAT' });
  assert.throws(() => parseSearchResponse({ code: 0, search_tabs: [{ tab_type: 1, data: [] }] }), { code: 'SEARCH_FORMAT' });
});

test('covers come only from the official picture host, as public WebP', () => {
  assert.match(coverUrl(COVER), /^https:\/\/p3-novel\.byteimg\.com\/novel-pic\/8452549b2f3bdfd30b7a45811c4eb640~/);
  assert.equal(coverUrl('https://evil.example/novel-pic/8452549b2f3bdfd30b7a45811c4eb640'), null);
  assert.equal(coverUrl(''), null);
});

test('cursor round-trips and rejects tampered values', () => {
  const next = { search_id: '####11@2026', passback: 'p/b+=', next_offset: 26 };
  assert.deepEqual(decodeCursor(encodeCursor(next)), next);
  assert.throws(() => decodeCursor('not base64!'), { code: 'INVALID_CURSOR' });
  const forged = value => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.throws(() => decodeCursor(forged({ ...next, next_offset: -1 })), { code: 'INVALID_CURSOR' });
  assert.throws(() => decodeCursor(forged({ ...next, passback: 'a\nb' })), { code: 'INVALID_CURSOR' });
  assert.throws(() => decodeCursor(forged({ ...next, passback: 'a b' })), { code: 'INVALID_CURSOR' });
  // Nothing invalid is ever encoded in the first place.
  assert.equal(encodeCursor({ ...next, passback: 'a b' }), null);
});

test('query validation happens before any upstream request', () => {
  const q = s => searchQuery(new URLSearchParams(s));
  assert.deepEqual(q('q=%20閃婚%20'), { q: '閃婚', page: 1, cursor: null });
  assert.throws(() => q('q='), { code: 'INVALID_QUERY' });
  assert.throws(() => q('q=' + 'a'.repeat(81)), { code: 'INVALID_QUERY' });
  assert.throws(() => q('q=x&page=51'), { code: 'INVALID_PAGE' });
  assert.throws(() => q('q=x&page=2'), { code: 'INVALID_CURSOR' });
});

const installation = { identity: { device_id: '1234567890123', iid: '9876543210987', cdid: '0f9a2b3c-1d2e-4f5a-8b9c-0d1e2f3a4b5c', cookies: { a: 'b' } } };
test('search signs with the browser installation and passes the next page state back', async () => {
  let seen;
  const result = await searchSeries({ q: '閃婚', page: 2, cursor: { search_id: 's', passback: 'p', next_offset: 6 } }, installation, {
    requestJson: async (url, options) => { seen = { url: new URL(url), options }; return response([{ video_data: [video('42', 'A')] }]); } });
  assert.equal(seen.url.pathname, '/reading/bookapi/search/tab/v');
  assert.equal(seen.url.searchParams.get('query'), '閃婚');
  assert.equal(seen.url.searchParams.get('offset'), '6');
  assert.equal(seen.url.searchParams.get('search_id'), 's');
  assert.equal(seen.url.searchParams.get('device_id'), '1234567890123');
  assert.deepEqual(seen.options.jar, { a: 'b' });
  assert.ok(seen.options.headers['x-gorgon']);
  assert.equal(result.page, 2);
  assert.equal(result.hasMore, true);
  assert.deepEqual(decodeCursor(result.cursor), { search_id: '####11@2026', passback: 'pb', next_offset: 6 });
  await assert.rejects(searchSeries({ q: 'x', page: 1, cursor: null }, null), { code: 'DEVICE_REQUIRED', status: 409 });
});

test('an empty upstream 200 is reported like the source API reports it', async () => {
  const empty = Object.assign(new Error('App 接口返回空響應（HTTP 200）'), { code: 'EMPTY_RESPONSE', status: 200 });
  await assert.rejects(searchSeries({ q: 'x', page: 1, cursor: null }, installation, { requestJson: async () => { throw empty; } }),
    { code: 'EMPTY_RESPONSE', status: 502, upstreamStatus: 200, emptyResponseCount: 1 });
  const refused = Object.assign(new Error('App 片源請求失敗（HTTP 429）'), { status: 429, retryAfterMs: 5000 });
  const error = await searchSeries({ q: 'x', page: 1, cursor: null }, installation, { requestJson: async () => { throw refused; } })
    .catch(e => e);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 5000);
  assert.equal('emptyResponseCount' in error || 'upstreamStatus' in error, false);
});

test('/api/search needs a device and validates input without upstream fetch', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('unexpected fetch'); };
  try {
    const call = async path => { const r = await worker.fetch(new Request('https://w.example' + path), {}); return [r.status, (await r.json()).error.code]; };
    assert.deepEqual(await call('/api/search?q=x'), [409, 'DEVICE_REQUIRED']);
    assert.deepEqual(await call('/api/search?q='), [400, 'INVALID_QUERY']);
    assert.deepEqual(await call('/api/search?q=x&page=2&cursor=%21'), [400, 'INVALID_CURSOR']);
    const health = await (await worker.fetch(new Request('https://w.example/api/health'), {})).json();
    assert.equal(health.seriesSearch, true);
  } finally { globalThis.fetch = original; }
});
