// SPDX-License-Identifier: GPL-3.0-only
// Browser acceptance using synthetic bvc2/bv2C framing around VVC testsrc2.
// Never contacts the real Hongguo service or uses proprietary BTY2 media.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
const shortInput = readFileSync(process.argv[2]);
const longInput = readFileSync(process.argv[3]);
assert(longInput.length > 512 * 1024, 'Long media must exceed two 256 KiB Range windows');
const whole = process.env.BVC2_TEST_WHOLE === '1';
let input = whole ? shortInput : longInput;
let denied = 0, firstFrameBytes = null, deliveredAtFirstFrame = null;
const browserName = process.env.BVC2_BROWSER || 'chromium';
const browser = await (browserName === 'firefox' ? firefox : chromium).launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [], reads = [];
let deliveredBytes = 0;
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem('hongguo-dl-player-preferences-v1', JSON.stringify({ quality: '720p', codec: 'hevc', autoNext: false }));
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  const live = new Set(); window.__activeMse = 0;
  URL.createObjectURL = value => {
    const url = create(value);
    if (value instanceof MediaSource) { live.add(url); window.__activeMse = live.size; }
    return url;
  };
  URL.revokeObjectURL = url => { live.delete(url); window.__activeMse = live.size; revoke(url); };
});
await context.route(url => url.pathname.startsWith('/api/'), async route => {
  const url = new URL(route.request().url());
  const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/health') return json({ ok: true, sourceChannels: false });
  if (url.pathname === '/api/series') return json({ kind: 'series', seriesId: '123456789',
    title: 'Synthetic ByteVC2 framing', total: 1, accessible: 1,
    episodes: [{ index: 1, vid: '111111111', available: true }] });
  if (url.pathname === '/api/source') return json({ variants: ['denied', 'alternate'].map(host => ({
    codec: 'bytevc2', quality: '720p', source: 'app',
    url: 'https://' + host + '.fqnovelvod.com/synthetic-bvc2.mp4', contentKey: null })) });
  assert.equal(url.pathname, '/api/media');
  if (new URL(url.searchParams.get('url')).hostname.startsWith('denied.')) {
    denied++; return route.fulfill({ status: 403, body: 'Synthetic CDN denial' });
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  // Original, unencrypted downloads use the existing direct streaming writer.
  if (!range) return route.fulfill({ contentType: 'video/mp4', body: input });
  const first = Number(range[1]), last = range[2] ? Math.min(Number(range[2]), input.length - 1)
    : Math.min(first + (whole ? input.length : 65536) - 1, input.length - 1);
  assert(first >= 0 && last >= first && last < input.length);
  reads.push({ first, last });
  deliveredBytes += last - first + 1;
  if (!whole) await new Promise(resolve => setTimeout(resolve, 20));
  return route.fulfill({ status: 206, contentType: 'video/mp4',
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${first}-${last}/${input.length}`,
      'Content-Length': String(last - first + 1) }, body: input.subarray(first, last + 1) });
});
await page.exposeFunction('recordBvcFirstFrame', () => { firstFrameBytes ??= deliveredBytes; });
try {
  await page.goto(`${process.env.BVC2_TEST_ORIGIN || 'http://127.0.0.1:4173'}/hongguo-dl/?id=123456789&bvc2_stream=${whole ? 'whole-file' : 'experimental'}`);
  // The controls exist in static HTML before the application attaches handlers.
  await page.waitForFunction(() => document.querySelector('#series-title')
    ?.textContent.includes('Synthetic ByteVC2 framing'), null, { timeout: 30000 });
  await page.locator('#mode-play').click();
  await page.evaluate(() => {
    const video = document.querySelector('#player-video');
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => window.recordBvcFirstFrame());
  });
  await page.locator('[data-play-vid="111111111"]').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('#player-video');
    return video.videoWidth === 160 && video.currentTime > 0.3 &&
      video.getVideoPlaybackQuality().totalVideoFrames > 2;
  }, null, { timeout: 90000 });
  assert.equal(denied, 1, '403 must rotate to the other BVC2 CDN');
  assert.match(await page.locator('#player-source-info').textContent(), whole ? /ByteVC2|轉碼/ : /增量轉碼/);
  if (!whole) {
  // The first real decoded browser picture must appear before the whole
  // long source is delivered, not merely before its last requested offset.
  deliveredAtFirstFrame = firstFrameBytes ?? deliveredBytes;
  assert(deliveredAtFirstFrame < longInput.length,
    'First decoded H.264 picture must precede full source-body delivery');
  const beforeSeek = await page.locator('#player-video').evaluate(video => ({
    frames: video.getVideoPlaybackQuality().totalVideoFrames,
    alreadyBuffered: Array.from({ length: video.buffered.length },
      (_, i) => video.buffered.start(i) <= 24 && video.buffered.end(i) >= 24)
      .some(Boolean)
  }));
  // Adaptive raw/MSE prefetch may already cover 24s; both paths must seek.
  await page.locator('#player-video').evaluate(video => { video.currentTime = 24; });
  await page.waitForFunction(previous => {
    const video = document.querySelector('#player-video');
    return video.currentTime > 23.5 && video.currentTime < 31 && !video.seeking &&
      video.readyState >= 2 &&
      video.getVideoPlaybackQuality().totalVideoFrames > previous + 2;
  }, beforeSeek.frames, { timeout: 90000 });
  assert(reads.length > 0);
  assert(reads.every(r => r.last - r.first + 1 <= 8 * 1024 * 1024));
  assert.equal(await page.evaluate(() => window.__activeMse), 1);
  }
  await page.locator('#mode-download').click();
  await page.waitForFunction(() => window.__activeMse === 0);
  // Download jobs use the short fixture to keep five codec tests bounded.
  input = shortInput;
  // Every requested output goes through the real download queue and worker.
  for (const [index, mode] of ['original', 'h264', 'hevc', 'vvc', 'av1'].entries()) {
    await page.locator('#output-mode').selectOption(mode);
    await page.locator('[data-vid="111111111"]').check();
    await page.locator('#add-queue').click();
    await page.waitForFunction(count => document.querySelectorAll('.job .s-completed').length === count,
      index + 1, { timeout: 120000 });
    assert.equal(await page.locator('.job .s-failed').count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log(browserName + ' ' + (whole ? 'whole-file' : 'stream') + ' ' + JSON.stringify({ decodedSyntheticBvc2Frames: true, boundedRangeRequests: reads.length,
    deliveredAtFirstFrame, longSourceBytes: longInput.length,
    unbufferedSeekAtSeconds: 24,
    outputs: ['original', 'h264', 'hevc', 'vvc', 'av1'], liveMseAfterModeSwitch: 0 }));
} catch (error) {
  console.error('Synthetic BVC2 browser failure', error.message);
  console.error('Synthetic BVC2 browser state', await page.evaluate(() => ({
    status: document.querySelector('#player-status')?.textContent,
    source: document.querySelector('#player-source-info')?.textContent,
    title: document.querySelector('#series-title')?.textContent,
    videoError: document.querySelector('#player-video')?.error?.code || null
  })).catch(() => ({ unavailable: true })));
  console.error('Page errors', errors);
  throw error;
} finally { await browser.close(); }
