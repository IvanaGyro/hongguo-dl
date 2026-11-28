// SPDX-License-Identifier: GPL-3.0-only
// Downloading episodes, end to end: queue, survive a reload, save one
// episode, export a ZIP, merge into one MP4, and recover an interrupted job.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { testWithProfile as test, expect, variant } from './support/app.mjs';
import { mediaPath } from './support/fixtures.mjs';

const completed = page => page.locator('#queue .status.s-completed');

function zipEntries(path) {
  const script = 'import sys,zipfile,json\nwith zipfile.ZipFile(sys.argv[1]) as f:\n' +
    '  assert f.testzip() is None\n  print(json.dumps([[n, f.read(n).hex()[:64], len(f.read(n))] for n in f.namelist()]))';
  const result = spawnSync('python3', ['-c', script, path], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function probe(path) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_name,codec_type', '-of', 'json', path], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const decodes = path => spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'],
  { encoding: 'utf8' }).status === 0;

test('download a series: queue, reload, save, ZIP and merged MP4', async ({ app, page, browserName }) => {
  const source = readFileSync(mediaPath('clear-short.mp4'));
  // ASCII title: headless Chromium replaces a non-ASCII download name with
  // "download", which says nothing about the app.
  app.addSeries(42, { title: 'Download test', episodes: [[variant('clear-short.mp4')], [variant('clear-short.mp4')]] });
  let prompts = 0;
  page.on('download', () => prompts++);

  await test.step('queueing the selected episodes finishes them without save prompts', async () => {
    await page.goto('./');
    await app.open(42);
    await app.mode('download');
    await page.locator('#add-queue').click();
    await app.expectQueueCompleted(2, 60_000);
    await expect(completed(page)).toHaveText(['可匯出', '可匯出']);
    await expect(page.locator('#queue .job-topline b')).toHaveText(['Download test · 第 1 集', 'Download test · 第 2 集']);
    expect(prompts).toBe(0);
  });

  await test.step('the finished queue survives a reload', async () => {
    await page.reload();
    await app.mode('download');
    await expect(completed(page)).toHaveCount(2);
  });

  await test.step('saving one episode gives the original file', async () => {
    const download = page.waitForEvent('download');
    await page.locator('#queue [data-action="save"]').first().click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Download test\.E0[12]\.mp4$/);
    expect(readFileSync(await file.path()).equals(source)).toBe(true);
  });

  await test.step('exporting a ZIP holds every selected episode', async () => {
    // The ZIP is streamed by a Service Worker. Playwright's Chromium and WebKit
    // capture a download by requesting its URL again from the network, so they
    // receive the app page instead of the stream. Firefox checks this step.
    if (browserName !== 'firefox') {
      test.info().annotations.push({ type: 'step skipped',
        description: `ZIP export: Playwright ${browserName} cannot capture Service Worker downloads` });
      return;
    }
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('#bulk-zip').click();
    const entries = zipEntries(await (await download).path());
    expect(entries.map(([name]) => name.split('/').pop())).toEqual(['Download test.E01.mp4', 'Download test.E02.mp4']);
    for (const [, head, size] of entries) {
      expect(size).toBe(source.length);
      expect(head).toBe(source.subarray(0, 32).toString('hex'));
    }
  });

  await test.step('merging gives one MP4 with both episodes, without fetching again', async () => {
    const sources = app.requestsOf('source').length;
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('#bulk-concat').click();
    const path = await (await download).path();
    const info = probe(path);
    expect(Number(info.format.duration)).toBeGreaterThanOrEqual(7);
    expect(info.streams.map(s => s.codec_name)).toContain('h264');
    expect(app.requestsOf('source').length).toBe(sources);
  });
});

test('download an encrypted episode: the saved MP4 plays without the key', async ({ app, page }) => {
  app.addSeries(43, { title: '加密下載', episodes: [[variant('cenc-short.mp4')]] });
  await page.goto('./');
  await app.open(43);
  await app.mode('download');
  await page.locator('#output-mode').selectOption('copy');
  await page.locator('#add-queue').click();
  await app.expectQueueCompleted(1, 120_000);
  const download = page.waitForEvent('download');
  await page.locator('#queue [data-action="save"]').click();
  const path = await (await download).path();
  expect(decodes(path), 'saved file decodes with no decryption key').toBe(true);
  expect(probe(path).streams.map(s => s.codec_name)).toContain('h264');
});

test('a job interrupted by leaving the page resumes only when retried', async ({ app, page }) => {
  app.addSeries(44, { title: '中斷下載', episodes: [[variant('clear-short.mp4')]] });
  let hold = true, release;
  const released = new Promise(resolve => { release = resolve; });
  app.fault('source', async () => { if (hold) await released; });
  await page.goto('./');
  await app.open(44);
  await app.mode('download');
  await page.locator('#add-queue').click();
  await expect.poll(() => app.requestsOf('source').length).toBeGreaterThan(0);

  await test.step('after leaving and coming back, the job is marked interrupted', async () => {
    await page.reload();
    hold = false;
    release();
    await app.mode('download');
    await expect(page.locator('#queue [data-action="retry"]')).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(completed(page)).toHaveCount(0);
  });

  await test.step('retrying finishes it', async () => {
    await page.locator('#queue [data-action="retry"]').click();
    await app.expectQueueCompleted(1, 60_000);
  });
});

test('each encoder has its own speed-to-size slider and remembers its setting', async ({ app, page }) => {
  app.addSeries(50, { title: 'Encoder tradeoff', episodes: [[variant('clear-short.mp4')]] });
  await page.goto('./');
  await app.open(50);
  await app.mode('download');
  const panel = page.locator('#encode-tradeoff');
  const slider = page.locator('#encode-speed-size');
  const name = page.locator('#encode-speed-size-name');
  await expect(panel).toBeHidden();
  await page.locator('#output-mode').selectOption('h264');
  await expect(panel).toBeVisible();
  await expect(slider).toHaveCount(1);
  await expect(name).toHaveText('快速');
  await slider.focus();
  await slider.press('End');
  await slider.press('ArrowLeft');
  await expect(slider).toHaveValue('4');
  await expect(name).toHaveText('省空間');
  await page.locator('#output-mode').selectOption('vvc');
  await expect(slider).toHaveAttribute('max', '2');
  await expect(slider).toHaveValue('0');
  await expect(page.locator('#encode-tradeoff-detail')).toContainText('VVenC faster');
  await page.locator('#output-mode').selectOption('av1');
  await expect(slider).toHaveAttribute('max', '5');
  await slider.focus();
  await slider.press('Home');
  await expect(page.locator('#encode-tradeoff-detail')).toContainText('SVT-AV1 preset 12');
  await page.reload();
  await app.open(50);
  await app.mode('download');
  await page.locator('#output-mode').selectOption('h264');
  await expect(slider).toHaveValue('4');
  await page.locator('#output-mode').selectOption('av1');
  await expect(slider).toHaveValue('0');
  await page.locator('#output-mode').selectOption('copy');
  await expect(panel).toBeHidden();
});

for (const [mode, codec] of [['hevc', 'hevc'], ['av1', 'av1']]) {
  test('download re-encoded to ' + mode + ' with the selected preset', async ({ app, page }) => {
    app.addSeries(51, { title: 'Encode ' + mode, episodes: [[variant('cenc-short.mp4')]] });
    await page.goto('./');
    await app.open(51);
    await app.mode('download');
    await page.locator('#output-mode').selectOption(mode);
    await page.locator('#encode-speed-size').focus();
    await page.locator('#encode-speed-size').press('Home');
    await page.locator('#add-queue').click();
    await app.expectQueueCompleted(1, 240_000);
    const download = page.waitForEvent('download');
    await page.locator('#queue [data-action="save"]').click();
    const saved = await download;
    expect(saved.suggestedFilename()).toContain(mode === 'av1' ? '.av1-p12.mp4' : '.hevc-ultrafast.mp4');
    const path = await saved.path();
    expect(decodes(path), 'encoded file decodes').toBe(true);
    expect(probe(path).streams.map(s => s.codec_name)).toContain(codec);
  });
}

test('the selected codec equal to the source codec is copied, not re-encoded', async ({ app, page }) => {
  app.addSeries(52, { title: 'Same codec', episodes: [[variant('cenc-short.mp4')]] });
  await page.goto('./');
  await app.open(52);
  await app.mode('download');
  await page.locator('#output-mode').selectOption('h264');
  await expect(page.locator('#encode-tradeoff-detail')).toContainText('不重新編碼');
  await page.locator('#add-queue').click();
  await app.expectQueueCompleted(1, 120_000);
  await expect(page.locator('#queue')).toContainText('來源相同，未重新編碼');
  const download = page.waitForEvent('download');
  await page.locator('#queue [data-action="save"]').click();
  const saved = await download;
  expect(saved.suggestedFilename()).not.toMatch(/\.h264-/);
  const path = await saved.path();
  expect(decodes(path), 'copied file decodes without the key').toBe(true);
  const hash = file => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-c', 'copy',
    '-f', 'hash', '-hash', 'sha256', '-'], { encoding: 'utf8' }).stdout;
  const clear = spawnSync('ffmpeg', ['-v', 'error', '-decryption_key', '00112233445566778899aabbccddeeff',
    '-i', mediaPath('cenc-short.mp4'), '-map', '0:v', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
    { encoding: 'utf8' }).stdout;
  expect(hash(path)).toBe(clear);
});
