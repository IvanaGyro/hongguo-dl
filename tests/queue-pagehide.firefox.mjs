// Browser integration: leaving a page must abort an in-flight source lookup,
// not just a media body, and an interrupted queue may only resume manually.
// Uses a synthetic delayed API response; no actual CDN or private credentials.
import assert from 'node:assert/strict';
import { firefox } from 'playwright';

const browser = await firefox.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
const page = await context.newPage();
const base = 'http://127.0.0.1:4173/hongguo-dl/';
try {
  // This route supplies only public synthetic series metadata.
  await page.route(url => url.pathname === '/api/series', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      kind: 'series', seriesId: '42', title: '佇列生命週期測試',
      total: 1, accessible: 1,
      episodes: [{ vid: '101', index: 1, available: true }]
    })
  }));
  // Make source lookup deliberately never resolve until the caller aborts.
  // This distinguishes a propagated signal from browser automatic page unload.
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let started = 0, aborted = 0, withoutSignal = 0;
    window.__sourceAbortProbe = {
      get started() { return started; },
      get aborted() { return aborted; },
      get withoutSignal() { return withoutSignal; }
    };
    window.fetch = function (input, init) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== '/api/source') return nativeFetch(input, init);
      started++;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      if (!signal) { withoutSignal++; return new Promise(() => {}); }
      return new Promise((_resolve, reject) => {
        const abort = () => {
          aborted++;
          reject(new DOMException('Synthetic delayed source request aborted', 'AbortError'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    };
    window.addEventListener('pageshow', event => {
      sessionStorage.setItem('queue-test-pageshow-persisted', String(event.persisted));
    });
    window.addEventListener('pagehide', event => {
      sessionStorage.setItem('queue-test-pagehide-persisted', String(event.persisted));
    });
  });
  await page.goto(base + '?id=42', { waitUntil: 'load' });
  await page.waitForFunction(() =>
    document.querySelector('#series-title')?.textContent === '佇列生命週期測試');
  await page.locator('#select-none').click();
  await page.locator('#episodes input[data-vid]').first().check();
  await page.locator('#add-queue').click();
  await page.waitForFunction(() => window.__sourceAbortProbe?.started === 1);
  assert.equal(await page.evaluate(() => window.__sourceAbortProbe.withoutSignal), 0,
    'Source lookup must receive its job AbortSignal');

  // Synthetic pagehide probes the actual controller on the still-running page.
  await page.evaluate(() => window.dispatchEvent(
    new PageTransitionEvent('pagehide', { persisted: true })));
  await page.waitForFunction(() =>
    window.__sourceAbortProbe?.aborted === 1 &&
    JSON.parse(localStorage.getItem('hongguo-dl-queue-v1') || '[]')[0]?.errorCode === 'INTERRUPTED');
  await page.evaluate(() => window.dispatchEvent(
    new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => ({
    started: window.__sourceAbortProbe.started,
    aborted: window.__sourceAbortProbe.aborted,
    status: JSON.parse(localStorage.getItem('hongguo-dl-queue-v1'))[0]?.status
  })), { started: 1, aborted: 1, status: 'failed' },
  'BFCache return must not silently retry a canceled source request');

  // A user action, not pageshow, is required to retry the interrupted job.
  await page.locator('#queue button[data-action="retry"]').first().click();
  await page.waitForFunction(() => window.__sourceAbortProbe.started === 2);
  assert.equal(await page.evaluate(() => window.__sourceAbortProbe.withoutSignal), 0);

  // Now exercise real navigation away and browser history back (may restore
  // BFCache or reload depending on Firefox/Playwright eligibility).
  await page.goto('about:blank', { waitUntil: 'load' });
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() =>
    JSON.parse(localStorage.getItem('hongguo-dl-queue-v1') || '[]')[0]?.errorCode === 'INTERRUPTED' &&
    document.querySelector('#queue button[data-action="retry"]'));
  const navigated = await page.evaluate(() => ({
    persisted: sessionStorage.getItem('queue-test-pageshow-persisted'),
    pagehidePersisted: sessionStorage.getItem('queue-test-pagehide-persisted'),
    started: window.__sourceAbortProbe.started,
    aborted: window.__sourceAbortProbe.aborted
  }));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__sourceAbortProbe.started), navigated.started,
    'Real back navigation must not restart an interrupted download');
  assert.equal(await page.locator('#queue button[data-action="retry"]').count(), 1);
  console.log('PASS Firefox in-flight source AbortSignal, pagehide cleanup, manual retry and real history navigation',
    JSON.stringify(navigated));
} finally {
  await browser.close();
}
