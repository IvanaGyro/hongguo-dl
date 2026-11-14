// UI contract only: source/CDN responses are synthetic and media probes are
// deliberately held. Real decoding is covered by the CENC/BVC2 acceptance jobs.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4173/';
const key = '00112233445566778899aabbccddeeff';
const source = (quality, codec, suffix) => ({ quality, codec, contentKey: key,
  url: 'https://cdn.fqnovelvod.com/' + suffix + '.mp4' });
const lists = {
  web: [source('360p', 'h264', 'web360'), source('720p', 'h264', 'web720')],
  app: [source('720p', 'hevc', 'app720'), source('1080p', 'h264', 'app1080'),
    source('720p', 'h265', 'app720backup'), source('540p', 'bytevc2', 'unsupported540')]
};
const selected = (log, quality) => new RegExp('source.selected[^\\n]*quality=' + quality + ' codec=h264').test(log);
try {
  for (const first of ['web', 'app']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [], held = [];
    let releaseLate = false;
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      const canPlay = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (mime) {
        return /hvc1|hev1/.test(mime) ? 'probably' : canPlay.call(this, mime);
      };
      if (!sessionStorage.getItem('quality-contract-seeded')) {
        sessionStorage.setItem('quality-contract-seeded', '1');
        localStorage.setItem('hongguo-dl-player-preferences-v1', JSON.stringify({
          quality: '360p', codec: 'bytevc2', speed: '1.25' }));
      }
    });
    await context.route('**/bvc2/**', route => route.fulfill({ status: 404, body: 'Bridge unavailable' }));
    await context.route('https://*.fqnovelvod.com/**', () => {});
    await context.route(url => url.pathname.startsWith('/api/'), async route => {
      const url = new URL(route.request().url());
      const json = data => route.fulfill({ json: data });
      if (url.pathname === '/api/health') return json({ ok: true, sourceChannels: true });
      if (url.pathname === '/api/series') {
        const seriesId = url.searchParams.get('input');
        return json({ kind: 'series', seriesId, title: 'Quality contract ' + seriesId,
          total: 1, accessible: 1, episodes: [{ index: 1, vid: '101', available: true }] });
      }
      if (url.pathname === '/api/source') {
        const channel = url.searchParams.get('channel');
        assert(['web', 'app'].includes(channel));
        const variants = url.searchParams.get('sid') === '43'
          ? [source('540p', 'h264', 'other-series')] : lists[channel];
        const data = { variants, sourceChannel: channel };
        if (url.searchParams.get('sid') === '42' && channel !== first && !releaseLate) {
          held.push({ route, data }); return;
        }
        return json(data);
      }
      if (url.pathname === '/api/media') return; // Keep playback on its selected source.
      return route.fulfill({ status: 404, body: 'Unexpected fixture endpoint' });
    });
    const release = async () => {
      releaseLate = true;
      await Promise.all(held.splice(0).map(({ route, data }) => route.fulfill({ json: data })));
    };
    const log = () => page.locator('#playback-log').inputValue();
    const expected = first === 'web' ? '720p' : '1080p';
    const expectSelected = async () => {
      await page.waitForFunction(q => new RegExp('source.selected[^\\n]*quality=' + q + ' codec=h264')
        .test(document.querySelector('#playback-log').value), expected);
      assert(selected(await log(), expected));
      assert.equal(await page.locator('#player-quality').inputValue(), 'auto');
    };
    await page.goto(base + '?id=42');
    await page.waitForFunction(() => document.querySelector('#quality')?.options.length > 1);
    await page.locator('#mode-play').click();
    await expectSelected();
    await page.locator('[data-play-vid="101"]').click();
    const initialLabels = first === 'web' ? ['自動最佳', '720p', '360p']
      : ['自動最佳', '1080p', '720p'];
    assert.deepEqual(await page.locator('#player-quality option').allTextContents(), initialLabels);
    await page.locator('#player-settings-toggle').click();
    await page.locator('[data-settings-target="quality"]').click();
    await release();
    // The already open custom menu must refresh along with the hidden select.
    await page.locator('#player-quality-options [data-choice-value="720p|h264"]').waitFor();
    await page.waitForFunction(() => document.querySelector('#player-quality-options')
      ?.textContent.includes('720p（HEVC）'));
    const labels = ['自動最佳', '1080p', '720p（H.264）', '720p（HEVC）', '360p'];
    assert.deepEqual(await page.locator('#player-quality option').allTextContents(), labels);
    assert.deepEqual(await page.locator('#player-quality-options button').allTextContents(),
      labels.map((label, i) => label + (i === 0 ? '✓' : '')));
    assert.equal((await log()).split('source.selected').length - 1, 1,
      'Duplicate activation and late higher quality must preserve the first selection');
    await page.locator('#player-quality-options [data-choice-value="720p|h264"]').click();
    assert.equal(await page.locator('#player-quality').inputValue(), '720p|h264');
    assert.deepEqual(await page.evaluate(() => JSON.parse(
      localStorage.getItem('hongguo-dl-player-preferences-v1'))), { speed: '1.25' });

    // Reload clears manual quality. Resolve both lists before playback to prove
    // that the metadata cache still remembers which channel won the race.
    releaseLate = false;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#quality')?.options.length > 1);
    await release();
    await page.waitForFunction(() => document.querySelector('#quality')?.options.length === 6);
    await page.locator('#mode-play').click();
    await expectSelected();
    assert.equal(await page.locator('#player-speed').inputValue(), '1.25');
    await page.locator('#player-settings-toggle').click();
    await page.locator('[data-settings-target="quality"]').click();
    await page.locator('#player-quality-options [data-choice-value="720p|h264"]').click();

    // Switch series in the same page, deliberately reusing vid=101. Old menu
    // entries and quality must not leak across series boundaries.
    await page.locator('#input-url').fill('43');
    await page.locator('#lookup-button').click();
    await page.waitForFunction(() => document.querySelector('#series-title')
      ?.textContent === 'Quality contract 43');
    await page.waitForFunction(() => document.querySelector('#player-quality')?.options.length === 2);
    assert.equal(await page.locator('#player-quality').inputValue(), 'auto');
    assert.deepEqual(await page.locator('#player-quality option').allTextContents(), ['自動最佳', '540p']);
    await page.waitForFunction(() => /source.selected[^\n]*quality=540p codec=h264/
      .test(document.querySelector('#playback-log').value));
    assert.deepEqual(errors, []);
    console.log('PASS four quality rules: ' + first + ' first, live menu labels, reload/series reset and cached race winner');
    await context.close();
  }
  // A remembered quality is portable across codecs, in both directions.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      const canPlay = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (mime) {
        return /hvc1|hev1/.test(mime) ? 'probably' : canPlay.call(this, mime);
      };
    });
    // Availability only: media probes are held before either real worker starts.
    await context.route('**/bvc2/**', route => route.fulfill({ status: 200, headers: {
      'Content-Type': route.request().url().includes('.wasm') ? 'application/wasm' : 'application/json',
      'Content-Length': '100'
    }, body: '' }));
    await context.route('https://*.fqnovelvod.com/**', () => {});
    await context.route(url => url.pathname.startsWith('/api/'), route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/health') return route.fulfill({ json: { ok: true, sourceChannels: false } });
      if (url.pathname === '/api/series') return route.fulfill({ json: {
        kind: 'series', seriesId: '44', title: 'Cross-codec quality', total: 2, accessible: 1,
        episodes: [{ index: 1, vid: '101', available: true }, { index: 2, vid: '102', available: false }]
      } });
      if (url.pathname === '/api/source') return route.fulfill({ json: { variants: [
        source('720p', url.searchParams.get('vid') === '101' ? 'hevc' : 'bytevc2',
          'codec-' + url.searchParams.get('vid'))
      ] } });
      if (url.pathname === '/api/media') return;
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto(base + '?id=44');
    await page.waitForFunction(() => document.querySelector('#series-title')?.textContent === 'Cross-codec quality');
    await page.locator('#mode-play').click();
    await page.waitForFunction(() => /source.selected[^\n]*quality=720p codec=hevc/
      .test(document.querySelector('#playback-log').value));
    await page.locator('#player-settings-toggle').click();
    await page.locator('[data-settings-target="quality"]').click();
    await page.locator('#player-quality-options [data-choice-value="720p|hevc"]').click();
    await page.locator('[data-play-vid="102"]').click();
    await page.waitForFunction(() => document.querySelector('#player-quality')?.value === '720p|bytevc2');
    assert.deepEqual(await page.locator('#player-quality option').allTextContents(), ['自動最佳', '720p']);
    assert.match(await page.locator('#playback-log').inputValue(), /source.selected[^\n]*quality=720p codec=bytevc2/);
    assert.doesNotMatch(await page.locator('#playback-log').inputValue(), /code=PLAYBACK_UNSUPPORTED/);
    await page.locator('[data-play-vid="101"]').click();
    await page.waitForFunction(() => document.querySelector('#player-quality')?.value === '720p|hevc');
    assert.deepEqual(await page.locator('#player-quality option').allTextContents(), ['自動最佳', '720p']);
    assert.deepEqual(errors, []);
    console.log('PASS manual 720p survives HEVC → ByteVC2 → HEVC without a stale codec constraint');
    await context.close();
  }
} finally { await browser.close(); }
