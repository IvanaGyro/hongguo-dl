// Browser end-to-end for true incremental CENC progressive MP4 -> clear fMP4.
// Network input is synthetic, locally generated, served as bounded Range requests.
// Requires the verified cenc-core assets in public/cenc; no Hongguo API calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';

const input = readFileSync(process.argv[2]);
const browserName = process.env.CENC_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const KID = '11223344556677889900aabbccddeeff';
const KEY = '00112233445566778899aabbccddeeff';
assert(input.byteLength > 600000, 'Fixture must exceed Worker Range prefetch window');
const browser = await (browserName === 'firefox' ? firefox : chromium).launch({
  headless: true, ...(browserName === 'firefox'
    ? { firefoxUserPrefs: { 'media.eme.enabled': true, 'media.autoplay.default': 0 } }
    : {})
});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const mediaRequests = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error' && !message.text().includes('favicon'))
    errors.push(message.text().slice(0, 180));
});
await page.exposeFunction('recordCencFirstFrame', () => {
  const lastByte = mediaRequests.reduce((max, item) => Math.max(max, item.last), -1);
  return { requests: mediaRequests.length, lastByte };
});
await context.route(url => url.pathname.startsWith('/api/'), async route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/api/series') return route.fulfill({
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ kind: 'series', seriesId: '123456789', title: 'CENC streaming fixture',
      total: 1, accessible: 1, episodes: [{ index: 1, vid: '111111111', available: true }] })
  });
  if (u.pathname === '/api/source') return route.fulfill({
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ variants: [{
      codec: 'h264', quality: '720p', source: 'app',
      url: 'https://cdn.fqnovelvod.com/cenc-progressive.mp4',
      contentKey: KEY, width: 480, height: 270
    }] })
  });
  if (u.pathname !== '/api/media') throw new Error('Unexpected API endpoint');
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  assert(range, 'Every media request must carry Range');
  const first = Number(range[1]);
  const last = range[2] ? Math.min(Number(range[2]), input.length - 1) : input.length - 1;
  assert(first >= 0 && first <= last && last < input.length);
  const bytes = input.subarray(first, last + 1);
  mediaRequests.push({ first, last, bytes: bytes.length });
  // Real streaming acceptance needs network backpressure, not a 1-shot Blob.
  if (last >= 256 * 1024) await new Promise(resolve => setTimeout(resolve, 100));
  return route.fulfill({
    status: 206, contentType: 'video/mp4',
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + first + '-' + last + '/' + input.length,
      'Content-Length': String(bytes.length)
    }, body: bytes
  });
});

try {
  await page.goto('http://127.0.0.1:4173/hongguo-dl/?id=123456789');
  const available = await page.evaluate(() => {
    const mime = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
  });
  assert(available, browserName + ' runner must support H264/AAC MSE for this acceptance test');
  {
    await page.evaluate(() => {
      const video = document.querySelector('#player-video');
      window.__cencFrame = null;
      const record = async () => {
        if (window.__cencFrame) return;
        const network = await window.recordCencFirstFrame();
        window.__cencFrame = {
          currentTime: video.currentTime, videoWidth: video.videoWidth,
          mediaKeys: Boolean(video.mediaKeys), ...network
        };
      };
      if (video.requestVideoFrameCallback)
        video.requestVideoFrameCallback(record);
      else video.addEventListener('timeupdate', record, { once: true });
    });
    await page.locator('#mode-play').click();
    await page.waitForFunction(() => document.querySelector('#player-source-info')
      ?.textContent.includes('增量解密轉封裝（MSE）'), null, { timeout: 60000 });
    await page.waitForFunction(() => window.__cencFrame?.videoWidth === 480,
      null, { timeout: 90000 });
    const frame = await page.evaluate(() => window.__cencFrame);
    assert(frame.lastByte < input.length - 1,
      'First presented frame occurred after HTTP EOF: ' + JSON.stringify(frame));
    assert(frame.requests >= 2, 'Metadata and fragment HTTP ranges must both be used');
    assert.equal(frame.mediaKeys, false, 'Clear output should not need EME');
    assert(!errors.length, 'Unexpected browser errors: ' + errors.join('; '));
    console.log('PASS ' + browserName + ' encrypted progressive MP4 remux first frame before HTTP EOF',
      JSON.stringify({ ...frame, inputBytes: input.length,
        downloadedPercentAtFirstFrame: +((frame.lastByte + 1) / input.length * 100).toFixed(1),
        KID: 'synthetic fixture' }));
  }
} finally {
  await browser.close();
}
