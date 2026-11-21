// Production worker/runtime and real decoded frames across episode 13 -> 14.
// Synthetic encrypted media only; no CDN or Hongguo API access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
const bytes = readFileSync(process.argv[2]);
const bvc2 = process.env.PRELOAD_BRIDGE === 'bvc2';
const manual = process.env.PRELOAD_HANDOFF === 'manual';
const name = process.env.CENC_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const browser = await (name === 'firefox' ? firefox : chromium).launch({ headless: true,
  ...(name === 'chromium' && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(name === 'firefox' ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } } : {}) });
const page = await browser.newPage();
const requests = [], sourceCalls = [], errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  // Synthetic API routes must stay on the test origin, independent of local .env.
  localStorage.setItem('hongguo-dl-worker-origin-v1', location.origin);
  window.__HONGGUO_START_MODE = 'download';
  localStorage.setItem('hongguo-dl-series-playback-v1', JSON.stringify({
    '42': { vid: '1013', seconds: 0, completed: false, viewedAt: Date.now() }
  }));
  localStorage.setItem('hongguo-dl-playback-history-v1', JSON.stringify({
    '42:1014': { seconds: 4, duration: 8, completed: false, viewedAt: Date.now() }
  }));
  // Directly rendered ByteVC2 draws on a canvas over an audio-only <video>.
  const canvas = () => { const c = document.querySelector('.bvc2-frame-canvas'); return c && !c.hidden ? c : null; };
  const video = () => document.querySelector('#player-video');
  window.__frames = () => canvas()?.renderedFrames ?? video().getVideoPlaybackQuality().totalVideoFrames;
  window.__width = () => canvas()?.width ?? video().videoWidth;
});
await page.route(url => url.pathname.startsWith('/api/'), async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/health') return route.fulfill({ json: { ok: true } });
  if (url.pathname === '/api/series') return route.fulfill({ json: {
    kind: 'series', seriesId: '42', title: 'Stream preload regression', total: 2, accessible: 2,
    episodes: [{ vid: '1013', index: 13, available: true }, { vid: '1014', index: 14, available: true }] } });
  if (url.pathname === '/api/source') {
    const vid = url.searchParams.get('vid'); sourceCalls.push(vid);
    return route.fulfill({ json: { variants: [{ quality: '720p', codec: bvc2 ? 'bytevc2' : 'h264', source: 'app',
      url: 'https://cdn.fqnovelvod.com/' + vid + '.mp4', contentKey: bvc2 ? null : '00112233445566778899aabbccddeeff' }] } });
  }
  assert.equal(url.pathname, '/api/media');
  const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  assert(match);
  const first = Number(match[1]), last = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
  requests.push({ vid: /1014/.test(url.searchParams.get('url')) ? '1014' : '1013', first, last });
  return route.fulfill({ status: 206, contentType: 'video/mp4', headers: {
    'Content-Range': `bytes ${first}-${last}/${bytes.length}`, 'Content-Length': String(last - first + 1)
  }, body: bytes.subarray(first, last + 1) });
});
try {
  await page.goto((process.env.TEST_APP_URL || 'http://127.0.0.1:4173/hongguo-dl/') + '?id=42');
  await page.waitForFunction(() => document.querySelector('#series-title')?.textContent.includes('Stream preload'));
  await page.locator('#mode-play').click();
  await page.locator('[data-play-vid="1013"]').click();
  await page.waitForFunction(() => /prefetch.stage episode=14 phase=preload.buffer[^\n]*ready=true/
    .test(document.querySelector('#playback-log').value), null, { timeout: 25000 });
  const before = await page.locator('#playback-log').inputValue();
  assert(before.indexOf('phase=mse.done') >= 0 && before.indexOf('phase=processing.started') >= 0 &&
    before.indexOf('phase=mse.done') < before.indexOf('phase=processing.started'),
    'Next processing must follow current processing completion');
  assert(!before.includes('playback.open episode=14'), 'Media must be preloaded before switching');
  assert(requests.some(r => r.vid === '1014'), 'Next episode must fetch actual bytes');
  const beforeRequests = requests.filter(r => r.vid === '1014').length;
  if (manual) await page.locator('[data-play-vid="1014"]').click();
  await page.waitForFunction(() => document.querySelector('#player-episode')?.textContent.includes('第 14 集') &&
    document.querySelector('#player-video').currentTime > 0.5 && window.__frames() > 2, null, { timeout: 25000 });
  const state = await page.locator('#player-video').evaluate(v => ({ time: v.currentTime,
    width: window.__width(), frames: window.__frames(), error: v.error?.code }));
  assert(state.width === (bvc2 ? 160 : 480) && state.frames > 0 && !state.error, JSON.stringify(state));
  const after = await page.locator('#playback-log').inputValue();
  assert.match(after, /prefetch.handoff episode=14 media=true/);
  if (bvc2 && await page.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2'))))
    assert.match(after, /playback.media.selected codec=bytevc2 path=bvc2-render/,
      'ByteVC2 must render decoded pictures directly when WebGL2 exists');
  assert(state.time >= (manual ? 4 : 0) && state.time < (manual ? 6 : 2),
    'Manual handoff restores history; natural next episode starts at zero: ' + JSON.stringify(state));
  assert.equal(sourceCalls.filter(v => v === '1014').length, 1, 'Handoff must reuse the source list');
  assert.equal(requests.filter(r => r.vid === '1014').length, beforeRequests, 'Handoff must not refetch cached media');
  assert.equal((after.match(/prefetch.stage episode=14 phase=wasm-start/g) || []).length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS ' + name + ' ' + (bvc2 ? 'ByteVC2' : 'CENC') + ' real episode 13 -> 14 preload, serialized processing and cached worker handoff', JSON.stringify(state));
} catch (error) {
  console.error(await page.locator('#playback-log').inputValue().catch(() => 'No diagnostics'));
  throw error;
} finally { await browser.close(); }
