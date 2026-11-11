// Browser integration check: use a tiny local fixture, without contacting Hongguo.
// Run after a Vite production build: node tests/ffmpeg.firefox.mjs /tmp/ffmpeg-fixture.mp4
import { readFileSync, statSync } from 'node:fs';
import assert from 'node:assert/strict';
import { firefox } from 'playwright';

const sample = readFileSync(process.argv[2]);
const browser = await firefox.launch({ headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const diagnostics = [];
const assetStatus = new Map();
page.on('pageerror', e => diagnostics.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') diagnostics.push('console: ' + m.text()); });
page.on('response', r => {
  if (['ffmpeg-core.js', 'ffmpeg-core.wasm.gz'].some(name => new URL(r.url()).pathname.endsWith('/ffmpeg/' + name))) {
    assetStatus.set(new URL(r.url()).pathname, r.status());
  }
});
page.route(url => url.pathname === '/api/series', route => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({
    kind: 'direct', title: 'Firefox FFmpeg test fixture', total: 1,
    episodes: [{ vid: 'direct', index: 1, url: 'https://cdn.fqnovelvod.com/smoke.mp4' }]
  })
}));
page.route(url => url.pathname === '/api/media', route => route.fulfill({
  status: 200,
  contentType: 'video/mp4',
  headers: { 'Content-Length': String(sample.length), 'Access-Control-Allow-Origin': '*' },
  body: sample
}));
try {
  await page.goto('http://127.0.0.1:4173/hongguo-dl/', { waitUntil: 'load', timeout: 30000 });
  await page.locator('#input-url').fill('123');
  await page.locator('#lookup-button').click();
  await page.locator('#series').waitFor({ state: 'visible' });
  await page.locator('#output-mode').selectOption('copy');
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#add-queue').click();
  const download = await downloadPromise;
  const path = await download.path();
  assert(path && statSync(path).size > 100, 'FFmpeg output download must be nonempty');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('完成'), { timeout: 10000 });
  assert([...assetStatus.entries()].some(([url, status]) => url.endsWith('ffmpeg-core.js') && status === 200),
    'ESM core JS must be fetched');
  assert([...assetStatus.entries()].some(([url, status]) => url.endsWith('ffmpeg-core.wasm.gz') && status === 200),
    'Compressed WASM must be fetched');
  console.log('Firefox FFmpeg.wasm end-to-end remux PASSED:', statSync(path).size,
    'bytes; assets:', Object.fromEntries(assetStatus));
} catch (error) {
  console.error('Firefox FFmpeg.wasm smoke test failed:', error.message);
  console.error('Browser diagnostics:', diagnostics);
  console.error('FFmpeg asset statuses:', Object.fromEntries(assetStatus));
  console.error('Displayed job errors:', await page.locator('.job-error').allTextContents().catch(() => []));
  throw error;
} finally {
  await browser.close();
}
