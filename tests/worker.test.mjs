import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { safeUrl, parseInput, parseEpisodes, readRouterData, findPublicMedia, corsOrigin } from '../worker/worker.js';

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
test('worker is API-only and never depends on static asset binding', async () => {
  const response = await worker.fetch(new Request('https://site.example/'), {});
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});
test('GitHub Pages cross-origin CORS and preflight', async () => {
  const origin = 'https://ivanagyro.github.io';
  const options = await worker.fetch(new Request('https://example.workers.dev/api/media', {
    method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Range'
    }
  }), {});
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(options.headers.get('Access-Control-Allow-Headers'), /Range/);
  const health = await worker.fetch(new Request('https://example.workers.dev/api/health', {
    headers: { Origin: origin }
  }), {});
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('Access-Control-Allow-Origin'), origin);
  const bad = await worker.fetch(new Request('https://example.workers.dev/api/health', {
    headers: { Origin: 'https://attacker.example' }
  }), {});
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(corsOrigin('https://my.site', 'https://example.workers.dev/api/health',
    { FRONTEND_ORIGINS: 'https://my.site,https://other.site' }), 'https://my.site');
});


test('upstream media HTTP 403 is classified as CDN access refusal without leaking its URL', async () => {
  const native = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('403 forbidden', { status: 403 }); };
  try {
    const target = 'https://cdn.fqnovelvod.com/sample.mp4?auth=DO_NOT_LOG';
    const req = new Request('https://example.workers.dev/api/media?url=' + encodeURIComponent(target));
    const response = await worker.fetch(req, {});
    assert.equal(response.status, 403);
    const data = await response.json();
    assert.equal(data.error.code, 'MEDIA_SOURCE_FORBIDDEN');
    assert.match(data.error.message, /403/);
    assert.doesNotMatch(JSON.stringify(data), /DO_NOT_LOG|sample\.mp4/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = native; }
});

test('upstream HTTP 429 is classified as rate limiting without retrying in Worker', async () => {
  const native = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('rate limited', { status: 429 }); };
  try {
    const target = 'https://cdn.fqnovelvod.com/sample.mp4';
    const req = new Request('https://example.workers.dev/api/media?url=' + encodeURIComponent(target));
    const response = await worker.fetch(req, {});
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'MEDIA_RATE_LIMITED');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = native; }
});


test('source channel rejects invalid modes before upstream fetch', async () => {
  const api = 'https://example.workers.dev/api/source?sid=123&vid=456';
  const bad = await worker.fetch(new Request(api + '&channel=other'), {});
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_SOURCE_CHANNEL');
});


test('health advertises independent source channels for client compatibility gating', async () => {
  const response = await worker.fetch(new Request('https://example.workers.dev/api/health'), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sourceChannels, true);
});


test('quality and codec are ignored by /api/source, including legacy callers', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('<html><body>No public media</body></html>', {
      status: 200, headers: { 'Content-Type': 'text/html' }
    });
  };
  try {
    const api = 'https://example.workers.dev/api/source?sid=123&vid=456&channel=web';
    const fresh = await worker.fetch(new Request(api), {});
    const old = await worker.fetch(new Request(api + '&codec=not-a-codec&quality=unrecognized'), {});
    assert.equal(fresh.status, 404);
    assert.equal(old.status, 404);
    assert.equal((await fresh.json()).error.code, 'PUBLIC_SOURCE_UNAVAILABLE');
    assert.equal((await old.json()).error.code, 'PUBLIC_SOURCE_UNAVAILABLE');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('media proxy exposes upstream-header time on successful and failed requests', async () => {
  const native = globalThis.fetch;
  try {
    for (const status of [206, 520]) {
      globalThis.fetch = async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return new Response('fixture', { status, headers: { 'Content-Type': 'video/mp4' } });
      };
      const response = await worker.fetch(new Request('https://example.workers.dev/api/media?url=' +
        encodeURIComponent('https://cdn.fqnovelvod.com/sample.mp4?private=secret'), {
        headers: { Origin: 'https://ivanagyro.github.io', Range: 'bytes=0-6' }
      }), {});
      assert.equal(response.status, status);
      const timing = response.headers.get('Server-Timing');
      assert.match(timing, /^upstream;dur=\d+$/);
      assert(Number(timing.split('=')[1]) >= 10);
      assert.match(response.headers.get('Access-Control-Expose-Headers'), /Server-Timing/);
      assert.doesNotMatch(timing, /secret|sample|https/);
      await response.body.cancel();
    }
  } finally { globalThis.fetch = native; }
});
