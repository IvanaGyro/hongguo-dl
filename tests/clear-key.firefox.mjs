// Browser acceptance test with a real FFmpeg-generated CENC-AES-CTR MP4.
// All media and source metadata are local. No actual Hongguo requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firefox, chromium } from 'playwright';

const videoBytes = readFileSync(process.argv[2]);
const KID = '11223344556677889900aabbccddeeff';
const KEY = '00112233445566778899aabbccddeeff';
assert(videoBytes.length > 65536, 'Fixture must exceed the metadata Range probe size');
const engine = process.env.HONGGUO_TEST_BROWSER === 'chromium' ? 'chromium' : 'firefox';
const browser = await (engine === 'chromium' ? chromium : firefox).launch({
  headless: true,
  ...(engine === 'firefox'
    ? { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.eme.enabled': true } } : {})
});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const mediaRequests = [], pageErrors = [];
const emeDiagnostics = [];
page.on('console', message => {
  if (message.text().startsWith('[Hongguo EME]') ||
      message.text().startsWith('[Hongguo MSE]'))
    emeDiagnostics.push(message.text());
});
page.on('pageerror', error => pageErrors.push(error.message));
const serveApi = async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/health') return route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true })
  });
  if (url.pathname === '/api/series') return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ kind: 'series', seriesId: '123456789',
      title: 'Clear Key 測試', total: 1, accessible: 1,
      episodes: [{ index: 1, vid: '111111111', available: true }] })
  });
  if (url.pathname === '/api/source') return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ variants: [{
      codec: 'h264', quality: '720p', source: 'app',
      url: 'https://cdn.fqnovelvod.com/synthetic-cenc.mp4',
      contentKey: KEY, width: 480, height: 270
    }] })
  });
  if (url.pathname === '/api/media') {
    const range = route.request().headers().range;
    let first = 0, last = videoBytes.length - 1, status = 200;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) return route.fulfill({ status: 416, body: '' });
      first = Number(m[1]);
      last = m[2] ? Math.min(last, Number(m[2])) : last;
      status = 206;
    }
    mediaRequests.push({ status, first, last });
    if (first > last || first >= videoBytes.length)
      return route.fulfill({ status: 416, body: '' });
    const body = videoBytes.subarray(first, last + 1);
    return route.fulfill({ status, contentType: 'video/mp4',
      headers: {
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Content-Length': String(body.length),
        ...(status === 206 ? { 'Content-Range':
          'bytes ' + first + '-' + last + '/' + videoBytes.length } : {})
      }, body });
  }
  throw new Error('Unexpected Worker endpoint: ' + url.pathname);
};
await page.route(url => url.pathname.startsWith('/api/'), serveApi);

try {
  await page.goto('http://127.0.0.1:4173/hongguo-dl/?id=123456789');
  const available = await page.evaluate(async () => {
    const v = document.querySelector('#player-video');
    if (!v?.canPlayType('video/mp4; codecs="avc1.42E01E"') ||
        !navigator.requestMediaKeySystemAccess) return false;
    try {
      await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{
        initDataTypes: ['keyids'],
        videoCapabilities: [{
          contentType: 'video/mp4; codecs="avc1.42E01E"',
          encryptionScheme: 'cenc'
        }]
      }]);
      return true;
    } catch { return false; }
  });
  if (!available) {
    console.log('SKIP browser native Clear Key: Firefox runner does not advertise EME/CENC for H.264');
  } else {
    const started = performance.now();
    await page.evaluate(() => {
      const video = document.querySelector('#player-video');
      window.__emeVideoEvents = [];
      for (const type of ['encrypted', 'waitingforkey', 'error', 'loadedmetadata',
        'loadeddata', 'canplay', 'emptied', 'stalled', 'suspend', 'playing']) {
        video.addEventListener(type, () => {
          window.__emeVideoEvents.push({
            type, mediaKeys: !!video.mediaKeys,
            errorCode: video.error?.code || null, readyState: video.readyState
          });
        });
      }
    });
    await page.locator('#mode-play').click();
    await page.waitForFunction(() => document.querySelector('#player-source-info')
      ?.textContent.includes('原生串流解密'), null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#player-video')?.currentTime > 0.2,
      null, { timeout: 30000 });
    const result = await page.evaluate(() => {
      const video = document.querySelector('#player-video');
      return { readyState: video.readyState, currentTime: video.currentTime,
        mediaKeys: !!video.mediaKeys, videoWidth: video.videoWidth,
        source: document.querySelector('#player-source-info')?.textContent };
    });
    assert(result.currentTime > 0.2, 'Native CENC must advance the video clock');
    const nativeVideoEvents = await page.evaluate(() => window.__emeVideoEvents || []);
    assert(result.readyState >= 2 && result.mediaKeys,
      'Native media pipeline and CDM must be active: ' + JSON.stringify({
        ...result, emeDiagnostics, metadataRequests: mediaRequests.slice(0, 5),
        videoEvents: nativeVideoEvents.slice(0, 24)
      }));
    assert.equal(result.videoWidth, 480);
    assert(mediaRequests.length > 0);
    assert(mediaRequests.some(r => r.status === 206 && r.first === 0 && r.last <= 65535),
      'Metadata preflight must be a bounded Range request');
    assert(!pageErrors.length, pageErrors.join('; '));
    const nativeMs = Math.round(performance.now() - started);
    console.log('PASS real H.264 CENC Clear Key browser stream', JSON.stringify({
      ...result, source: undefined, mediaRequests: mediaRequests.length,
      startupMs: nativeMs, KID: 'known synthetic fixture'
    }));
    // Compare against the production FFmpeg.wasm fallback with the exact same
    // encrypted bytes. Relative speed is informational: CI runners fluctuate.
    const fallback = await context.newPage();
    await fallback.addInitScript(() => {
      Object.defineProperty(navigator, 'requestMediaKeySystemAccess',
        { configurable: true, value: undefined });
    });
    await fallback.route(url => url.pathname.startsWith('/api/'), serveApi);
    await fallback.goto('http://127.0.0.1:4173/hongguo-dl/?id=123456789');
    const fallbackStarted = performance.now();
    await fallback.locator('#mode-play').click();
    await fallback.waitForFunction(() => document.querySelector('#player-video')?.currentTime > 0.2,
      null, { timeout: 90000 });
    const fallbackUsedEme = await fallback.locator('#player-source-info').textContent();
    assert(!fallbackUsedEme.includes('原生串流解密'), 'Disabled EME must force FFmpeg.wasm');
    const fallbackMs = Math.round(performance.now() - fallbackStarted);
    console.log('CENC startup benchmark (same fixture, CI Firefox, not production latency):',
      JSON.stringify({ nativeEmeMs: nativeMs, ffmpegWasmMs: fallbackMs,
        ratio: +(fallbackMs / Math.max(nativeMs, 1)).toFixed(2) }));
    await fallback.close();
  }
} finally { await browser.close(); }
