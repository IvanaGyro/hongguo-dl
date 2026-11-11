// Integration test against the production Vite preview in real Firefox.
// Network is mocked; all media bytes come from a local synthetic MP4 fixture.
// Run: node tests/browser-modes.firefox.mjs /tmp/ffmpeg-playback.mp4
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
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.route(url => url.pathname.startsWith('/api/'), route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/series') {
    const many = url.searchParams.get('input') === '60';
    const count = many ? 60 : 2;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        kind: 'series', seriesId: many ? '60' : '42',
        title: many ? '六十集測試' : '播放測試短劇', total: count, accessible: count,
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
        codec: 'h264', quality: url.searchParams.get('quality'), source: 'web', contentKey: null
      }] })
    });
  }
  if (url.pathname === '/api/media') {
    return route.fulfill({ status: 200, contentType: 'video/mp4',
      headers: {
        'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
        'Content-Length': String(sample.length)
      }, body: sample });
  }
  return route.continue();
});
try {
  await page.goto('http://127.0.0.1:4173/hongguo-dl/', { waitUntil: 'load' });
  await page.locator('#input-url').fill('42');
  await page.locator('#lookup-button').click();
  await page.locator('#series').waitFor({ state: 'visible' });
  await page.locator('#mode-play').click();
  await page.locator('#player-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#player-episode').textContent.includes('第 1 集'));
  await page.locator('#player-quality').selectOption('720p');
  await page.waitForFunction(() => document.querySelector('#player-quality').value === '720p');
  await page.waitForTimeout(500);
  assert(calls.some(v => v.includes('quality=720p')), 'Player must request selected quality');
  await page.locator('#player-codec').selectOption('h264');
  await page.waitForTimeout(500);
  assert(calls.some(v => v.includes('codec=h264')), 'Player must request selected codec');
  await page.locator('#player-video').evaluate(video => {
    video.dispatchEvent(new Event('ended')); // deterministic auto-next trigger
  });
  await page.waitForFunction(() => document.querySelector('#player-episode').textContent.includes('第 2 集'));
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('hongguo-dl-playback-history-v1') || '{}'));
  assert.equal(state['42:101']?.completed, true, 'First episode must be marked watched');
  await page.reload();
  await page.locator('button[data-recent-id="42"]').waitFor({ state: 'visible' });
  await page.locator('button[data-recent-id="42"]').click();
  await page.locator('#series').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#series-title').textContent(), '播放測試短劇');
  await page.locator('#mode-download').click();
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#bulk-zip').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /zip$/i);
  const file = await download.path();
  assert(file && statSync(file).size > sample.length * 2);
  const check = spawnSync('python3', ['-c', `import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as f:
 assert len(f.namelist()) == 2, f.namelist()
 assert all(f.read(name) == open(sys.argv[2], 'rb').read() for name in f.namelist())
 assert f.testzip() is None`, file, process.argv[2]], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.error?.message);
  console.log('Firefox play/library/quality/autonext/ZIP64 single-download smoke PASSED; archive size:', statSync(file).size);
  // Reproduce the Android Firefox use case: 60 episodes with exactly one
  // download event, without loading 60 separate download prompts.
  await page.locator('#input-url').fill('60');
  await page.locator('#lookup-button').click();
  await page.waitForFunction(() => document.querySelector('#series-title').textContent === '六十集測試');
  const seriesDownload = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#bulk-zip').click();
  const downloaded = await seriesDownload;
  const manyFile = await downloaded.path();
  assert(manyFile && statSync(manyFile).size > sample.length * 60);
  const inspect = spawnSync('python3', ['-c', `import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as f:
 assert len(f.namelist()) == 60, len(f.namelist())
 assert f.namelist()[0].endswith('第001集.mp4')
 assert f.namelist()[-1].endswith('第060集.mp4')
 assert f.testzip() is None`, manyFile], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr || inspect.error?.message);
  console.log('Firefox sixty-episode ZIP64 single-download test PASSED; bytes:', statSync(manyFile).size);
} catch (error) {
  console.error('Browser integration failure:', error);
  console.error('Page diagnostics:', errors);
  console.error('API source requests:', calls);
  console.error('Batch status:', await page.locator('#bulk-status').textContent().catch(() => null));
  console.error('Player status:', await page.locator('#player-status').textContent().catch(() => null));
  throw error;
} finally {
  await browser.close();
}
