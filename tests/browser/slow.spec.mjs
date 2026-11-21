// SPDX-License-Identifier: GPL-3.0-only
// Long playback, run on request: HONGGUO_SLOW=1 bunx playwright test --grep @slow
import { test, variant } from './support/app.mjs';

test.describe.configure({ timeout: 30 * 60_000 });

test('a 5-minute CENC episode survives a 2-minute pause and plays to the end @slow', async ({ app, page }) => {
  app.addSeries(42, { title: 'Long pause', episodes: [[variant('cenc-300s.mp4')], [variant('clear-short.mp4')]] });
  await page.goto('./');
  await app.open(42);
  await app.expectPlaying(1, { from: 5 });
  await app.pause();
  await page.waitForTimeout(120_000);
  await app.video().evaluate(video => video.play());
  await app.expectPlaying(1, { from: 6 });
  await app.video().evaluate(video => { video.playbackRate = 4; });
  await app.expectPlaying(2, { from: 0, timeout: 5 * 60_000 });
});

test('a 30-minute CENC episode plays to the end @slow', async ({ app, page }) => {
  app.addSeries(42, { title: 'Long episode', episodes: [[variant('cenc-1800s.mp4')], [variant('clear-short.mp4')]] });
  await page.goto('./');
  await app.open(42);
  await app.expectPlaying(1, { from: 1 });
  await app.video().evaluate(video => { video.playbackRate = 8; });
  await app.expectPlaying(2, { from: 0, timeout: 20 * 60_000 });
});
