// Actual browser storage and main.js API routing, synthetic native media only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const bytes = readFileSync(process.argv[2]);
const app = process.env.TEST_APP_URL || 'http://127.0.0.1:4173/hongguo-dl/';
const browser = await chromium.launch({ headless: true });
const devices = [], sourceDevices = [];
let failFirst = true, releaseSource, releaseDevice, releaseCdn, limitedAt = 0, retriedAt = 0;
async function configure(context) {
  await context.addInitScript(() => { window.__HONGGUO_START_MODE = 'download'; });
  await context.route('https://cdn.fqnovelvod.com/device-test*.mp4', route => media(route));
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/health') return route.fulfill({ json: {
      ok: true, sourceChannels: true, deviceSessions: true, deviceProfile: 'android-74532-redmi-v1'
    } });
    if (url.pathname === '/api/device') {
      const { installation } = request.postDataJSON(); devices.push(installation);
      if (devices.length === 1) await new Promise(resolve => { releaseDevice = resolve; });
      return route.fulfill({ json: { ...installation, device_id: String(7000000000000000000n + BigInt(devices.length)),
        iid: String(7100000000000000000n + BigInt(devices.length)), registeredAt: Date.now() } });
    }
    if (url.pathname === '/api/series') return route.fulfill({ json: { kind: 'series', seriesId: '42', title: 'Device fixture', total: 1,
      episodes: [{ vid: '16', index: 16, available: true }] } });
    if (url.pathname === '/api/source') {
      assert.equal(url.searchParams.has('device_id'), false);
      if (url.searchParams.get('channel') === 'web') {
        assert.equal(request.headers()['x-playback-device'], undefined);
        return route.fulfill({ status: 404, json: { error: { code: 'PUBLIC_SOURCE_UNAVAILABLE', message: 'no web fixture' } } });
      }
      const installation = JSON.parse(request.headers()['x-playback-device']); sourceDevices.push(installation);
      if (failFirst) { return route.fulfill({ status: 502, json: { error: { code: 'EMPTY_RESPONSE', message: 'empty fixture' } } }); }
      if (!releaseSource) await new Promise(resolve => { releaseSource = resolve; });
      return route.fulfill({ json: { variants: [{ url: 'https://cdn.fqnovelvod.com/device-test' + (limitedAt ? '-fresh' : '') + '.mp4', source: 'app', codec: 'h264', quality: '720p' }] } });
    }
    if (url.pathname === '/api/media') return media(route);
    throw new Error('Unexpected fixture path: ' + url.pathname);
  });
}
async function media(route) {
  if (route.request().headers().range === 'bytes=0-15' && !releaseCdn) await new Promise(resolve => { releaseCdn = resolve; });
  if (route.request().headers().range === 'bytes=0-15') {
    if (!limitedAt) { limitedAt = Date.now(); return route.fulfill({ status: 429, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After', 'Retry-After': '1' } }); }
    if (!retriedAt) retriedAt = Date.now();
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  const first = range ? Number(range[1]) : 0;
  const last = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4',
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range,Content-Length',
      'Accept-Ranges': 'bytes', 'Content-Length': String(last - first + 1),
      ...(range ? { 'Content-Range': `bytes ${first}-${last}/${bytes.length}` } : {}) }, body: bytes.subarray(first, last + 1) });
}
const ready = async page => {
  await page.waitForFunction(() => { const video = document.querySelector('#player-video'); return video.currentTime > 0.2 && video.videoWidth > 0; });
  await page.locator('#player-video').evaluate(video => video.pause());
};
const open = async page => {
  await page.goto(app + '?id=42');
  await page.waitForFunction(() => document.querySelector('#series-title')?.textContent.includes('Device fixture'));
  await page.locator('#mode-play').click();
};
try {
  const first = await browser.newContext(); await configure(first);
  const page = await first.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await page.waitForFunction(() => /裝置.*第 1\/20 次/.test(document.querySelector('#player-status').textContent));
  releaseDevice();
  await page.waitForFunction(() => /片源 API.*HTTP 502/.test(document.querySelector('#player-status').textContent)).catch(async error => {
    console.log({ status: await page.locator('#player-status').textContent(), log: await page.locator('#playback-log').inputValue(), errors, registrations: devices.length, sources: sourceDevices.length }); throw error;
  });
  failFirst = false;
  for (let i = 0; i < 100 && !releaseSource; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(releaseSource, 'Player must retry the source request');
  const retryText = await page.locator('#player-status').textContent();
  assert.match(retryText, /^下載｜.*App 片源／畫質候選.*第 2\/20 次/); assert.doesNotMatch(retryText, /502|空白|取不到|失敗/);
  releaseSource();
  await page.waitForFunction(() => /探測 CDN.*CDN #1.*第 1\/20 次/.test(document.querySelector('#player-status').textContent));
  releaseCdn();
  await ready(page);
  assert(retriedAt >= limitedAt);
  assert.equal(sourceDevices.length, 3, 'A CDN 429 immediately refreshes the exhausted source list');
  assert.equal(devices.length, 1); assert.equal(sourceDevices[0].device_id, sourceDevices[1].device_id);
  await open(page); await ready(page);
  assert.equal(devices.length, 1, 'Reload reuses localStorage identity');
  assert.equal(sourceDevices.at(-1).device_id, sourceDevices[0].device_id);
  const second = await browser.newContext(); await configure(second);
  const other = await second.newPage(); await open(other); await ready(other);
  assert.equal(devices.length, 2); assert.notEqual(devices[0].clientId, devices[1].clientId);
  assert.notEqual(sourceDevices.at(-1).device_id, sourceDevices[0].device_id);
  assert.deepEqual(errors, []);
  console.log('PASS: persisted browser installation, separate users, retry identity reuse and current wait text');
  await first.close(); await second.close();
} finally { releaseDevice?.(); releaseCdn?.(); releaseSource?.(); await browser.close(); }
