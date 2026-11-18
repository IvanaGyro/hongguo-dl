// Browser acceptance for encrypted CENC playback with a packaged fixture.
// argv[2]: fragmented CENC MP4 (Shaka/GPAC; sidx, mfra or no index).
// argv[3] (optional): clear MP4, argv[4] (optional): progressive CENC MP4.
// CENC_EXPECT_ROUTE=eme (default) expects native EME through MSE fed by the
// media Worker; =remux expects the WASM route (no fragment index).
// With argv[3]/[4], later episodes check that clear direct playback and the
// clear WASM remux route still play while MediaKeys stay attached.
// All media and source metadata are local. No actual Hongguo requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firefox, chromium } from 'playwright';

const videoBytes = readFileSync(process.argv[2]);
const clearBytes = process.argv[3] ? readFileSync(process.argv[3]) : null;
const progressiveBytes = process.argv[4] ? readFileSync(process.argv[4]) : null;
const expectRoute = process.env.CENC_EXPECT_ROUTE === 'remux' ? 'remux' : 'eme';
// CENC_EME_PREFETCH=1: episode 2 is the same fragmented CENC fixture, so the
// next-episode prefetch prepares a native EME stream whose key session opens
// only at the handoff.
const emePrefetch = process.env.CENC_EME_PREFETCH === '1';
// Without the optional fixtures, other episodes (e.g. next-episode prefetch)
// read the main fixture.
const mediaFor = path => (path.endsWith('/clear.mp4') ? clearBytes
  : path.endsWith('/progressive-cenc.mp4') ? progressiveBytes : null) || videoBytes;
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
// The app opens in watch mode; this suite was written against a download-mode start.
await page.addInitScript(() => { window.__HONGGUO_START_MODE = 'download'; });
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
      title: 'Clear Key 測試', total: 3, accessible: 3,
      episodes: [{ index: 1, vid: '111111111', available: true },
        { index: 2, vid: '222222222', available: true }, { index: 3, vid: '333333333', available: true }] })
  });
  if (url.pathname === '/api/source') {
    const vid = url.searchParams.get('vid');
    const variant = vid === '222222222' && emePrefetch
      ? { url: 'https://cdn.fqnovelvod.com/next-cenc.mp4', contentKey: KEY }
      : vid === '222222222'
      ? { url: 'https://cdn.fqnovelvod.com/clear.mp4', contentKey: null }
      : vid === '333333333'
        ? { url: 'https://cdn.fqnovelvod.com/progressive-cenc.mp4', contentKey: KEY }
        : { url: 'https://cdn.fqnovelvod.com/synthetic-cenc.mp4', contentKey: KEY };
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ variants: [{ codec: 'h264', quality: '720p', source: 'app',
        width: 480, height: 270, ...variant }] })
    });
  }
  if (url.pathname === '/api/media' || url.hostname.endsWith('.fqnovelvod.com')) {
    const target = url.pathname === '/api/media' ? new URL(url.searchParams.get('url')) : url;
    const videoBytes = mediaFor(target.pathname);
    const range = route.request().headers().range;
    let first = 0, last = videoBytes.length - 1, status = 200;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) return route.fulfill({ status: 416, body: '' });
      first = Number(m[1]);
      last = m[2] ? Math.min(last, Number(m[2])) : last;
      status = 206;
    }
    mediaRequests.push({ status, first, last, range, path: target.pathname });
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
await page.route(url => url.pathname.startsWith('/api/') || url.hostname.endsWith('.fqnovelvod.com'), serveApi);

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
    const routeLabel = expectRoute === 'eme' ? '原生 EME 串流解密' : '增量解密轉封裝';
    await page.waitForFunction(label => document.querySelector('#player-source-info')
      ?.textContent.includes(label), routeLabel, { timeout: 30000 });
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
    assert(result.readyState >= 2 && (expectRoute !== 'eme' || result.mediaKeys),
      'Native media pipeline and CDM must be active: ' + JSON.stringify({
        ...result, emeDiagnostics, metadataRequests: mediaRequests.slice(0, 5),
        videoEvents: nativeVideoEvents.slice(0, 24)
      }));
    assert.equal(result.videoWidth, 480);
    assert(mediaRequests.length > 0);
    const episodeRequests = mediaRequests.filter(r => r.path.endsWith('/synthetic-cenc.mp4'));
    assert.equal(episodeRequests.filter(r => r.range === 'bytes=0-').length, 1,
      'One bytes=0- response serves metadata and playback: ' + JSON.stringify(episodeRequests));
    // No second CDN stream after metadata probing. An mfra index adds one
    // tail read, after which the body resumes past the probed prefix. Open-ended
    // requests stop at EOF, so compare where each request starts.
    const starts = episodeRequests.slice(1).map(r => r.first);
    assert(starts.every(offset => offset > 0) && new Set(starts).size === starts.length,
      'A request restarted at an already requested offset: ' + JSON.stringify(episodeRequests));
    if (expectRoute === 'eme') assert(episodeRequests.length <= 3,
      'Unexpected extra media requests: ' + JSON.stringify(episodeRequests));
    const log = await page.locator('#playback-log').inputValue();
    if (expectRoute === 'eme') assert.match(log, /cenc\.route kind=eme-mse/);
    assert.doesNotMatch(log, /eme-progressive/);
    assert(!pageErrors.length, pageErrors.join('; '));
    const nativeMs = Math.round(performance.now() - started);
    console.log('PASS ' + engine + ' CENC ' + expectRoute + ' browser stream', JSON.stringify({
      ...result, source: undefined, mediaRequests: mediaRequests.length,
      startupMs: nativeMs, KID: 'known synthetic fixture'
    }));
    // An unbuffered seek restarts the stream at the indexed sync fragment.
    const seekTarget = await page.evaluate(() => {
      const video = document.querySelector('#player-video');
      const target = Math.max(1, Math.floor(video.duration * 0.66));
      video.currentTime = target;
      return target;
    });
    await page.waitForFunction(target => {
      const video = document.querySelector('#player-video');
      return !video.seeking && video.currentTime >= target && video.currentTime < target + 5 &&
        video.readyState >= 2 && !video.error;
    }, seekTarget, { timeout: 30000 });
    if (expectRoute === 'eme') assert.match(await page.locator('#playback-log').inputValue(),
      /seek\.run[^\n]*route=eme/);
    console.log('PASS ' + engine + ' ' + expectRoute + ' seek to ' + seekTarget + 's');
    if (emePrefetch) {
      await page.waitForFunction(() => /prefetch\.prepared episode=2 media=true/
        .test(document.querySelector('#playback-log').value), null, { timeout: 30000 });
      await page.locator('[data-play-vid="222222222"]').click();
      await page.waitForFunction(() => {
        const video = document.querySelector('#player-video');
        return /prefetch\.handoff episode=2 media=true/.test(document.querySelector('#playback-log').value) &&
          video.currentTime > 0.3 && video.readyState >= 2 && !video.error && Boolean(video.mediaKeys);
      }, null, { timeout: 30000 });
      const nextRequests = mediaRequests.filter(r => r.path.endsWith('/next-cenc.mp4'));
      assert.equal(nextRequests.filter(r => r.range === 'bytes=0-').length, 1,
        'The handoff continues the prefetched source: ' + JSON.stringify(nextRequests));
      console.log('PASS ' + engine + ' EME next-episode prefetch handoff', JSON.stringify({ requests: nextRequests.length }));
    }
    // MediaKeys stay attached: clear direct playback and the clear WASM
    // remux route must keep playing on the same element afterwards.
    for (const [vid, bytes, label] of [['222222222', clearBytes, 'clear direct MP4'],
      ['333333333', progressiveBytes, 'progressive CENC → clear WASM remux']]) {
      if (!bytes) continue;
      await page.locator(`[data-play-vid="${vid}"]`).click();
      await page.waitForFunction(() => {
        const video = document.querySelector('#player-video');
        return video.currentTime > 0.3 && video.readyState >= 2 && !video.error &&
          video.getVideoPlaybackQuality().totalVideoFrames > 2;
      }, null, { timeout: 90000 }).catch(async error => {
        throw new Error(label + ' did not play: ' + error.message + ' ' +
          (await page.locator('#player-status').textContent()));
      });
      const keys = await page.evaluate(() => Boolean(document.querySelector('#player-video').mediaKeys));
      if (expectRoute === 'eme') assert.equal(keys, true, label + ' plays with MediaKeys still attached');
      console.log('PASS ' + engine + ' ' + label + ' with MediaKeys attached=' + keys);
    }
    // Compare against the production FFmpeg.wasm fallback with the exact same
    // encrypted bytes. Relative speed is informational: CI runners fluctuate.
    const fallback = await context.newPage();
    // The app opens in watch mode; this suite was written against a download-mode start.
    await fallback.addInitScript(() => { window.__HONGGUO_START_MODE = 'download'; });
    // The key system is present but refuses: EME setup fails after the route
    // was chosen, and the same media Worker re-routes to WASM streaming.
    await fallback.addInitScript(() => {
      Object.defineProperty(navigator, 'requestMediaKeySystemAccess', { configurable: true,
        value: () => Promise.reject(new DOMException('Synthetic refusal', 'NotSupportedError')) });
    });
    await fallback.route(url => url.pathname.startsWith('/api/') || url.hostname.endsWith('.fqnovelvod.com'), serveApi);
    await fallback.goto('http://127.0.0.1:4173/hongguo-dl/?id=123456789');
    const fallbackStarted = performance.now();
    await fallback.locator('#mode-play').click();
    // Watch history is shared with the first page: open the fragmented episode explicitly.
    await fallback.locator('[data-play-vid="111111111"]').click();
    await fallback.waitForFunction(eme => (!eme || /eme\.fallback/.test(document.querySelector('#playback-log').value)) &&
      document.querySelector('#player-video')?.currentTime > 0.2, expectRoute === 'eme', { timeout: 90000 })
      .catch(async error => {
        throw new Error('Fallback page: ' + error.message + '\n' + (await fallback.locator('#playback-log').inputValue())
          .split('\n').filter(line => /cenc\.|route|eme|fallback/.test(line)).slice(-20).join('\n'));
      });
    const fallbackUsedEme = await fallback.locator('#player-source-info').textContent();
    assert(!fallbackUsedEme.includes('原生 EME'), 'Without EME the next fallback step must be used');
    const fallbackLog = await fallback.locator('#playback-log').inputValue();
    if (expectRoute === 'eme') assert.match(fallbackLog, /eme\.fallback/,
      'A refused key system must re-route to WASM streaming on the same Worker: ' +
      fallbackLog.split('\n').filter(line => /cenc\.|route|eme|fallback/.test(line)).slice(-25).join('\n'));
    const fallbackMs = Math.round(performance.now() - fallbackStarted);
    console.log('CENC startup benchmark (same fixture, CI Firefox, not production latency):',
      JSON.stringify({ nativeEmeMs: nativeMs, ffmpegWasmMs: fallbackMs,
        ratio: +(fallbackMs / Math.max(nativeMs, 1)).toFixed(2) }));
    await fallback.close();
  }
} finally { await browser.close(); }
