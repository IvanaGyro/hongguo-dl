// Synthetic encrypted MP4: force the supported full-file fallback and observe
// the user-visible active layer through download, decryption and playback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
const input = readFileSync(process.argv[2]);
// CENC_FALLBACK=midstream: streaming starts, then a SourceBuffer failure
// (a processing failure) moves playback to the whole-file fallback, which
// must continue on the same media Worker cache rather than restart at byte 0.
const midstream = process.env.CENC_FALLBACK === 'midstream';
const name = process.env.CENC_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const browser = await (name === 'firefox' ? firefox : chromium).launch({
  headless: true, ...(name === 'firefox'
    ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } }
    : { args: ['--autoplay-policy=no-user-gesture-required'] })
});
const page = await browser.newPage();
// The app opens in watch mode; this suite was written against a download-mode start.
await page.addInitScript(() => {
  window.__HONGGUO_START_MODE = 'download';
  localStorage.setItem('hongguo-dl-worker-origin-v1', location.origin);
});
let mediaRequests = 0;
const ranges = [];
const errors = [];
page.on('pageerror', e => errors.push(e.message));
if (midstream) await page.addInitScript(() => {
  const append = SourceBuffer.prototype.appendBuffer;
  let media = 0;
  SourceBuffer.prototype.appendBuffer = function (bytes) {
    // init + three media fragments, then a synthetic append failure.
    if (++media > 4) throw new Error('synthetic SourceBuffer failure');
    return append.call(this, bytes);
  };
});
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'requestMediaKeySystemAccess', { value: undefined });
  document.addEventListener('DOMContentLoaded', () => {
    const status = document.querySelector('#player-status');
    window.__statusLog = [];
    new MutationObserver(() => window.__statusLog.push(status.textContent))
      .observe(status, {childList:true, subtree:true, characterData:true});
  });
});
if (!midstream) await page.route('**/cenc/cenc-core.wasm', route => route.fulfill({ status:404, body:'not deployed' }));
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
  // One HTTP request probes MP4 metadata. The unavailable incremental path
  // hands its media Worker to the whole-file fallback, which continues on
  // that same response (#23). Count media HTTP requests.
  mediaRequests++;
  const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  const first = midstream && match ? Number(match[1]) : 0;
  const last = midstream && match?.[2] ? Math.min(Number(match[2]), input.length - 1) : input.length - 1;
  ranges.push(first);
  return route.fulfill({
    status: 206, contentType: 'video/mp4',
    headers: {
      'Content-Length': String(last - first + 1),
      'Content-Range': `bytes ${first}-${last}/${input.length}`
    },
    body: input.subarray(first, last + 1)
  });
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
  const log = await page.locator('#playback-log').inputValue();
  if (midstream) {
    assert.match(log, /mse\.failed[^\n]*code=CENC_REMUX_FAILED/);
    assert.match(log, /playback\.fallback\.whole-file[^\n]*reason=processing-failed/);
    assert.match(log, /whole-file\.source reused=true/, 'The fallback must take over the failed stream\'s Worker');
    assert.equal(ranges.filter(offset => offset === 0).length, 1,
      'Only the metadata probe starts at byte 0: ' + JSON.stringify(ranges));
  } else {
    assert.equal(mediaRequests, 1,
      'The whole-file fallback must continue on the metadata probe response');
    assert.match(log, /whole-file\.source reused=true/);
  }
  assert(statuses.some(s => /下載｜(?:正在下載整集影片|下載整集 \d+%)/.test(s)),
    JSON.stringify(statuses));
  assert(!errors.length, errors.join('; '));
  console.log('PASS ' + name + (midstream ? ' mid-stream processing failure' : ' unavailable streaming') +
    ' falls back on the same Worker cache (' + mediaRequests + ' media requests), shows download UI and plays');
} finally { await browser.close(); }
