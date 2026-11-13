// Synthetic encrypted MP4: force the supported full-file fallback and observe
// the user-visible warnings through download, decryption and playback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
const input = readFileSync(process.argv[2]);
const name = process.env.CENC_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const browser = await (name === 'firefox' ? firefox : chromium).launch({
  headless: true, ...(name === 'firefox'
    ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } }
    : { args: ['--autoplay-policy=no-user-gesture-required'] })
});
const page = await browser.newPage();
let wholeFileRequests = 0;
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'requestMediaKeySystemAccess', { value: undefined });
  document.addEventListener('DOMContentLoaded', () => {
    const status = document.querySelector('#player-status');
    window.__statusLog = [];
    new MutationObserver(() => window.__statusLog.push(status.textContent))
      .observe(status, {childList:true, subtree:true, characterData:true});
  });
});
await page.route('**/cenc/cenc-core.wasm', route => route.fulfill({ status:404, body:'not deployed' }));
await page.route(url => url.pathname.startsWith('/api/'), async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/health') return route.fulfill({
    json: { ok: true, sourceChannels: false }
  });
  if (url.pathname === '/api/series') return route.fulfill({ json: {
    kind:'series', seriesId:'123456789', title:'Fallback fixture', total:1, accessible:1,
    episodes:[{index:1, vid:'111111111', available:true}]
  }});
  if (url.pathname === '/api/source') return route.fulfill({ json: { variants:[{
    codec:'h264', quality:'720p', source:'app', url:'https://cdn.fqnovelvod.com/synthetic.mp4',
    contentKey:'00112233445566778899aabbccddeeff', width:480, height:270
  }] }});
  assert.equal(url.pathname, '/api/media');
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  if (!range) {
    wholeFileRequests++;
    const status = await page.locator('#player-status').textContent();
    assert.match(status, /⚠.*整集下載備援.*完成後才能播放/,
      'Warn before starting the full-file request');
    await new Promise(resolve => setTimeout(resolve,100));
    return route.fulfill({ status:200, contentType:'video/mp4',
      headers:{'Content-Length':String(input.length)}, body:input });
  }
  const start = Number(range[1]), end = Math.min(Number(range[2]) || input.length-1,input.length-1);
  return route.fulfill({ status:206, contentType:'video/mp4', headers:{
    'Content-Range':`bytes ${start}-${end}/${input.length}`,
    'Content-Length':String(end-start+1)
  }, body:input.subarray(start,end+1) });
});
try {
  await page.goto('http://127.0.0.1:4173/hongguo-dl/?id=123456789');
  await page.waitForFunction(() => document.querySelector('#series-title')?.textContent.includes('Fallback fixture'));
  await page.locator('#mode-play').click(); // activation already starts this episode
  await page.waitForFunction(() => {
    const v=document.querySelector('#player-video');
    return v?.videoWidth===480 && v.currentTime>0.5 && !v.error;
  }, null, {timeout:90000});
  const statuses = await page.evaluate(() => window.__statusLog);
  assert.equal(wholeFileRequests,1);
  assert(statuses.some(s=>/整集下載備援.*下載整集 \d+%/.test(s)),JSON.stringify(statuses));
  assert(statuses.some(s=>/整集下載備援.*解密並重新封裝/.test(s)),JSON.stringify(statuses));
  assert(!errors.length, errors.join('; '));
  console.log('PASS '+name+' full-file fallback warns before download and through decrypt/remux');
} finally { await browser.close(); }
