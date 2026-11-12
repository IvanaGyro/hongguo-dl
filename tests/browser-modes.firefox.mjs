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
page.route(url => url.pathname.startsWith('/api/'), route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/series') {
    const many = url.searchParams.get('input') === '60';
    const count = many ? 60 : 2;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        kind: 'series', seriesId: many ? '60' : '42',
        title: many ? '六十集測試' : '播放測試短劇',
        total: count, accessible: count,
        episodes: Array.from({ length: count }, (_, i) => ({
          vid: String((many ? 1000 : 101) + i), index: i + 1, available: true
        }))
      })
    });
  }
  if (url.pathname === '/api/source') {
    calls.push(url.searchParams.toString());
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ variants: [{
        url: 'https://cdn.fqnovelvod.com/' + url.searchParams.get('vid') + '.mp4',
        codec: 'h264', quality: url.searchParams.get('quality'),
        source: 'web', contentKey: null, width: 320, height: 180
      }] })
    });
  }
  if (url.pathname === '/api/media') {
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
  assert.equal(await page.locator('button[data-linked-id]').count(), 2);
  await page.locator('#mode-play').click();
  await page.locator('#player-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#player-episode')?.textContent.includes('第 1 集'));
  await page.locator('#player-settings-toggle').click();
  await page.locator('#player-settings').waitFor({ state: 'visible' });
  await page.locator('#player-quality').selectOption('720p');
  await page.locator('#player-codec').selectOption('h264');
  await page.locator('#player-speed').selectOption('1.25');
  await page.waitForFunction(() => document.querySelector('#player-video')?.playbackRate === 1.25);
  assert(calls.some(c => c.includes('quality=720p')), 'Player must request chosen quality');
  assert(calls.some(c => c.includes('codec=h264')), 'Player must request chosen codec');
  await page.locator('#player-settings-toggle').click();
  await page.waitForFunction(() => document.querySelector('#player-video').readyState >= 1);
  await page.locator('#player-video').evaluate(video => {
    video.pause();
    video.currentTime = 1.6;
    video.dispatchEvent(new Event('seeked'));
  });
  await page.waitForFunction(() => {
    const x = JSON.parse(localStorage.getItem('hongguo-dl-playback-history-v1') || '{}');
    return x['42:101']?.seconds >= 1.3;
  });
  const partialBar = await page.locator('button[data-play-vid="101"] .watch-track > span')
    .getAttribute('style');
  assert.match(partialBar, /width:\s*[1-9]\d*%/);
  await page.reload();
  await page.locator('button[data-linked-id="60"]').waitFor({ state: 'visible' });
  await page.locator('#mode-play').click();
  await page.waitForFunction(() =>
    document.querySelector('#player-episode')?.textContent.includes('第 1 集'));
  await page.waitForFunction(() => document.querySelector('#player-video')?.currentTime >= 1.25,
    null, { timeout: 30000 });
  assert((await page.locator('button[data-play-vid="101"] .watch-track > span')
    .getAttribute('style'))?.includes('width:'));
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
  const localDownload = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#queue button[data-action="save"]').first().click();
  const individual = await localDownload;
  assert(individual.suggestedFilename().includes('第00'));
  assert(statSync(await individual.path()).size > 100);

  const beforeZip = calls.length;
  const archiveEvent = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#bulk-zip').click();
  const archive = await archiveEvent;
  await zipInspect(await archive.path(), 2, '第001集.mp4', '第002集.mp4');
  assert.equal(calls.length, beforeZip, 'Export must not fetch sources twice');
  assert.equal(downloadEvents, before + 2, 'Only manual save plus one ZIP');

  await page.locator('button[data-linked-id="60"]').click();
  await page.locator('#queue-select-none').click();
  await page.locator('#add-queue').click();
  await waitCompleted(62, 180000);
  const selected = await page.locator('#queue input[data-export-id]:checked').count();
  assert.equal(selected, 60, 'Only newly queued 60 episodes selected for export');
  const beforeFullZip = downloadEvents;
  const fullZipEvent = page.waitForEvent('download', { timeout: 180000 });
  await page.locator('#bulk-zip').click();
  const fullZip = await fullZipEvent;
  assert.equal(downloadEvents, beforeFullZip + 1);
  const fullPath = await fullZip.path();
  await zipInspect(fullPath, 60, '第001集.mp4', '第060集.mp4');
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
