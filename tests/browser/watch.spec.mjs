// SPDX-License-Identifier: GPL-3.0-only
// Watching a series, end to end, for every source format the app plays.
// One flow per format: each step depends on the one before, as for a user.
import { test, expect, variant, supports } from './support/app.mjs';

const FORMATS = [
  { name: 'clear MP4', media: 'clear.mp4', needs: 'h264-aac-mse' },
  { name: 'CENC progressive MP4', media: 'cenc.mp4', needs: 'h264-aac-mse' },
  { name: 'CENC fragmented MP4 (sidx)', media: 'cenc-fmp4-sidx.mp4', needs: 'clear-key', droppedSeek: true },
  { name: 'CENC fragmented MP4 (mfra)', media: 'cenc-fmp4-mfra.mp4', needs: 'clear-key', droppedSeek: true },
  { name: 'CENC fragmented MP4 (no index)', media: 'cenc-fmp4-none.mp4', needs: 'h264-mse',
    knownBug: 'after a restart, a seek on the no-index remux route lands short and stalls' }
];
// Known bug on the native EME route: a seek made in the first seconds after
// the episode (re)starts is dropped. The step records it, seeks again once
// the race window has passed, and the rest of the flow is still checked.
const DROPPED_SEEK = 'native EME route drops a seek made in the first seconds after the episode (re)starts';

async function seekAfterRestart(app, format, target, range) {
  await app.seek(target);
  if (!format.droppedSeek) return app.expectPlaying(range.index, range);
  // Episode 2 starting is the success signal for a seek to the end.
  try {
    await app.expectPlaying(range.index, { ...range, timeout: 8_000 });
    test.info().annotations.push({ type: 'known bug not seen', description: DROPPED_SEEK });
  } catch {
    test.info().annotations.push({ type: 'known bug', description: DROPPED_SEEK });
    await app.page.waitForTimeout(3_000);
    await app.seek(target);
    await app.expectPlaying(range.index, range);
  }
}

for (const format of FORMATS) {
  test(`watch a series: ${format.name}`, async ({ app, page }) => {
    const episode = () => [variant(format.media, { quality: '720p' }), variant(format.media, { quality: '480p' })];
    app.addSeries(42, { title: 'Watch flow', episodes: [episode(), episode()] });
    await page.goto('./');
    test.skip(!(await supports(page, format.needs)), `this browser lacks ${format.needs}`);
    // Known app bug: the flow asserts the correct behaviour and is expected to
    // fail until the bug is fixed; then remove `knownBug`.
    test.fail(Boolean(format.knownBug), format.knownBug);

    await test.step('opening a series by ID starts episode 1', async () => {
      await app.open(42);
      await app.expectPlaying(1, { from: 0.5 });
    });

    await test.step('the quality menu offers the episode renditions', async () => {
      expect(await app.qualityChoices()).toEqual(['自動最佳', '720p', '480p']);
    });

    await test.step('switching quality keeps playing', async () => {
      await app.chooseQuality('480p|h264');
      await expect(page.locator('#player-quality')).toHaveValue('480p|h264');
      await app.expectPlaying(1, { from: 0.2 });
    });

    await test.step('seeking to a position that is not loaded yet resumes there', async () => {
      await seekAfterRestart(app, format, 150, { index: 1, from: 150, to: 165 });
    });

    await test.step('seeking back resumes there', async () => {
      await app.seek(20);
      await app.expectPlaying(1, { from: 20, to: 30 });
    });

    await test.step('the episode grid shows watch progress', async () => {
      await app.pause();
      await expect(app.episodeButton(1)).toHaveAttribute('data-watch-percent', /^(1[0-9]|[1-9])$/);
    });

    await test.step('reopening after a reload resumes the saved position', async () => {
      await page.reload();
      await page.locator('[data-recent-id="42"]').click();
      await app.expectPlaying(1, { from: 19, to: 32 });
    });

    await test.step('at the end, the next episode starts from the beginning', async () => {
      const duration = await app.video().evaluate(video => video.duration);
      await seekAfterRestart(app, format, duration - 2, { index: 2, from: 0, to: 10 });
    });

    await test.step('leaving playback stops loading media', async () => {
      await app.mode('download');
      await page.waitForTimeout(500);
      const before = app.requestsOf('media').length;
      await page.waitForTimeout(2000);
      expect(app.requestsOf('media').length).toBe(before);
      await expect(app.video()).not.toHaveJSProperty('paused', false);
    });
  });
}

test('switching episodes quickly ends on the last one chosen', async ({ app, page }) => {
  app.addSeries(42, { title: 'Quick switch', episodes: [[variant('cenc.mp4')], [variant('clear.mp4')], [variant('clear.mp4')]] });
  // Episode 1's source answers late, after the viewer has moved on.
  let release;
  const late = new Promise(resolve => { release = resolve; });
  app.fault('source', async ({ vid }) => { if (vid === '42001') await late; });
  await page.goto('./');
  await app.open(42);
  await app.episodeButton(2).click();
  await app.episodeButton(3).click();
  await app.expectPlaying(3, { from: 0.5 });
  release();
  await page.waitForTimeout(2_000);
  await app.expectPlaying(3, { from: 0.5 });
});

test('each series remembers its own episode and position', async ({ app, page }) => {
  const two = () => [[variant('clear.mp4')], [variant('clear.mp4')]];
  app.addSeries(42, { title: 'First series', episodes: two() });
  app.addSeries(43, { title: 'Second series', episodes: two() });
  await page.goto('./');
  await app.open(42);
  await app.episodeButton(2).click();
  await app.expectPlaying(2);
  await app.seek(30);
  await app.expectPlaying(2, { from: 30, to: 40 });
  await app.open(43);
  await app.expectPlaying(1, { from: 0, to: 5 });
  await page.locator('[data-recent-id="42"]').click();
  await app.expectPlaying(2, { from: 29, to: 42 });
});

test('opening several IDs from the URL lists each series', async ({ app, page }) => {
  app.addSeries(42, { title: 'First series', episodes: [[variant('clear-short.mp4')]] });
  app.addSeries(60, { title: 'Second series', episodes: [[variant('clear-short.mp4')], [variant('clear-short.mp4')]] });
  await page.goto('./?id=42&id=60');
  await expect(page.locator('#series-title')).toHaveText('First series');
  await page.locator('button[data-linked-id="60"]').click();
  await expect(page.locator('#series-title')).toHaveText('Second series');
  await expect(page.locator('#episodes button.play-episode')).toHaveCount(2);
});
