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

test('a page with no series yet says more may follow, and a card opened during "load more" wins', async ({ app, page }) => {
  app.health = { ok: true, sourceChannels: true, deviceSessions: true, deviceProfile: 'fixture-v1' };
  app.addSeries(81, { title: '第二頁的劇', episodes: [[variant('clear.mp4')]] });
  app.searchPages['只有片段'] = [[], [result(81, '第二頁的劇', '簡介')], [result(82, '第三頁', '簡介')]];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  // Page 3 hangs until the test lets it through.
  app.fault('search', async ({ page: n }) => { if (n === 3) await held; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await page.locator('#input-url').fill('只有片段');
  await page.locator('#lookup-button').click();
  await expect(page.locator('#search-heading')).toHaveText('這一頁沒有「只有片段」的短劇，可再載入更多');
  await expect(page.locator('#search-more')).toBeVisible();

  await page.locator('#search-more').click();
  await expect(page.locator('#search-list .search-card')).toHaveCount(1);
  await page.locator('#search-more').click();
  await expect.poll(() => app.requestsOf('search').length).toBe(3);
  await page.locator('#search-list .search-card').first().click();
  await expect(page.locator('#series-title')).toHaveText('第二頁的劇');
  // The opened series is brought into view on a phone, above the fold of the results.
  await expect(page.locator('#player-panel')).toBeInViewport();
  release();
  // The superseded page neither adds cards nor reports over the opened series.
  await page.waitForTimeout(500);
  await expect(page.locator('#search-list .search-card')).toHaveCount(1);
  await expect(page.locator('#lookup-error')).toBeHidden();
  await expect(page.locator('#lookup-button')).toBeEnabled();
  await expect(page.locator('#search-more')).toBeEnabled();
});

test('search never rotates the device or retries an empty upstream answer', async ({ app, page }) => {
  app.health = { ok: true, sourceChannels: true, deviceSessions: true, deviceProfile: 'fixture-v1' };
  app.fault('search', () => ({ status: 502, headers: { 'Access-Control-Allow-Origin': '*' },
    json: { error: { code: 'EMPTY_RESPONSE', message: 'App 接口返回空響應（HTTP 200）', upstreamStatus: 200, emptyResponseCount: 1 } } }));
  await page.goto('./');
  for (let i = 0; i < 4; i++) {
    await page.locator('#input-url').fill('閃婚' + i);
    await page.locator('#lookup-button').click();
    await expect(page.locator('#lookup-error')).toContainText('空響應');
  }
  expect(app.requestsOf('search')).toHaveLength(4);
  expect(app.requestsOf('device')).toHaveLength(1);
});
