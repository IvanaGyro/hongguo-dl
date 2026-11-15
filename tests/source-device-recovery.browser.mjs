// Public UI and API boundary: synthetic responses, no third-party media.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const bytes = readFileSync(process.argv[2]);
const app = process.env.TEST_APP_URL || 'http://127.0.0.1:4173/hongguo-dl/';
const browser = await chromium.launch({ headless: true });
try {
  for (const failures of [2, 3]) {
    const page = await browser.newPage();
    let registrations = 0, sources = 0;
    const devices = [], identities = [];
    let release;
    await page.addInitScript(() => {
      localStorage.setItem('hongguo-dl-worker-origin-v1', location.origin);
      window.__HONGGUO_START_MODE = 'download';
    });
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/health') return route.fulfill({ json: {
        ok: true, sourceChannels: true, deviceSessions: true, deviceProfile: 'fixture-v1'
      } });
      if (url.pathname === '/api/series') return route.fulfill({ json: {
        kind: 'series', seriesId: '42', title: 'Device recovery fixture', total: 1,
        episodes: [{ vid: '1', index: 1, available: true }]
      } });
      if (url.pathname === '/api/device') {
        registrations++; devices.push(route.request().postDataJSON().installation);
        if (registrations > 1 && registrations <= failures + 1) {
          // Keep each attempt visible so status assertions observe all three.
          await new Promise(resolve => setTimeout(resolve, 100));
          return route.fulfill({ status: 502, json: { error: { code: 'DEVICE_REGISTRATION_FAILED', message: 'fixture refusal' } } });
        }
        return route.fulfill({ json: { ...devices.at(-1), device_id: String(registrations),
          iid: String(100 + registrations), registeredAt: Date.now() } });
      }
      if (url.pathname === '/api/source') {
        if (url.searchParams.get('channel') === 'web') return route.fulfill({ status: 404, json: { error: { code: 'PUBLIC_SOURCE_UNAVAILABLE' } } });
        sources++; identities.push(JSON.parse(route.request().headers()['x-playback-device']));
        if (sources === 1) {
          await new Promise(resolve => { release = resolve; });
          return route.fulfill({ status: 502, json: { error: {
            code: 'EMPTY_RESPONSE', message: 'upstream empty 200', upstreamStatus: 200, emptyResponseCount: 3
          } } });
        }
        return route.fulfill({ json: { variants: [{ codec: 'h264', quality: '720p', source: 'app',
          url: 'https://cdn.fqnovelvod.com/recovery.mp4' }] } });
      }
      if (url.pathname === '/api/media') return route.fulfill({ contentType: 'video/mp4', body: bytes });
      throw new Error(url.pathname);
    });
    await page.route('https://cdn.fqnovelvod.com/recovery.mp4', route => route.fulfill({ contentType: 'video/mp4', body: bytes }));
    await page.goto(app + '?id=42');
    await page.waitForFunction(() => document.querySelector('#series-title')?.textContent.includes('Device recovery'));
    await page.locator('#mode-play').click();
    await page.waitForFunction(() => document.querySelector('#playback-log')?.value.includes('source-app'));
    assert.equal(sources, 1);
    release();
    if (failures === 3) {
      await page.waitForFunction(() => /請等一分鐘/.test(document.querySelector('#player-status')?.textContent || ''));
      assert.equal(registrations, 4); assert.equal(sources, 1);
      await page.waitForTimeout(1100);
      assert.equal(registrations, 4); assert.equal(sources, 1);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#series-title')?.textContent.includes('Device recovery'));
      await page.locator('#mode-play').click();
      await page.waitForFunction(() => /請等一分鐘/.test(document.querySelector('#player-status')?.textContent || ''));
      assert.equal(registrations, 4); assert.equal(sources, 1, 'Reload must respect the persisted cooldown');
      // Check persistence without waiting a real minute or changing timers:
      // move the persisted deadline to now, then reload and allow recovery.
      await page.evaluate(() => {
        const key = 'hongguo-source-device-recovery-v1';
        const state = JSON.parse(localStorage.getItem(key));
        state.cooldownUntil = Date.now() - 1;
        localStorage.setItem(key, JSON.stringify(state));
      });
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#series-title')?.textContent.includes('Device recovery'));
      await page.locator('#mode-play').click();
    }
    await page.waitForFunction(() => {
      const video = document.querySelector('#player-video');
      return video?.videoWidth > 0 && video.currentTime > 0.2;
    });
    assert.equal(registrations, failures + 2);
    assert.notEqual(identities[0].device_id, identities.at(-1).device_id);
    assert.notEqual(identities[0].cdid, identities.at(-1).cdid);
    if (failures === 2) assert.match(await page.locator('#playback-log').inputValue(), /phase=device-renew attempt=3/);
    console.log('PASS source empty-200 recovery with ' + failures + ' failed registrations, new persisted IDs and actual video frames');
    await page.close();
  }
} finally { await browser.close(); }
