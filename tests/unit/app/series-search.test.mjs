import test from 'node:test';
import assert from 'node:assert/strict';
import { isSearchKeyword, searchRoute, searchCardsHtml, mergeSearchItems } from '../../../src/series-search.js';

test('only titles go to search; IDs, ID lists and URLs keep the series lookup', () => {
  for (const input of ['閃婚老公大十歲', 'BFLC', '總裁 第二季', 'love 2', 'No.1', 'v2.0', 'S.H.E', 'Mr.Big'])
    assert.equal(isSearchKeyword(input), true, input);
  for (const input of ['', '7709512254240066584', '1, 2，3', 'https://hongguoduanju.com/detail?series_id=1',
    'HTTPS://cdn.example/a.mp4', 'http://example.com'])
    assert.equal(isSearchKeyword(input), false, input);
});

test('search routes carry the cursor only after the first page', () => {
  assert.equal(searchRoute('閃婚'), '/api/search?q=%E9%96%83%E5%A9%9A');
  assert.equal(searchRoute('a b', 2, 'abc_-'), '/api/search?q=a+b&page=2&cursor=abc_-');
});

test('cards show cover, title, episode count and intro, escaped', () => {
  const html = searchCardsHtml([{ seriesId: '42', title: '<b>劇</b>', intro: 'a"b', episodes: 80,
    cover: 'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:360:0.webp' }]);
  assert.match(html, /data-search-id="42"/);
  assert.match(html, /<img src="https:\/\/p3-novel\.byteimg\.com\/novel-pic\/abc~tplv-shrink:360:0\.webp" alt=""/);
  assert.match(html, /&lt;b&gt;劇&lt;\/b&gt;/);
  assert.match(html, /全 80 集/);
  assert.match(html, /a&quot;b/);
  // A cover from any other host is dropped, the card still renders.
  const other = searchCardsHtml([{ seriesId: '1', title: 't', cover: 'https://evil.example/x.webp" onerror="x' }]);
  assert.doesNotMatch(other, /<img/);
});

test('later pages never repeat a series', () => {
  assert.deepEqual(mergeSearchItems([{ seriesId: '1' }], [{ seriesId: '1' }, { seriesId: '2' }, { seriesId: '2' }])
    .map(x => x.seriesId), ['1', '2']);
});
