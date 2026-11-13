// Synthetic CENC: downloaded bytes outlive remux generations and MSE eviction.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
const input = readFileSync(process.argv[2]);
const name = process.env.CENC_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const browser = await (name === 'firefox' ? firefox : chromium).launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  window.__mseUrls = { created: 0, revoked: 0 };
  URL.createObjectURL = object => {
    if (object instanceof MediaSource) window.__mseUrls.created++;
    return create(object);
  };
  URL.revokeObjectURL = url => { window.__mseUrls.revoked++; revoke(url); };
});
await context.route(url => url.pathname.startsWith('/api/'), async route => {
  const url = new URL(route.request().url());
  const json = body => route.fulfill({ json: body });
  if (url.pathname === '/api/health') return json({ ok: true });
  if (url.pathname === '/api/series') return json({ kind: 'series', seriesId: '123456789',
    title: 'CENC sparse cache fixture', total: 1, accessible: 1,
    episodes: [{ index: 1, vid: '111111111', available: true }] });
  if (url.pathname === '/api/source') return json({ variants: [{ codec: 'h264', quality: '720p',
    source: 'app', url: 'https://cdn.fqnovelvod.com/cache.mp4',
    contentKey: '00112233445566778899aabbccddeeff', width: 480, height: 270 }] });
  assert.equal(url.pathname, '/api/media');
  const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  assert(match, 'Media must use offset-aware HTTP');
  const first = Number(match[1]);
  const last = match[2] ? Number(match[2]) : input.length - 1;
  requests.push([first, last]);
  // Native fetch supplies bounded chunks even though this route has one body.
  await route.fulfill({ status: 206, contentType: 'video/mp4', headers: {
    'Content-Range': `bytes ${first}-${last}/${input.length}`, 'Content-Length': String(last - first + 1)
  }, body: input.subarray(first, last + 1) });
});
try {
  await page.goto('http://127.0.0.1:4173/hongguo-dl/?id=123456789');
  await page.waitForFunction(() => document.querySelector('#series-title')?.textContent?.includes('sparse cache'));
  await page.locator('#mode-play').click();
  await page.locator('#episodes button.play-episode').first().click();
  await page.waitForFunction(() => {
    const video = document.querySelector('#player-video');
    return video?.currentTime > 0.5 && /phase=media.cache.*complete=true/.test(
      document.querySelector('#playback-log')?.value || '');
  }, null, { timeout: 60000 });
  const initial = await page.evaluate(() => ({ urls: window.__mseUrls,
    buffered: Array.from(document.querySelector('#player-video').buffered, () => 0) }));
  const before = requests.length;
  for (const target of [170, 5, 160, 20]) {
    await page.evaluate(time => { document.querySelector('#player-video').currentTime = time; }, target);
    await page.waitForFunction(time => {
      const v = document.querySelector('#player-video');
      return v.currentTime >= time && v.currentTime < time + 4 && v.readyState >= 2 && !v.paused;
    }, target, { timeout: 20000 });
    await page.waitForTimeout(250);
    assert.equal(requests.length, before, 'Fully downloaded target triggered another CDN request');
    assert.deepEqual(await page.evaluate(() => window.__mseUrls), initial.urls,
      'Seek recreated MediaSource or revoked its URL');
  }
  const log = await page.locator('#playback-log').inputValue();
  assert.match(log, /media.remote-seek.ready.*workerReused=true/);
  assert.match(log, /bufferedRanges=\[\[/);
  assert.match(log, /byteRanges=\[\[/);
  assert.equal((log.match(/phase=wasm-start/g) || []).length, 1);
  assert.equal(errors.length, 0, errors.join('; '));
  // Close/reopen three times: episode-scoped cache/worker must still be freed.
  for (let i = 0; i < 3; i++) {
    await page.locator('#mode-download').click();
    await page.waitForTimeout(100);
    const state = await page.evaluate(() => window.__mseUrls);
    assert.equal(state.created, state.revoked);
    await page.locator('#mode-play').click();
    await page.locator('#episodes button.play-episode').first().click();
    await page.waitForFunction(() => document.querySelector('#player-video')?.readyState >= 2,
      null, { timeout: 30000 });
  }
  console.log('PASS ' + name + ' cached forward/back seeks reuse one Worker/WASM/MSE without HTTP; mode teardown releases URLs');
} catch (error) {
  console.error(await page.locator('#playback-log').inputValue().catch(() => 'No log'));
  throw error;
} finally { await browser.close(); }
