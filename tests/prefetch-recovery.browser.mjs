// Real production Worker/WASM, synthetic encrypted media, and a streaming
// fixture server. Tiny chunks keep the response alive while it is too slow.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const bytes = readFileSync(process.argv[2]);
const app = process.env.TEST_APP_URL || 'http://127.0.0.1:5173/hongguo-dl/';
const browser = await chromium.launch({ headless: true });
const key = '00112233445566778899aabbccddeeff';
const source = (vid, name, quality = '720p') => ({ codec: 'h264', quality, source: 'app', contentKey: key,
  url: `https://cdn.fqnovelvod.com/${vid}-${name}.mp4` });

try {
  for (const mode of ['active-slow', 'preload-slow', 'preload-exhausted']) {
    const mediaRequests = [], sourceCalls = new Map(), timers = new Set();
    const episodes = mode === 'active-slow' ? [{ vid: '16', index: 16, available: true }]
      : [{ vid: '24', index: 24, available: true }, { vid: '25', index: 25, available: true }];
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://fixture.local');
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range, Accept',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length' };
      const json = value => { response.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.method === 'OPTIONS') { response.writeHead(204, cors); return response.end(); }
      if (url.pathname === '/api/health') return json({ ok: true, sourceChannels: false });
      if (url.pathname === '/api/series') return json({ kind: 'series', seriesId: '42', title: 'Slow source fixture',
        total: episodes.length, episodes });
      if (url.pathname === '/api/source') {
        const vid = url.searchParams.get('vid'); sourceCalls.set(vid, (sourceCalls.get(vid) || 0) + 1);
        return json({ variants: vid === '24' ? [source(vid, 'good')]
          : [source(vid, 'a'), source(vid, 'b'), source(vid, 'lower', '360p')] });
      }
      if (url.pathname !== '/api/media') { response.writeHead(404, cors); return response.end(); }
      const path = new URL(url.searchParams.get('url')).pathname;
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      assert(match);
      const first = Number(match[1]), last = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      const openEnded = !match[2];
      mediaRequests.push({ path, first, openEnded });
      const failing = !path.includes('24-good') && path.endsWith('-a.mp4');
      if (openEnded && mode === 'preload-exhausted' && !path.includes('24-good')) {
        response.writeHead(403, cors); return response.end();
      }
      response.writeHead(206, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': String(last - first + 1),
        'Content-Range': `bytes ${first}-${last}/${bytes.length}` });
      if (!openEnded || !failing) return response.end(bytes.subarray(first, last + 1));
      // Enough for a picture in the active case; only init in the preload case.
      let offset = Math.min(last + 1, first + (mode === 'active-slow' ? 262144 : 1024));
      response.write(bytes.subarray(first, offset));
      const timer = setInterval(() => {
        if (offset > last) { clearInterval(timer); timers.delete(timer); response.end(); }
        else response.write(bytes.subarray(offset, ++offset));
      }, 300);
      timers.add(timer);
      response.on('close', () => { clearInterval(timer); timers.delete(timer); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.name));
    try {
      await page.addInitScript(origin => {
        window.__HONGGUO_START_MODE = 'download';
        localStorage.setItem('hongguo-dl-worker-origin-v1', origin);
      }, api);
      await page.goto(app + '?id=42');
      await page.waitForFunction(() => document.querySelector('#series-title')?.textContent.includes('Slow source fixture'));
      await page.locator('#mode-play').click();
      if (mode === 'preload-exhausted') {
        await page.waitForFunction(() => /prefetch.failed episode=25 code=CENC_SOURCE_EXHAUSTED/.test(
          document.querySelector('#playback-log').value), null, { timeout: 15000 });
        await page.locator('[data-play-vid="25"]').click();
        await page.waitForFunction(() => /已停止播放/.test(document.querySelector('#player-status').textContent));
        assert.equal(sourceCalls.get('25'), 2, 'Only one source refresh is allowed');
        assert.equal(mediaRequests.filter(r => r.openEnded && r.path === '/25-a.mp4').length, 1);
        assert.equal(mediaRequests.filter(r => r.openEnded && r.path === '/25-b.mp4').length, 1);
      } else {
        const episode = mode === 'active-slow' ? 16 : 25;
        await page.waitForFunction(episode => {
          const v = document.querySelector('#player-video'), log = document.querySelector('#playback-log').value;
          return document.querySelector('#player-episode').textContent.includes(`第 ${episode} 集`) &&
            log.includes('CENC_SOURCE_SLOW') && v.currentTime > 0.5 &&
            v.getVideoPlaybackQuality().totalVideoFrames > 3 && !v.error &&
            log.includes(`source.selected candidate=2 episode=${episode}`);
        }, episode, { timeout: 35000 });
        const log = await page.locator('#playback-log').inputValue();
        if (mode === 'preload-slow') {
          const ready = log.indexOf('prefetch.ready episode=25');
          assert(ready >= 0 && ready < log.indexOf('playback.open episode=25'),
            'Replace an init-only slow preload before episode handoff');
          assert.match(log, /prefetch.handoff episode=25 media=true ready=true/);
          assert.match(log, /prefetch.stage episode=25 phase=cdn.selected candidate=2.*attempt=2/);
          assert.match(log, /prefetch.stage episode=25 phase=media.request candidate=2.*attempt=2/);
          assert(!/cenc.stage phase=cdn.selected candidate=2.*attempt=1/.test(log), 'Handoff must not reset the prefetch CDN attempt');
        }
        assert.equal(mediaRequests.filter(r => r.openEnded && r.path === `/${episode}-a.mp4`).length, 1,
          'Do not reopen the failed slow URL at handoff');
        assert.equal(mediaRequests.filter(r => r.openEnded && r.path === `/${episode}-b.mp4`).length, 1);
      }
      assert(!mediaRequests.some(r => r.path.includes('lower')), 'Stay at the original quality');
      assert.deepEqual(errors, []);
      console.log('PASS ' + mode + ': bounded same-quality recovery with real WASM and media requests');
    } catch (error) {
      console.error(mode, 'media requests', JSON.stringify(mediaRequests));
      console.error(mode, await page.locator('#playback-log').inputValue().catch(() => 'no diagnostics'));
      throw error;
    } finally {
      await page.close();
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
} finally { await browser.close(); }
