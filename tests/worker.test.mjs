import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { safeUrl, parseInput, parseEpisodes, readRouterData, findPublicMedia } from '../worker/worker.js';

const data = detail => '<script>window._ROUTER_DATA = ' + JSON.stringify({
  loaderData: { 'player_(series_id)/page': { seriesDetail: detail } }
}) + ';</script>';

test('only official URLs and digits are accepted', () => {
  assert.deepEqual(parseInput('123456789'), { kind: 'series', seriesId: '123456789' });
  assert.deepEqual(parseInput('https://hongguoduanju.com/detail?series_id=123456789'),
    { kind: 'series', seriesId: '123456789' });
  assert.equal(parseInput('https://cdn.fqnovelvod.com/video.mp4').kind, 'media');
  assert.throws(() => parseInput('https://evil.example/?series_id=123456789'), { code: 'HOST_NOT_ALLOWED' });
  assert.throws(() => parseInput('file:///etc/passwd'), { code: 'INVALID_INPUT' });
  assert.throws(() => safeUrl('https://127.0.0.1/private', ['fqnovelvod.com']), { code: 'HOST_NOT_ALLOWED' });
  assert.throws(() => safeUrl('https://fqnovelvod.com.evil.example/video', ['fqnovelvod.com']), { code: 'HOST_NOT_ALLOWED' });
});
test('embedded router JSON is parsed as data, not executable JavaScript', () => {
  const html = data({ series_id: '123', series_name: '短劇', vid_list: ['111','222'], accessible_episode_cnt: 1 });
  assert.equal(readRouterData(html).loaderData['player_(series_id)/page'].seriesDetail.series_name, '短劇');
  const episodes = parseEpisodes(html, '123');
  assert.equal(episodes.total, 2);
  assert.deepEqual(episodes.episodes.map(ep => ep.available), [true, false]);
  assert.throws(() => parseEpisodes(html, '456'), { code: 'INVALID_SERIES' });
});
test('unrelated recommendations cannot supply a video URL', () => {
  const html = '<script>window._ROUTER_DATA = ' + JSON.stringify({
    loaderData: { 'player_(series_id)/(vid)/page': {
      series_id: '123', vid: '456', seriesDetail: { series_id: '123' },
      publicVideoSeo: { available: true, itemId: '456', seriesId: '123' }
    }}
  }) + '</script>' +
    '<script type="application/ld+json">' + JSON.stringify({
      '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/123/999',
      contentUrl: 'https://cdn.fqnovelvod.com/other.mp4'
    }) + '</script>';
  assert.equal(findPublicMedia(html, '123', '456'), null);
});
test('public API rejects non-whitelisted media before network fetch', async () => {
  const request = new Request('https://site.example/api/media?url=' +
    encodeURIComponent('https://attacker.example/private'));
  const response = await worker.fetch(request, { ASSETS: { fetch: () => new Response('static') } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'HOST_NOT_ALLOWED');
});
test('worker serves static assets outside api', async () => {
  const response = await worker.fetch(new Request('https://site.example/'), {
    ASSETS: { fetch: () => new Response('index') }
  });
  assert.equal(await response.text(), 'index');
});
