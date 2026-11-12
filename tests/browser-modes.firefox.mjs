// Real Firefox end-to-end: URL multi-ID preload, player-integrated settings,
// durable resume after reload, staging without save prompts, selected queue ZIP
// and lossless MP4, including 60-episode single-download behavior.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { firefox } from 'playwright';

const sample = readFileSync(process.argv[2]);
const browser = await firefox.launch({
  headless: true,
  firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 }
});
const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'allow' });
const page = await context.newPage();
const errors = [];
const calls = [];
let downloadEvents = 0;
page.on('download', () => downloadEvents++);
page.on('pageerror', err => errors.push(err.message));
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
// This regression covers browsers without the optional BVC2 bridge even when
// the production bundle is deployed. A separate test probes the WASM path.
page.route('**/bvc2/bvc2-core.wasm', route => route.fulfill({
  status: 404, contentType: 'text/plain', body: 'not installed for this test'
}));
page.route(url => url.pathname.startsWith('/api/'), route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/series') {
    const input = url.searchParams.get('input');
    const many = input === '60' || input === '99';
    const restricted = input === '99';
    const vvc = input === '770';
    const count = vvc ? 1 : many ? 60 : 2;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        kind: 'series', seriesId: vvc ? '770' : restricted ? '99' : many ? '60' : '42',
        title: vvc ? 'VVC 編碼測試' : restricted ? '受限測試' : many ? '六十集測試' : '播放測試短劇',
        total: count, accessible: restricted ? 5 : count,
        episodes: Array.from({ length: count }, (_, i) => ({
          vid: vvc ? '77030' : String((many ? 1000 : 101) + i),
          index: vvc ? 30 : i + 1, available: !restricted || i < 5
        }))
      })
    });
  }
  if (url.pathname === '/api/source') {
    calls.push(url.searchParams.toString());
    if (url.searchParams.get('vid') === '77030') return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ variants: [
        { url: 'https://cdn.fqnovelvod.com/hevc-1080.mp4', codec: 'hevc',
          quality: '1080p', source: 'app', contentKey: '00112233445566778899aabbccddeeff' },
        { url: 'https://cdn.fqnovelvod.com/vvc-720.mp4', codec: 'bytevc2',
          quality: '720p', source: 'app', width: 1280, height: 720,
          contentKey: '00112233445566778899aabbccddeeff' }
      ] })
    });
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ variants: [
        { url: 'https://cdn.fqnovelvod.com/' + url.searchParams.get('vid') + '-hi.mp4',
          codec: 'h264', quality: '1080p', source: 'web', contentKey: null, width: 1920, height: 1080 },
        { url: 'https://cdn.fqnovelvod.com/' + url.searchParams.get('vid') + '.mp4',
          codec: 'h264', quality: '720p', source: 'web', contentKey: null, width: 1280, height: 720 },
        { url: 'https://cdn.fqnovelvod.com/' + url.searchParams.get('vid') + '-low.mp4',
          codec: 'bytevc2', quality: '540p', source: 'app', contentKey: null, width: 960, height: 540 }
      ] })
    });
  }
  if (url.pathname === '/api/media') {
    if (url.searchParams.get('url')?.includes('vvc-720.mp4'))
      throw new Error('Encrypted VVC must not be sent to FFmpeg.wasm');
    return route.fulfill({
      status: 200, contentType: 'video/mp4',
      headers: {
        'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
        'Content-Length': String(sample.length)
      }, body: sample
    });
  }
  return route.continue();
});
const base = 'http://127.0.0.1:4173/hongguo-dl/';
async function waitCompleted(count, timeout = 120000) {
  await page.waitForFunction(n =>
    document.querySelectorAll('#queue .status.s-completed').length >= n, count,
    { timeout });
}
async function zipInspect(path, count, first = '第001集.mp4', last = null) {
  const script = [
    'import sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as f:',
    '  names=f.namelist()',
    '  assert len(names)==int(sys.argv[2]), len(names)',
    '  assert names[0].endswith(sys.argv[3]), names[0]',
    '  if sys.argv[4]!="-": assert names[-1].endswith(sys.argv[4]), names[-1]',
    '  assert all(f.read(name) == open(sys.argv[5],"rb").read() for name in names)',
    '  assert f.testzip() is None'
  ].join('\n');
  const result = spawnSync('python3', ['-c', script, path, String(count),
    first, last || '-', process.argv[2]], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
try {
  await page.goto(base + '?id=42&id=60', { waitUntil: 'load' });
  await page.locator('button[data-linked-id="60"]').waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await page.locator('#series-title').textContent(), '播放測試短劇');
  assert.deepEqual(await page.locator('#episodes label > span').allTextContents(), ['1', '2']);
  assert.equal(await page.locator('button[data-linked-id]').count(), 2);
  await page.locator('#mode-play').click();
  assert.deepEqual(await page.locator('#episodes button.play-episode > span:first-child').allTextContents(),
    ['1', '2']);
  await page.locator('#player-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#player-video').evaluate(v => v.controls), false,
    'Video.js replaces the browser native video-only fullscreen');
  assert.equal(await page.locator('video-player > media-container').count(), 1);
  assert.equal(await page.locator('media-controls media-time-slider').count(), 1);
  assert.equal(await page.locator('media-controls media-play-button').count(), 1);
  assert.equal(await page.locator('media-controls media-fullscreen-button').count(), 1);
  assert.equal(await page.evaluate(() => Boolean(window.customElements?.get('video-player'))), true,
    'Video.js video-player custom element must be registered');
  assert.equal(await page.locator('#player-prev').isVisible(), true);
  assert.equal(await page.locator('#player-play-pause').isVisible(), true);
  assert.equal(await page.locator('#player-next').isVisible(), true);
  assert.equal(await page.locator('#player-mute').isVisible(), true);
  assert.equal(await page.locator('#player-fullscreen').isVisible(), true);
  const initiallyMuted = await page.locator('#player-video').evaluate(v => v.muted);
  await page.locator('#player-mute').click();
  await page.waitForFunction(original =>
    document.querySelector('#player-video').muted !== original, initiallyMuted);
  await page.locator('#player-mute').click();
  await page.waitForFunction(original =>
    document.querySelector('#player-video').muted === original, initiallyMuted);
  await page.waitForFunction(() => document.querySelector('#player-episode')?.textContent.includes('第 1 集'));
  await page.locator('#player-settings-toggle').click();
  await page.locator('#player-settings').waitFor({ state: 'visible' });
  await page.locator('#player-quality').selectOption('720p');
  await page.locator('#player-codec').selectOption('h264');
  await page.locator('#player-speed').selectOption('1.25');
  await page.waitForFunction(() => document.querySelector('#player-video')?.playbackRate === 1.25);
  await page.waitForFunction(() =>
    document.querySelector('#player-source-info')?.textContent?.includes('1280×720'));
  assert.equal(await page.locator('#player-quality option[value="540p"]').isDisabled(), false,
    'Player should expose available 540p rendition');
  assert(calls.some(c => c.includes('quality=auto') && c.includes('codec=auto')),
    'Player must retrieve available variants before choosing local source');
  await page.locator('#player-settings-toggle').click();
  await page.waitForFunction(() => document.querySelector('#player-video').readyState >= 1);
  // Pagehide must abort the active media source rather than only saving time.
  // A persisted pageshow simulates BFCache return on the same document.
  await page.evaluate(() => window.dispatchEvent(
    new PageTransitionEvent('pagehide', { persisted: true })));
  await page.waitForFunction(() => {
    const video = document.querySelector('#player-video');
    return video && !video.getAttribute('src') && video.paused &&
      video.readyState === HTMLMediaElement.HAVE_NOTHING;
  });
  await page.evaluate(() => window.dispatchEvent(
    new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(() => {
    const video = document.querySelector('#player-video');
    return video && video.getAttribute('src') && video.readyState >= 1 &&
      video.playbackRate === 1.25 && video.paused &&
      document.querySelector('#player-episode')?.textContent.includes('第 1 集');
  }, null, { timeout: 30000 });
  console.log('PASS Firefox pagehide aborts current media and BFCache return reopens paused');
  // Exercise near-end automatic prefetch without waiting for a real episode to
  // finish. The current 4-second mock video stays active while episode 2 is
  // looked up. Overrides are removed immediately after dispatch.
  const priorPrefetches = calls.filter(x => x.includes('vid=102')).length;
  await page.locator('#player-video').evaluate(video => {
    Object.defineProperties(video, {
      duration: { configurable: true, get: () => 200 },
      currentTime: { configurable: true, get: () => 190 },
      paused: { configurable: true, get: () => false }
    });
    video.dispatchEvent(new Event('timeupdate'));
    delete video.duration;
    delete video.currentTime;
    delete video.paused;
  });
  for (let i = 0; i < 50 && calls.filter(x => x.includes('vid=102')).length <= priorPrefetches; i++)
    await page.waitForTimeout(50);
  assert(calls.filter(x => x.includes('vid=102')).length > priorPrefetches,
    'Next episode must be prefetched before the current episode ends');
  assert.match(await page.locator('#player-episode').textContent(), /第 1 集/,
    'Prefetch must not change the currently playing episode');
  assert.equal(await page.locator('#player-play-pause').isVisible(), true);
  assert.equal(await page.locator('#player-seek').isVisible(), true);
  assert.equal(await page.locator('#player-stage').evaluate(el =>
    getComputedStyle(el.querySelector('#player-video')).width !== '0px'), true);
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.locator('#player-fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'player-stage',
      null, { timeout: 8000 });
    await page.locator('#player-settings-toggle').click();
    assert.equal(await page.locator('#player-settings').isVisible(), true,
      'Quality and codec settings remain available when fullscreen');
    await page.locator('#player-settings-close').click();
    await page.locator('#player-fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement === null,
      null, { timeout: 8000 });
  }
  await page.locator('#player-video').evaluate(video => {
    video.pause();
    video.currentTime = 1.6;
    video.dispatchEvent(new Event('seeked'));
  });
  await page.waitForFunction(() => {
    const x = JSON.parse(localStorage.getItem('hongguo-dl-playback-history-v1') || '{}');
    return x['42:101']?.seconds >= 1.3;
  });
  const partialTile = await page.locator('button[data-play-vid="101"]').getAttribute('style');
  assert.match(partialTile, /--watch-progress:\s*[1-9]\d*%/);
  assert.equal(await page.locator('#episodes .watch-track').count(), 0,
    'Watch progress should fill the tile background, not a bottom bar');
  await page.waitForFunction(() => {
    const tile = document.querySelector('button[data-play-vid="101"]');
    return tile?.isConnected && getComputedStyle(tile).backgroundImage.includes('linear-gradient');
  }, null, { timeout: 8000 });
  const tileAppearance = await page.evaluate(() => {
    const el = document.querySelector('button[data-play-vid="101"]');
    return { background: getComputedStyle(el).backgroundImage, height: el.getBoundingClientRect().height };
  });
  assert.match(tileAppearance.background, /linear-gradient/, 'Playback progress fills the tile');
  assert(tileAppearance.height <= 54, 'Episode tiles must be compact');
  await page.waitForFunction(() => {
    const slider = document.querySelector('#player-seek');
    const fill = getComputedStyle(slider).getPropertyValue('--media-slider-fill');
    return parseFloat(fill) > 0;
  }, null, { timeout: 8000 });
  const videoJsProgress = await page.locator('#player-seek').evaluate(el =>
    getComputedStyle(el).getPropertyValue('--media-slider-fill'));
  assert(parseFloat(videoJsProgress) > 0, 'Video.js slider tracks playback progress');
  await page.reload();
  await page.locator('button[data-linked-id="60"]').waitFor({ state: 'visible' });
  await page.locator('#mode-play').click();
  await page.waitForFunction(() =>
    document.querySelector('#player-episode')?.textContent.includes('第 1 集'));
  await page.waitForFunction(() => document.querySelector('#player-video')?.currentTime >= 1.25,
    null, { timeout: 30000 });
  assert((await page.locator('button[data-play-vid="101"]').getAttribute('style'))
    ?.includes('--watch-progress:'));
  await page.locator('#player-video').evaluate(v => v.dispatchEvent(new Event('ended')));
  await page.waitForFunction(() => document.querySelector('#player-episode')?.textContent.includes('第 2 集'));
  const played = await page.evaluate(() => JSON.parse(localStorage.getItem('hongguo-dl-playback-history-v1') || '{}'));
  assert.equal(played['42:101']?.completed, true);

  await page.locator('#mode-download').click();
  const before = downloadEvents;
  await page.locator('#add-queue').click();
  await waitCompleted(2);
  assert.equal(downloadEvents, before, 'No automatic per-episode save prompts');
  assert.equal(await page.locator('#queue [data-action="save"]').count(), 2);
  assert.equal(await page.locator('#queue .job-filename').count(), 0,
    'Download queue must not display output filenames');
  assert.deepEqual(await page.locator('#queue .job-topline b').allTextContents(),
    ['播放測試短劇 · 第 1 集', '播放測試短劇 · 第 2 集']);
  assert.deepEqual(await page.locator('#queue .status.s-completed').allTextContents(),
    ['可匯出', '可匯出']);
  assert.equal(await page.locator('#queue .job-meta').count(), 0,
    'Completed default-quality jobs should not repeat status or storage details');
  assert.equal(await page.locator('.export-hint').count(), 0);
  assert.equal(await page.locator('footer').count(), 0);
  const localDownload = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#queue button[data-action="save"]').first().click();
  const individual = await localDownload;
  assert.match(individual.suggestedFilename(), /^播放測試短劇\.E0[12]\.mp4$/);
  assert(statSync(await individual.path()).size > 100);

  const beforeZip = calls.length;
  const archiveEvent = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#bulk-zip').click();
  const archive = await archiveEvent;
  await zipInspect(await archive.path(), 2, '播放測試短劇.E01.mp4', '播放測試短劇.E02.mp4');
  assert.equal(calls.length, beforeZip, 'Export must not fetch sources twice');
  assert.equal(downloadEvents, before + 2, 'Only manual save plus one ZIP');
  // The same staged queue items must be muxed into one MP4 without another
  // source request. Probe the output with system FFprobe to verify duration,
  // original video codec and absence of inadvertently muxed subtitle streams.
  const beforeMp4 = calls.length;
  const mp4Event = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#bulk-concat').click();
  const joined = await mp4Event;
  assert.match(joined.suggestedFilename(), /\.mp4$/);
  const joinedPath = await joined.path();
  assert(joinedPath && statSync(joinedPath).size > sample.length);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_name,codec_type', '-of', 'json', joinedPath], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  const metadata = JSON.parse(probe.stdout);
  assert(Number(metadata.format.duration) >= 7,
    'Losslessly joined MP4 should contain at least 7 seconds from two 4-second inputs');
  assert(metadata.streams.some(stream => stream.codec_name === 'h264'));
  assert(metadata.streams.every(stream => stream.codec_type !== 'subtitle'));
  assert.equal(calls.length, beforeMp4, 'Lossless concat must use staged files without re-fetching');

  await page.locator('button[data-linked-id="60"]').click();
  await page.locator('#queue-select-none').click();
  await page.locator('#add-queue').click();
  await waitCompleted(62, 180000);
  const titles = await page.locator('#queue .job-topline b').allTextContents();
  const sixty = titles.filter(x => x.startsWith('六十集測試 · '));
  assert.equal(sixty.length, 60);
  assert.equal(sixty[0], '六十集測試 · 第 1 集');
  assert.equal(sixty[59], '六十集測試 · 第 60 集');
  assert(!titles.some(x => /第 00\d 集/.test(x)), 'Queue must not display filename zero-padding');
  const selected = await page.locator('#queue input[data-export-id]:checked').count();
  assert.equal(selected, 60, 'Only newly queued 60 episodes selected for export');
  const beforeFullZip = downloadEvents;
  const fullZipEvent = page.waitForEvent('download', { timeout: 180000 });
  await page.locator('#bulk-zip').click();
  const fullZip = await fullZipEvent;
  assert.equal(downloadEvents, beforeFullZip + 1);
  const fullPath = await fullZip.path();
  await zipInspect(fullPath, 60, '六十集測試.E01.mp4', '六十集測試.E60.mp4');
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto(base + '?id=99', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#series-title')?.textContent === '受限測試');
  assert.match(await page.locator('#series-count').textContent(), /55 集可能受限制/);
  assert.equal(await page.locator('#episodes small').count(), 0);
  assert.equal(await page.locator('#episodes label').nth(5).textContent(), '6');
  assert.match(await page.locator('#episodes label').nth(5).locator('input').getAttribute('aria-label'),
    /可能受限制/);
  await page.locator('#mode-play').click();
  await page.locator('#player-panel').waitFor({ state: 'visible' });
  const mobile = await page.evaluate(() => {
    const stage = document.querySelector('#player-stage').getBoundingClientRect();
    const controls = document.querySelector('.player-bottom-controls').getBoundingClientRect();
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      stageHeight: stage.height, controlsHeight: controls.height,
      buttonsInside: ['player-prev', 'player-play-pause', 'player-next',
        'player-settings-toggle', 'player-fullscreen'].every(id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return rect.left >= stage.left && rect.right <= stage.right;
      })
    };
  });
  assert.equal(mobile.horizontalOverflow, false, 'Mobile layout must not scroll sideways');
  assert.equal(mobile.buttonsInside, true, 'All mobile controls should fit in the player');
  assert(mobile.controlsHeight < mobile.stageHeight * 0.5,
    'Controls should not obscure most of the video on mobile');

  // A prepared next episode must be handed off without another /api/source call.
  await page.evaluate(() => localStorage.removeItem('hongguo-dl-playback-history-v1'));
  await page.goto(base + '?id=42', { waitUntil: 'load' });
  await page.locator('#mode-play').click();
  await page.waitForFunction(() => document.querySelector('#player-video')?.readyState >= 1);
  const nextBefore = calls.filter(x => x.includes('vid=102')).length;
  await page.locator('#player-video').evaluate(video => {
    Object.defineProperties(video, {
      duration: { configurable: true, get: () => 200 },
      currentTime: { configurable: true, get: () => 190 },
      paused: { configurable: true, get: () => false }
    });
    video.dispatchEvent(new Event('timeupdate'));
    delete video.duration;
    delete video.currentTime;
    delete video.paused;
  });
  for (let i = 0; i < 50 && calls.filter(x => x.includes('vid=102')).length <= nextBefore; i++)
    await page.waitForTimeout(50);
  const nextFetched = calls.filter(x => x.includes('vid=102')).length;
  assert(nextFetched > nextBefore, 'Near-end play should request only the upcoming source');
  await page.locator('#player-video').evaluate(video => video.dispatchEvent(new Event('ended')));
  await page.waitForFunction(() => document.querySelector('#player-episode')?.textContent.includes('第 2 集'));
  await page.waitForFunction(() => document.querySelector('#player-video')?.readyState >= 1);
  assert.equal(calls.filter(x => x.includes('vid=102')).length, nextFetched,
    'Handoff to prefetched episode must reuse the in-flight source, without duplicate lookup');

  // The actual episode-30 source has encrypted HEVC at 1080p, and encrypted
  // ByteVC2/VVC at 720p. It must fail clearly and BEFORE fetching 720p bytes.
  await page.goto(base + '?id=770', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#series-title')?.textContent === 'VVC 編碼測試');
  await page.locator('#mode-play').click();
  await page.locator('#player-settings-toggle').click();
  await page.locator('#player-quality').selectOption('720p');
  await page.waitForFunction(() =>
    document.querySelector('#player-codec option[value="auto"]')?.textContent.includes('ByteVC2/VVC'));
  await page.waitForFunction(() => document.querySelector('#player-codec option[value="hevc"]')?.disabled,
    null, { timeout: 8000 });
  assert.equal(await page.locator('#player-codec option[value="hevc"]').evaluate(el => el.disabled), true,
    'HEVC must not be offered at VVC-only 720p');
  assert.equal(await page.locator('#player-quality').inputValue(), '720p',
    'Unsupported known tier must remain selected, not silently become 1080p');
  await page.waitForFunction(() =>
    document.querySelector('#player-status')?.textContent.includes('無法播放'));
  assert.match(await page.locator('#player-status').textContent(), /720p.*ByteVC2\/VVC/);
  console.log('Firefox multi-id, reload resume, in-player settings, staged queue, 60-episode ZIP PASSED:',
    statSync(fullPath).size, 'bytes');
  if (errors.length) console.log('Browser console diagnostics:', errors);
} catch (error) {
  console.error('Browser integration failed:', error);
  console.error('Page errors:', errors);
  console.error('Source calls:', calls.slice(-12));
  console.error('Queue summary:', await page.locator('#queue-summary').textContent().catch(() => null));
  console.error('Batch status:', await page.locator('#bulk-status').textContent().catch(() => null));
  console.error('Player status:', await page.locator('#player-status').textContent().catch(() => null));
  throw error;
} finally { await browser.close(); }
