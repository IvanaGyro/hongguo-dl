// A late cancellation of episode 1 must never tear down healthy episode 2.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
const bytes = readFileSync(process.argv[2]);
const name = process.env.CENC_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const browser = await (name === 'firefox' ? firefox : chromium).launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(() => localStorage.setItem('hongguo-dl-player-preferences-v1',
  JSON.stringify({ quality: 'auto', codec: 'auto', autoNext: false })));
await page.route(url => url.pathname.includes('/bvc2/'), async route => {
  await new Promise(resolve => setTimeout(resolve, 3000));
  await route.fulfill({ status: 404, body: 'Delayed BVC2 capability check' });
});
await page.route(url => url.pathname.startsWith('/api/'), async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/health') return route.fulfill({ json: { ok: true } });
  if (url.pathname === '/api/series') return route.fulfill({ json: { kind: 'series', seriesId: '42',
    title: 'Cancellation regression', total: 2, accessible: 2,
    episodes: [{ vid: '1000', index: 1, available: true }, { vid: '1001', index: 2, available: true }] } });
  if (url.pathname === '/api/source') return route.fulfill({ json: { variants: [{
    quality: '720p', codec: url.searchParams.get('vid') === '1000' ? 'bytevc2' : 'h264',
    source: 'app', url: 'https://cdn.fqnovelvod.com/synthetic.mp4',
    contentKey: '00112233445566778899aabbccddeeff' }] } });
  assert.equal(url.pathname, '/api/media');
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  assert(range);
  const first = Number(range[1]), last = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return route.fulfill({ status: 206, contentType: 'video/mp4', headers: {
    'Content-Range': `bytes ${first}-${last}/${bytes.length}`, 'Content-Length': String(last - first + 1)
  }, body: bytes.subarray(first, last + 1) });
});
try {
  await page.goto('http://127.0.0.1:4173/hongguo-dl/?id=42');
  await page.waitForFunction(() => document.querySelector('#series-title')?.textContent?.includes('Cancellation'));
  await page.locator('#mode-play').click();
  await page.waitForFunction(() => document.querySelector('#player-status')?.textContent?.includes('檢查 ByteVC2'));
  await page.locator('[data-play-vid="1001"]').click();
  await page.waitForFunction(() => document.querySelector('#player-video')?.currentTime > 0.5,
    null, { timeout: 20000 });
  const before = await page.locator('#player-video').evaluate(v => v.currentTime);
  await page.waitForTimeout(3500);
  const after = await page.locator('#player-video').evaluate(v => ({ time: v.currentTime, error: v.error?.code, width: v.videoWidth }));
  assert(after.time > before + 2 && after.width === 480 && !after.error,
    'Canceled prior episode destroyed its successor: ' + JSON.stringify(after));
  const log = await page.locator('#playback-log').inputValue();
  assert.doesNotMatch(log, /playback.attempt.failed code=CANCELED/);
  console.log('PASS ' + name + ' delayed canceled ByteVC2 episode cannot clear healthy CENC playback');
} finally { await browser.close(); }
