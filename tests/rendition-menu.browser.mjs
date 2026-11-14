// Mock only upstream media/API: exercise actual UI, source retry and CENC setup.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage();
const errors = [], sourceCalls = [];
let firstPlaybackSource = true, mediaCalls = 0;
const variants = [
  { quality: '1080p', codec: 'hevc', url: 'https://cdn.fqnovelvod.com/high.mp4', contentKey: '00112233445566778899aabbccddeeff' },
  { quality: '1080p', codec: 'h265', url: 'https://cdn.fqnovelvod.com/high2.mp4', contentKey: '00112233445566778899aabbccddeeff' },
  { quality: '720p', codec: 'h264', url: 'https://cdn.fqnovelvod.com/low.mp4' },
  { quality: '720p', codec: 'bytevc2', url: 'https://cdn.fqnovelvod.com/bvc2.mp4' }
];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const original = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) {
    return /hvc1|hev1/.test(type) ? 'probably' : original.call(this, type);
  };
});
await page.route('**/bvc2/bvc2-core.wasm', route => route.fulfill({status:404, body:'not deployed'}));
await page.route(url => url.pathname.startsWith('/api/'), async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/health') return route.fulfill({json:{ok:true,sourceChannels:false}});
  if (url.pathname === '/api/series') return route.fulfill({json:{
    kind:'series', seriesId:'42', title:'Unified rendition regression', total:60, accessible:5,
    episodes:Array.from({length:60}, (_, i) => ({index:i+1, vid:String(1000+i), available:i<5}))
  }});
  if (url.pathname === '/api/source') {
    sourceCalls.push(url.searchParams.get('vid'));
    if (url.searchParams.get('vid') === '1000' && firstPlaybackSource) {
      firstPlaybackSource = false;
      return route.fulfill({status:503,json:{error:{code:'SOURCE_UNAVAILABLE',message:'No source yet'}}});
    }
    return route.fulfill({json:{variants}});
  }
  if (url.pathname === '/api/media') {
    mediaCalls++;
    // A deterministic Range error stops before any real decode/whole-file fetch.
    assert(route.request().headers().range, 'CENC must use a bounded Range request');
    return route.fulfill({status:429,body:'rate limited fixture'});
  }
  return route.fulfill({status:404,body:'unmocked API'});
});
try {
  await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:4173/?id=42');
  await page.waitForFunction(() => document.querySelector('#quality')?.options.length === 4);
  assert.deepEqual(sourceCalls, ['1005'], 'Download choices probe one restricted episode, not all 60');
  assert.deepEqual(await page.locator('#quality option').allTextContents(),
    ['最佳可取得','1080p','720p（H.264）','720p（ByteVC2）']);
  assert.equal(await page.locator('#codec').count(),0);
  await page.locator('#quality').selectOption('720p|h264');
  await page.locator('#mode-play').click();
  await page.waitForFunction(() => document.querySelector('#playback-log')?.value.includes('cenc.prepare.failed'), null, {timeout:15000});
  const log = await page.locator('#playback-log').inputValue();
  assert.match(log, /playback.attempt.failed code=SOURCE_UNAVAILABLE attempt=1/);
  assert.match(log, /playback.attempt attempt=2/);
  assert.match(log, /cenc.prepare.begin codec=hevc/);
  assert(mediaCalls > 0, 'Retry must actually enter CENC bounded metadata probe');
  assert.equal(await page.locator('#player-codec').count(),0);
  assert.deepEqual(await page.locator('#player-quality option').allTextContents(),
    ['自動最佳','1080p','720p（H.264）','720p（ByteVC2）']);
  await page.locator('#player-settings-toggle').click();
  assert.equal(await page.locator('#player-settings [data-settings-view="root"] .player-settings-row').count(), 2);
  await page.locator('#player-settings [data-settings-target="quality"]').click();
  await page.locator('#player-quality-options [data-choice-value="720p|h264"]').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('hongguo-dl-player-preferences-v1') || '{}').codec === 'auto');
  assert.deepEqual(await page.evaluate(() => {
    const {quality,codec} = JSON.parse(localStorage.getItem('hongguo-dl-player-preferences-v1'));
    return {quality,codec};
  }), {quality:'720p',codec:'auto'});
  assert.equal(sourceCalls.filter(vid=>vid==='1005').length,1);
  assert.deepEqual(errors,[]);
  console.log('PASS unified menus, single-episode download sample, preference pair, CENC initialization after initial source failure');
} finally { await browser.close(); }
