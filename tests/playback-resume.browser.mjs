// Public user flows: form submit, per-series history, reload, and natural EOF.
// Synthetic unencrypted media only; no live source API/CDN requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const short = readFileSync(process.argv[2]), long = readFileSync(process.argv[3]);
const app = process.env.TEST_APP_URL || 'http://127.0.0.1:4173/hongguo-dl/';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  // Synthetic API routes must stay on the test origin, independent of local .env.
  localStorage.setItem('hongguo-dl-worker-origin-v1', location.origin);
  window.__HONGGUO_START_MODE = 'download';
  window.__naturalEnds = [];
  document.addEventListener('ended', event => {
    if (event.target.id === 'player-video') window.__naturalEnds.push({ trusted: event.isTrusted,
      episode: document.querySelector('#player-episode')?.textContent });
  }, true);
});
await page.route(url => url.pathname.startsWith('/api/'), async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/health') return route.fulfill({ json: { ok: true, sourceChannels: false } });
  if (url.pathname === '/api/series') {
    const sid = url.searchParams.get('input');
    return route.fulfill({ json: { kind: 'series', seriesId: sid, title: 'Resume series ' + sid, total: 2,
      episodes: [{ vid: '401', index: 1, available: true }, { vid: '402', index: 2, available: true }] } });
  }
  if (url.pathname === '/api/source') return route.fulfill({ json: { variants: [{ source: 'app', codec: 'h264', quality: '720p',
    url: `https://cdn.fqnovelvod.com/series-${url.searchParams.get('sid')}-${url.searchParams.get('vid')}.mp4` }] } });
  if (url.pathname === '/api/media') return media(route, new URL(url.searchParams.get('url')).pathname);
  throw new Error('Unexpected API route');
});
await page.route('https://cdn.fqnovelvod.com/**', route => media(route, new URL(route.request().url()).pathname));
async function media(route, path) {
  const bytes = path.endsWith('-401.mp4') ? short : long;
  const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  const first = match ? Number(match[1]) : 0, last = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
  return route.fulfill({ status: match ? 206 : 200, contentType: 'video/mp4', headers: {
    'Accept-Ranges': 'bytes', 'Content-Length': String(last - first + 1), 'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Range,Content-Length',
    ...(match ? { 'Content-Range': `bytes ${first}-${last}/${bytes.length}` } : {})
  }, body: bytes.subarray(first, last + 1) });
}
async function playing(episode, minimum = 0.1, maximum = 100) {
  await page.waitForFunction(({ episode, minimum, maximum }) => {
    const video = document.querySelector('#player-video');
    return document.querySelector('#player-episode')?.textContent.includes('第 ' + episode + ' 集') &&
      video.currentTime > minimum && video.currentTime < maximum && video.videoWidth > 0 && !video.paused && !video.error;
  }, { episode, minimum, maximum });
}
async function submit(sid) {
  await page.locator('#input-url').fill(sid); await page.locator('#lookup-button').click();
  await page.waitForFunction(sid => document.querySelector('#series-title')?.textContent === 'Resume series ' + sid, sid);
  assert.equal(await page.locator('#mode-play').getAttribute('aria-pressed'), 'true');
}
try {
  await page.goto(app);
  await submit('42'); await playing(1, 0.1, 2);
  await page.locator('[data-play-vid="402"]').click(); await playing(2);
  await page.locator('#player-video').evaluate(video => { video.currentTime = 30; });
  await playing(2, 29.8, 32);
  await page.locator('#player-video').evaluate(video => video.pause());
  await page.reload();
  await page.locator('[data-recent-id="42"]').click(); await playing(2, 29.8, 33);
  await page.locator('#player-video').evaluate(video => video.pause());
  await submit('43'); await playing(1, 0.1, 2);
  await page.locator('[data-recent-id="42"]').click(); await playing(2, 29.8, 33);
  await page.locator('[data-play-vid="401"]').click(); await playing(1, 0.1, 2);
  await page.locator('#player-video').evaluate(video => { video.playbackRate = 4; });
  // Wait for a genuine browser EOF, without seeking to the ending or dispatching ended.
  await playing(2, 0.1, 2);
  assert(await page.evaluate(() => window.__naturalEnds.some(event => event.trusted && event.episode.includes('第 1 集'))));
  await page.locator('#player-video').evaluate(video => video.pause());
  await page.reload();
  await page.locator('[data-recent-id="42"]').click(); await playing(2, 0.1, 2);
  assert.deepEqual(errors, []);
  console.log('PASS: form submit autoplays, per-series position survives reload, manual selection resumes, natural next episode ignores old position');
} catch (error) {
  console.error(await page.locator('#playback-log').inputValue().catch(() => 'No diagnostics'));
  throw error;
} finally { await browser.close(); }
