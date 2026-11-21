// SPDX-License-Identifier: GPL-3.0-only
// Layout of the real page at phone, tablet and desktop widths, and a very
// long series. Screenshots are attached to the report for review.
import { test, expect, variant } from './support/app.mjs';

const WIDTHS = [1440, 1024, 768, 390, 320];
const HISTORY = id => ({ [id + '001']: { seconds: 100, duration: 100, completed: true, viewedAt: 1 },
  [id + '013']: { seconds: 35, duration: 100, completed: false, viewedAt: 3 },
  [id + '014']: { seconds: 62, duration: 100, completed: false, viewedAt: 2 } });

async function seedHistory(context, id) {
  await context.addInitScript(([id, history]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('hongguo-dl-playback-history-v1', JSON.stringify(
      Object.fromEntries(Object.entries(history).map(([vid, v]) => [id + ':' + vid, v]))));
  }, [id, HISTORY(id)]);
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const [name, media] of [['landscape', 'clear.mp4'], ['portrait', 'clear-portrait.mp4']]) {
  test(`watch page fits every width (${name} video)`, async ({ app, page, context }, testInfo) => {
    await seedHistory(context, '42');
    app.addSeries(42, { title: '版面測試', episodes: Array.from({ length: 60 }, () => [variant(media)]) });
    await page.goto('./');
    await app.open(42);
    await app.expectPlaying(13, { from: 0 });
    await app.pause();
    await test.step('episode tiles show watch progress as a fill', async () => {
      await expect(app.episodeButton(1)).toHaveAttribute('data-watch-percent', '100');
      await expect(app.episodeButton(1)).toHaveClass(/watched/);
      await expect(app.episodeButton(14)).toHaveAttribute('data-watch-percent', '62');
      await expect.poll(() => app.episodeButton(14).evaluate(el => getComputedStyle(el).backgroundImage))
        .toContain('linear-gradient(');
    });
    for (const width of WIDTHS) {
      await test.step(`${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        expect(await overflow(page), 'no horizontal scroll').toBeLessThanOrEqual(1);
        const player = await page.locator('#player-panel').boundingBox();
        const episodes = await page.locator('#episodes').boundingBox();
        if (width > 820) expect(player.x + player.width, 'episodes beside the player').toBeLessThan(episodes.x);
        else expect(player.y + player.height, 'episodes below the player').toBeLessThanOrEqual(episodes.y + 1);
        for (const id of ['#player-prev', '#player-next'])
          expect((await page.locator(id).boundingBox()).width, id + ' is a usable target').toBeGreaterThanOrEqual(40);
        if (name === 'portrait' && width <= 390) {
          const video = await app.video().boundingBox();
          expect(video.height, 'a portrait episode gets a tall player').toBeGreaterThan(video.width * 1.4);
        }
        await testInfo.attach(`watch-${name}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      });
    }
  });
}

test('download page fits every width', async ({ app, page }, testInfo) => {
  app.addSeries(42, { title: '版面測試', episodes: Array.from({ length: 60 }, () => [variant('clear-short.mp4')]) });
  await page.goto('./');
  await app.open(42);
  await app.mode('download');
  await page.locator('#select-none').click();
  for (const i of [0, 1, 2]) await page.locator('#episodes input[data-vid]').nth(i).check();
  await page.locator('#add-queue').click();
  await expect(page.locator('#queue .status.s-completed')).toHaveCount(3, { timeout: 60_000 });
  for (const width of WIDTHS) {
    await test.step(`${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      expect(await overflow(page), 'no horizontal scroll').toBeLessThanOrEqual(1);
      await expect(page.locator('#download-controls')).toBeVisible();
      await expect(page.locator('#queue-panel')).toBeVisible();
      await testInfo.attach(`download-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
  }
});

test('a 1000-episode series pages its grid and its queue', async ({ app, page, context }, testInfo) => {
  const id = '9000';
  await context.addInitScript(id => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('hongguo-dl-playback-history-v1', JSON.stringify({ [id + ':' + id + '521']: {
      seconds: 62, duration: 100, completed: false, viewedAt: 9 } }));
  }, id);
  app.addSeries(id, { title: '千集測試', episodes: Array.from({ length: 1000 }, () => [variant('clear-short.mp4')]) });
  app.fault('media', () => new Promise(() => {}));
  await page.goto('./');
  await app.open(id);

  await test.step('the grid renders 100 episodes at a time and jumps to an episode', async () => {
    await expect(page.locator('#episodes .play-episode')).toHaveCount(100);
    await expect(page.locator('#episodes .play-episode.current')).toHaveText('521');
    await expect(page.locator('#episode-range')).toContainText('501–600 / 1000');
    await expect(page.locator('#episodes .play-episode.current')).toHaveAttribute('data-watch-percent', '62');
    await page.locator('#episode-next-range').click();
    await expect(page.locator('#episode-range')).toContainText('601–700');
    await page.locator('#episode-jump').fill('42');
    await page.locator('#episode-jump-form button').click();
    await expect(page.locator('#episode-range')).toContainText('1–100');
  });

  await test.step('queueing the whole series pages the queue as well', async () => {
    await app.mode('download');
    await expect(page.locator('#series-count')).toContainText('已選 1000 集');
    await page.locator('#add-queue').click();
    await expect(page.locator('#queue .job')).toHaveCount(100);
    await expect(page.locator('#queue-range')).toContainText('1–100 / 1000');
    await page.locator('#queue-next-range').click();
    await expect(page.locator('#queue-range')).toContainText('101–200 / 1000');
    await testInfo.attach('series-1000', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  });

  await test.step('the settings menu changes playback speed', async () => {
    await app.mode('play');
    await page.locator('#player-settings-toggle').click();
    await page.locator('#player-settings [data-settings-target="speed"]').click();
    await expect(page.locator('#player-speed-options .player-settings-choice')).toHaveCount(7);
    await page.locator('#player-speed-options [data-choice-value="1.5"]').click();
    await expect(page.locator('#player-speed-summary')).toHaveText('1.5×');
    await expect(app.video()).toHaveJSProperty('playbackRate', 1.5);
  });
});
