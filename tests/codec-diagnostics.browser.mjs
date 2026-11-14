// Exercise the diagnostic UI with disagreeing Windows-like capability APIs.
// No real media, source URL or decoder is requested by this test.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage();
const errors = [];
let sourceRequests = 0;
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const supports = mime => !mime.includes('vvc1') &&
    (!/hvc1|hev1/.test(mime) || mime.includes('.') && !mime.includes(','));
  HTMLMediaElement.prototype.canPlayType = mime => supports(mime) ? 'probably' : '';
  MediaSource.isTypeSupported = supports;
  Object.defineProperty(navigator, 'mediaCapabilities', { configurable: true, value: {
    decodingInfo: async config => {
      const mime = config.video?.contentType || '';
      if (mime === 'video/mp4; codecs="hvc1"') throw new TypeError('Incomplete codec');
      const supported = !mime.includes('vvc1') &&
        (config.type === 'file' || !config.audio || !/hvc1|hev1/.test(mime));
      return { supported, smooth: supported, powerEfficient: false };
    }
  } });
});
await page.route(url => url.pathname.startsWith('/api/'), route => {
  if (new URL(route.request().url()).pathname === '/api/source') sourceRequests++;
  return route.fulfill({ json: { ok: true, sourceChannels: false } });
});
try {
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:4173/');
  await page.locator('#codec-diagnostics > summary').click();
  await page.locator('#codec-diag-run').click();
  await page.waitForFunction(() => document.querySelector('#codec-diag-results')
    ?.textContent.includes('"schema": 2'));
  const report = JSON.parse(await page.locator('#codec-diag-results').textContent());
  const main = report.formats.find(row => row.videoOnly.mime.includes('hvc1.1.6.L120.90'));
  assert.equal(main.mseSupported, false);
  assert.equal(main.videoOnly.mseSupported, true);
  assert.equal(main.audioOnly.mseSupported, true);
  assert.equal(main.mediaCapabilitiesStatus, 'ok');
  assert.equal(main.mediaCapabilities.supported, false);
  assert.equal(main.fileCapabilities.supported, true);
  assert.equal(main.videoOnly.mediaCapabilities.supported, true);
  const generic = report.formats.find(row => row.codec === 'HEVC + AAC');
  assert.equal(generic.mediaCapabilitiesStatus, 'error');
  assert.equal(generic.mediaCapabilities, null);
  assert.equal(await page.locator('#codec-diag-copy').isVisible(), true);
  assert.equal(await page.locator('#codec-diag-run').isEnabled(), true);
  assert.equal(sourceRequests, 0);
  assert.deepEqual(errors, []);
  console.log('PASS codec diagnostic UI separates video/audio, file/MSE and unknown/rejected queries');
} finally { await browser.close(); }
