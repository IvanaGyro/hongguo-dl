// SPDX-License-Identifier: GPL-3.0-only
// Quality choices. Codec support is emulated ("a browser that plays HEVC")
// so the rules read the same in every engine; media requests are held, so
// nothing is decoded. Real decoding is covered by watch.spec.mjs.
import { test, expect, variant } from './support/app.mjs';

const HELD = () => new Promise(() => {});
async function emulate(context, { hevc = true, bvc2 = false } = {}) {
  await context.addInitScript(hevc => {
    const canPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (mime) {
      return /hvc1|hev1/.test(mime) ? (hevc ? 'probably' : '') : canPlay.call(this, mime);
    };
  }, hevc);
  if (!bvc2) await context.route('**/bvc2/**', route => route.fulfill({ status: 404, body: 'not deployed' }));
}
const options = page => page.locator('#player-quality option').allTextContents();
const openQualityMenu = async page => {
  await page.locator('#player-settings-toggle').click();
  await page.locator('#player-settings [data-settings-target="quality"]').click();
};

test('the player offers only renditions this browser can play; downloads offer all', async ({ app, page, context }) => {
  await emulate(context, { hevc: true, bvc2: false });
  app.fault('media', HELD);
  app.addSeries(42, { title: 'Menus', episodes: [[
    variant('cenc.mp4', { quality: '1080p', codec: 'hevc' }),
    variant('clear.mp4', { quality: '720p', codec: 'h264' }),
    variant('clear.mp4', { quality: '720p', codec: 'bytevc2' })
  ]] });
  await page.goto('./');
  await app.open(42);
  await expect.poll(() => options(page)).toEqual(['自動最佳', '1080p', '720p']);
  await app.mode('download');
  await expect(page.locator('#quality option')).toHaveText(['最佳可取得', '1080p', '720p（H.264）', '720p（ByteVC2）']);
});

test('a rendition list that arrives later extends the menu without changing what plays', async ({ app, page, context }) => {
  await emulate(context);
  app.fault('media', HELD);
  app.health = { ok: true, sourceChannels: true };
  let releaseApp;
  const appHeld = new Promise(resolve => { releaseApp = resolve; });
  // The public web list answers first; the App list arrives later.
  app.fault('source', async ({ n }) => { if (n >= 1) await appHeld; });
  app.addSeries(42, { title: 'Late list', episodes: [[
    variant('clear.mp4', { quality: '720p', codec: 'h264' }), variant('clear.mp4', { quality: '360p', codec: 'h264' })
  ]] });
  // The App list adds HEVC at the same 720p tier and a 1080p tier.
  const late = [variant('clear.mp4', { quality: '1080p', codec: 'h264' }), variant('cenc.mp4', { quality: '720p', codec: 'hevc' })];
  await context.route(url => url.pathname === '/api/source' && url.searchParams.get('channel') === 'app', async route => {
    await appHeld;
    await route.fulfill({ json: { variants: late.map(({ media, ...v }) => v) } });
  });
  await page.goto('./');
  await app.open(42);
  await expect.poll(() => options(page)).toEqual(['自動最佳', '720p', '360p']);
  await openQualityMenu(page);
  releaseApp();
  await expect(page.locator('#player-quality-options button')).toHaveText(
    ['自動最佳✓', '1080p', '720p（H.264）', '720p（HEVC）', '360p']);
  await expect(page.locator('#player-quality')).toHaveValue('auto');
  // The playback diagnostics panel lists each source the player switched to.
  const log = await page.locator('#playback-log').inputValue();
  expect(log.match(/source\.selected/g), 'the first selection is kept').toHaveLength(1);
});

test('a manual quality lasts for the session and resets for a new series or a reload', async ({ app, page, context }) => {
  // Real clear media here: a request held across a reload is reported by
  // WebKit as an uncaught access-control error, which says nothing about
  // quality choices.
  await emulate(context);
  const two = () => [variant('clear.mp4', { quality: '720p' }), variant('clear.mp4', { quality: '480p' })];
  app.addSeries(42, { title: 'Session quality', episodes: [two(), two()] });
  app.addSeries(43, { title: 'Other series', episodes: [[variant('clear.mp4', { quality: '540p' })]] });
  await page.goto('./');
  await app.open(42);
  await expect.poll(() => options(page)).toEqual(['自動最佳', '720p', '480p']);
  await app.chooseQuality('480p|h264');

  await test.step('it carries to the next episode', async () => {
    await app.episodeButton(2).click();
    await expect(page.locator('#player-quality')).toHaveValue('480p|h264');
  });
  await test.step('a new series starts on automatic', async () => {
    await app.open(43);
    await expect.poll(() => options(page)).toEqual(['自動最佳', '540p']);
    await expect(page.locator('#player-quality')).toHaveValue('auto');
  });
  await test.step('a reload starts on automatic', async () => {
    await app.open(42);
    await app.chooseQuality('480p|h264');
    await page.reload();
    await page.locator('[data-recent-id="42"]').click();
    await expect.poll(() => options(page)).toEqual(['自動最佳', '720p', '480p']);
    await expect(page.locator('#player-quality')).toHaveValue('auto');
  });
});

test('a chosen quality survives an episode whose only codec differs', async ({ app, page, context }) => {
  await emulate(context, { hevc: true, bvc2: true });
  app.fault('media', HELD);
  app.addSeries(44, { title: 'Cross codec', episodes: [
    [variant('cenc.mp4', { quality: '720p', codec: 'hevc' })],
    [variant('cenc.mp4', { quality: '720p', codec: 'bytevc2' })]
  ] });
  await page.goto('./');
  await app.open(44);
  await expect.poll(() => options(page)).toEqual(['自動最佳', '720p']);
  await app.chooseQuality('720p|hevc');
  await app.episodeButton(2).click();
  await expect(page.locator('#player-quality')).toHaveValue('720p|bytevc2');
  await app.episodeButton(1).click();
  await expect(page.locator('#player-quality')).toHaveValue('720p|hevc');
});

test('the codec report separates video, audio, file and MSE support', async ({ page, app, context }) => {
  await context.addInitScript(() => {
    const supports = mime => !mime.includes('vvc1') && (!/hvc1|hev1/.test(mime) || mime.includes('.') && !mime.includes(','));
    HTMLMediaElement.prototype.canPlayType = mime => supports(mime) ? 'probably' : '';
    MediaSource.isTypeSupported = supports;
    Object.defineProperty(navigator, 'mediaCapabilities', { configurable: true, value: {
      decodingInfo: async config => {
        const mime = config.video?.contentType || '';
        if (mime === 'video/mp4; codecs="hvc1"') throw new TypeError('Incomplete codec');
        const supported = !mime.includes('vvc1') && (config.type === 'file' || !config.audio || !/hvc1|hev1/.test(mime));
        return { supported, smooth: supported, powerEfficient: false };
      }
    } });
  });
  await page.goto('./');
  await page.locator('#codec-diagnostics > summary').click();
  await page.locator('#codec-diag-run').click();
  await expect(page.locator('#codec-diag-results')).toContainText('"schema": 2');
  const report = JSON.parse(await page.locator('#codec-diag-results').textContent());
  const main = report.formats.find(row => row.videoOnly.mime.includes('hvc1.1.6.L120.90'));
  expect({ muxed: main.mseSupported, video: main.videoOnly.mseSupported, audio: main.audioOnly.mseSupported,
    capabilities: main.mediaCapabilities.supported, file: main.fileCapabilities.supported })
    .toEqual({ muxed: false, video: true, audio: true, capabilities: false, file: true });
  const generic = report.formats.find(row => row.codec === 'HEVC + AAC');
  expect(generic.mediaCapabilitiesStatus).toBe('error');
  await expect(page.locator('#codec-diag-copy')).toBeVisible();
  expect(app.requestsOf('source')).toEqual([]);
});
