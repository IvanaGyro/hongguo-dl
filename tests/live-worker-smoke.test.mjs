import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveSmoke } from '../scripts/live-worker-smoke.mjs';

const sid = '7699513062054710296';
const cors = { 'access-control-allow-origin': 'https://ivanagyro.github.io' };
const vids = Array.from({ length: 60 }, (_, i) => ({
  vid: String(7699522762213182488n + BigInt(i)), index: i + 1, available: i < 5
}));
const variants = [
  { codec: 'hevc', quality: '1080p', source: 'app', url: 'https://cdn1.example/stream?secret=PRIVATE' },
  { codec: 'hevc', quality: '1080p', source: 'app', url: 'https://cdn2.example/stream?secret=PRIVATE' },
  { codec: 'bytevc2', quality: '720p', source: 'app', url: 'https://cdn3.example/stream' }
];
function responder({ firstMedia = 403, secondMedia = 206 } = {}) {
  const paths = [];
  async function fetchImpl(input, opts) {
    const url = new URL(String(input));
    const path = url.pathname;
    paths.push({ path, headers: opts.headers });
    if (path === '/api/series') {
      assert.equal(url.searchParams.get('input'), sid);
      return Response.json({ kind: 'series', seriesId: sid, title: 'nova：新星',
        total: 60, episodes: vids }, { headers: cors });
    }
    if (path === '/api/source') {
      assert.equal(url.searchParams.get('sid'), sid);
      return Response.json({ variants }, { headers: cors });
    }
    assert.equal(path, '/api/media');
    assert.equal(opts.headers.Range, 'bytes=0-255');
    const upstream = new URL(url.searchParams.get('url'));
    const status = upstream.hostname === 'cdn1.example' ? firstMedia : secondMedia;
    if (status !== 206) return Response.json({ error: { code: 'MEDIA_HTTP' } },
      { status, headers: cors });
    return new Response(new Uint8Array(256), { status: 206, headers: {
      ...cors, 'content-type': 'video/mp4',
      'content-range': 'bytes 0-255/8000000', 'content-length': '256',
      'access-control-expose-headers': 'Content-Length, Content-Range'
    } });
  }
  return { fetchImpl, paths };
}

test('60 listed episodes cause only one source lookup and at most two 256-byte media probes', async () => {
  const mock = responder();
  const lines = [];
  const result = await runLiveSmoke({ fetchImpl: mock.fetchImpl, log: x => lines.push(x) });
  assert.equal(result.totalEpisodes, 60);
  assert.equal(result.checkedEpisodes, 1);
  assert.equal(result.requestCount, 4);
  assert.equal(result.requestBudget, 4);
  assert.deepEqual(mock.paths.map(x => x.path),
    ['/api/series', '/api/source', '/api/media', '/api/media']);
  assert.deepEqual(result.results[0].probes.map(x => x.status), [403, 206]);
  assert.ok(!lines.join('\n').includes('PRIVATE'), 'Never print signed source URLs');
});

test('explicit 2-episode mode has a seven-request maximum without testing 60 videos', async () => {
  const mock = responder({ firstMedia: 206 });
  const result = await runLiveSmoke({ fetchImpl: mock.fetchImpl, episodeCount: 2, log: () => {} });
  assert.equal(result.checkedEpisodes, 2);
  assert.equal(result.requestBudget, 7);
  assert.equal(result.requestCount, 5); // 1 series + 2 source + 2 media
});

test('refuses episode-count values above 2 before contacting Worker', async () => {
  const mock = responder();
  await assert.rejects(runLiveSmoke({ fetchImpl: mock.fetchImpl, episodeCount: 60 }),
    /only 1 or 2 episodes/);
  assert.equal(mock.paths.length, 0);
});

test('HTTP 429 immediately stops without probing an alternate CDN', async () => {
  const mock = responder({ firstMedia: 429 });
  await assert.rejects(runLiveSmoke({ fetchImpl: mock.fetchImpl, log: () => {} }),
    /rate limited/);
  assert.deepEqual(mock.paths.map(x => x.path),
    ['/api/series', '/api/source', '/api/media']);
});

test('missing partial-content support fails without downloading a whole video', async () => {
  const mock = responder({ firstMedia: 200, secondMedia: 403 });
  await assert.rejects(runLiveSmoke({ fetchImpl: mock.fetchImpl, log: () => {} }),
    /no CDN returned a valid 206/);
  assert.equal(mock.paths.length, 4);
});
