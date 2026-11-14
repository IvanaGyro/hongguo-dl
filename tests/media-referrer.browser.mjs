// Browser requirements: JS reads and native video must work with a CDN that
// rejects page Referers. API routing and proxy fallback remain observable here.
// Uses synthetic, unencrypted H.264 only; no live upstream traffic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const bytes = readFileSync(process.argv[2]);
const app = process.env.TEST_APP_URL || 'http://127.0.0.1:5173/hongguo-dl/';
const cdn = 'https://v5-reading-video-b.qznovelvod.com/native-referrer.mp4';
const browser = await chromium.launch({ headless: true });
try {
  for (const { denyDirect, sourceFailure } of [
    { denyDirect: false }, { denyDirect: true }, { denyDirect: false, sourceFailure: true }
  ]) {
    const page = await browser.newPage();
    const apiOrigins = [], reads = [], errors = [];
    let refuseSource = Boolean(sourceFailure);
    page.on('pageerror', error => errors.push(error.name));
    await page.addInitScript(() => { window.__HONGGUO_START_MODE = 'download'; });
    const media = async (route, proxy) => {
      const request = route.request(), headers = request.headers();
      reads.push({ proxy, type: request.resourceType(), range: headers.range,
        referer: headers.referer || null });
      if (!proxy && (denyDirect || headers.referer))
        return route.fulfill({ status: 403, headers: { 'Access-Control-Allow-Origin': '*' } });
      const match = /^bytes=(\d+)-(\d*)$/.exec(headers.range || '');
      const first = match ? Number(match[1]) : 0;
      const last = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      return route.fulfill({ status: match ? 206 : 200, contentType: 'video/mp4',
        headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(last - first + 1),
          'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
          ...(match ? { 'Content-Range': `bytes ${first}-${last}/${bytes.length}` } : {}) },
        body: bytes.subarray(first, last + 1) });
    };
    await page.route(cdn, route => media(route, false));
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const url = new URL(route.request().url());
      apiOrigins.push(url.origin);
      if (url.pathname === '/api/health') return route.fulfill({ json: { ok: true, sourceChannels: !sourceFailure } });
      if (url.pathname === '/api/series') return route.fulfill({ json: {
        kind: 'series', seriesId: '42', title: 'Native referrer fixture', total: 1,
        episodes: [{ vid: '13', index: 13, available: true }] } });
      if (url.pathname === '/api/source') {
        if (refuseSource) return route.fulfill({ status: 502,
          json: { error: { code: 'EMPTY_RESPONSE', message: 'Empty source model' } } });
        return route.fulfill({ json: { variants: [
          { url: cdn, source: 'app', codec: 'h264', quality: '720p' }
        ] } });
      }
      assert.equal(url.pathname, '/api/media');
      return media(route, true);
    });
    try {
      await page.goto(app + '?id=42');
      await page.waitForFunction(() => document.querySelector('#series-title')?.textContent.includes('Native referrer fixture'));
      await page.locator('#mode-play').click();
      if (sourceFailure) {
        await page.waitForFunction(() =>
          /片源 API.*HTTP 502/.test(document.querySelector('#player-status').textContent));
        assert.match(await page.locator('#playback-log').inputValue(), /stage=source-api status=502/);
        refuseSource = false;
      }
      await page.waitForFunction(() => {
        const video = document.querySelector('#player-video');
        return video.currentTime > 0.25 && video.videoWidth > 0 &&
          video.getVideoPlaybackQuality().totalVideoFrames > 2;
      }, null, { timeout: 15000 });
      const state = await page.locator('#player-video').evaluate(video => ({
        direct: video.currentSrc.startsWith('https://v5-reading-video-b.qznovelvod.com/'),
        error: video.error?.code || null
      }));
      assert.equal(state.direct, !denyDirect, 'Native video must use the selected working route');
      assert.equal(state.error, null);
      assert(apiOrigins.length > 0 && apiOrigins.every(origin => origin === new URL(app).origin),
        'Dev API must stay on the Vite origin even when .env configures a deployed Worker');
      assert(reads.some(read => !read.proxy && read.type !== 'media'), 'Exercise the JS media probe');
      assert(reads.some(read => read.type === 'media'), 'Exercise the native media request');
      assert(reads.filter(read => !read.proxy).every(read => read.referer === null),
        'CDN reads must not send the page Referer');
      assert.equal(reads.some(read => read.proxy), denyDirect, 'Proxy fallback must remain available');
      assert.deepEqual(errors, []);
      console.log('PASS native video, JS media probe, same-origin dev API and ' +
        (sourceFailure ? 'source API 502 diagnosis/recovery' : denyDirect ? '403 proxy fallback' : 'direct no-referrer playback'));
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
