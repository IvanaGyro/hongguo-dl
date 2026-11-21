// SPDX-License-Identifier: GPL-3.0-only
// Watching a series, end to end, for every source format the app plays.
// One flow per format: each step depends on the one before, as for a user.
import { test, expect, variant, supports } from './support/app.mjs';

const FORMATS = [
  { name: 'clear MP4', media: 'clear.mp4', needs: 'h264-aac-mse' },
  { name: 'CENC progressive MP4', media: 'cenc.mp4', needs: 'h264-aac-mse' },
  { name: 'CENC fragmented MP4 (sidx)', media: 'cenc-fmp4-sidx.mp4', needs: 'clear-key',
    knownBug: 'native EME route drops a seek made in the first seconds after the episode (re)starts' },
  { name: 'CENC fragmented MP4 (mfra)', media: 'cenc-fmp4-mfra.mp4', needs: 'clear-key',
    knownBug: 'native EME route drops a seek made in the first seconds after the episode (re)starts' },
  { name: 'CENC fragmented MP4 (no index)', media: 'cenc-fmp4-none.mp4', needs: 'h264-mse',
    knownBug: 'after a restart, a seek on the no-index remux route lands short and stalls' }
];

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
      await app.seek(150);
      await app.expectPlaying(1, { from: 150, to: 160 });
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
      await app.seek(duration - 2);
      await app.expectPlaying(2, { from: 0, to: 10 });
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
