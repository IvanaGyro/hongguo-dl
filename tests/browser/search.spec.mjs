// SPDX-License-Identifier: GPL-3.0-only
// Searching by title: result cards show cover, title and intro, page through
// the upstream cursor, and open the chosen series.
import { test, expect, variant } from './support/app.mjs';

const cover = id => `https://p3-novel.byteimg.com/novel-pic/${id}~tplv-shrink:360:0.webp`;
const result = (id, title, intro) => ({ seriesId: String(id), title, intro, episodes: 3, cover: cover('c' + id) });

test('a title search lists cover, title and intro and opens the chosen series', async ({ app, page }, testInfo) => {
  app.health = { ok: true, sourceChannels: true, deviceSessions: true, deviceProfile: 'fixture-v1' };
  app.addSeries(77, { title: '閃婚老公大十歲', episodes: [[variant('clear.mp4')], [variant('clear.mp4')], [variant('clear.mp4')]] });
  app.searchPages['閃婚'] = [
    [result(77, '閃婚老公大十歲', '桑榆走投無路時，救了傅時律的女兒。'), result(78, '與你盛夏歲歲安', '為母治病，被迫閃婚輪椅總裁。')],
    [result(78, '與你盛夏歲歲安', 'duplicate'), result(79, '<i>人前不熟</i>', '珠寶銷售許知意。')]
  ];
  await page.goto('./');
  await page.locator('#input-url').fill('閃婚');
  await page.locator('#lookup-button').click();

  const cards = page.locator('#search-list .search-card');
  await expect(cards).toHaveCount(2);
  await expect(page.locator('#search-heading')).toContainText('2 部');
  await expect(cards.first().locator('.search-title')).toHaveText('閃婚老公大十歲');
  await expect(cards.first().locator('.search-intro')).toHaveText('桑榆走投無路時，救了傅時律的女兒。');
  await expect(cards.first().locator('.search-meta')).toHaveText('全 3 集');
  await expect.poll(() => cards.first().locator('img').evaluate(img => img.complete && img.naturalWidth)).toBe(3);
  expect(app.requestsOf('search')[0].device?.device_id, 'search is signed with the browser installation').toBeTruthy();

  await page.locator('#search-more').click();
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(2).locator('.search-title')).toHaveText('<i>人前不熟</i>');
  await expect(page.locator('#search-more')).toBeHidden();
  expect(app.requestsOf('search').map(r => [r.page, r.cursor])).toEqual([[1, null], [2, 'c1']]);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}px no horizontal scroll`)
      .toBeLessThanOrEqual(1);
    await testInfo.attach(`search-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
  }

  await cards.first().click();
  await expect(page.locator('#series-title')).toHaveText('閃婚老公大十歲');
  await expect(page.locator('#input-url')).toHaveValue('77');
});

test('a numeric ID still opens the series directly and clears search results', async ({ app, page }) => {
  app.health = { ok: true, sourceChannels: true, deviceSessions: true, deviceProfile: 'fixture-v1' };
  app.addSeries(42, { title: 'Series 42', episodes: [[variant('clear.mp4')]] });
  app.searchPages['空'] = [[]];
  await page.goto('./');
  await page.locator('#input-url').fill('空');
  await page.locator('#lookup-button').click();
  await expect(page.locator('#search-heading')).toHaveText('找不到「空」相關的短劇');
  await app.open(42);
  await expect(page.locator('#search-results')).toBeHidden();
  expect(app.requestsOf('search')).toHaveLength(1);
});

test('a failed search is shown as an error, not as empty results', async ({ app, page }) => {
  app.health = { ok: true, sourceChannels: true, deviceSessions: true, deviceProfile: 'fixture-v1' };
  app.fault('search', () => ({ status: 502, json: { error: { code: 'SEARCH_REJECTED', message: '搜尋服務暫不可用（錯誤碼 100103）' } },
    headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.goto('./');
  await page.locator('#input-url').fill('閃婚');
  await page.locator('#lookup-button').click();
  await expect(page.locator('#lookup-error')).toHaveText('搜尋失敗：搜尋服務暫不可用（錯誤碼 100103）');
  await expect(page.locator('#search-results')).toBeHidden();
});
