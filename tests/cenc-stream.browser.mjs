// Browser end-to-end for true incremental CENC progressive MP4 -> clear fMP4.
// Network input is synthetic, locally generated, served as bounded Range requests.
// Requires the verified cenc-core assets in public/cenc; no Hongguo API calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';

const input = readFileSync(process.argv[2]);
const browserName = process.env.CENC_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const KID = '11223344556677889900aabbccddeeff';
const KEY = '00112233445566778899aabbccddeeff';
assert(input.byteLength > 600000, 'Fixture must exceed Worker Range prefetch window');
const browser = await (browserName === 'firefox' ? firefox : chromium).launch({
  headless: true, ...(browserName === 'firefox'
    ? { firefoxUserPrefs: { 'media.eme.enabled': true, 'media.autoplay.default': 0 } }
    : {})
});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const mediaRequests = [], errors = [], diagnosticMessages = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  const text = message.text();
  if (/^\[Hongguo (?:CENC|EME|playback|MSE)\]/.test(text))
    diagnosticMessages.push(text.slice(0, 200));
  if (message.type() === 'error' && !text.includes('favicon'))
    errors.push(text.slice(0, 180));
});
await page.exposeFunction('recordCencFirstFrame', () => {
  const lastByte = mediaRequests.reduce((max, item) => Math.max(max, item.last), -1);
  return { requests: mediaRequests.length, lastByte };
});
await context.route(url => url.pathname.startsWith('/api/'), async route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/api/series') return route.fulfill({
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ kind: 'series', seriesId: '123456789', title: 'CENC streaming fixture',
      total: 1, accessible: 1, episodes: [{ index: 1, vid: '111111111', available: true }] })
  });
  if (u.pathname === '/api/source') return route.fulfill({
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ variants: [{
      codec: 'h264', quality: '720p', source: 'app',
      url: 'https://cdn.fqnovelvod.com/cenc-progressive.mp4',
      contentKey: KEY, width: 480, height: 270
    }] })
  });
  if (u.pathname !== '/api/media') throw new Error('Unexpected API endpoint');
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
  if (!range) {
    mediaRequests.push({ unbounded: true, method: route.request().method(),
      first: 0, last: input.length - 1, bytes: input.length });
    return route.fulfill({ status: 416, contentType: 'text/plain',
      body: 'Bounded synthetic fixture requires Range' });
  }
  const first = Number(range[1]);
  const last = range[2] ? Math.min(Number(range[2]), input.length - 1) : input.length - 1;
  assert(first >= 0 && first <= last && last < input.length);
  const bytes = input.subarray(first, last + 1);
  mediaRequests.push({ first, last, bytes: bytes.length });
  // Real streaming acceptance needs network backpressure, not a 1-shot Blob.
  if (last >= 256 * 1024) await new Promise(resolve => setTimeout(resolve, 100));
  return route.fulfill({
    status: 206, contentType: 'video/mp4',
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + first + '-' + last + '/' + input.length,
      'Content-Length': String(bytes.length)
    }, body: bytes
  });
});

try {
  await page.goto('http://127.0.0.1:4173/hongguo-dl/?id=123456789');
  const available = await page.evaluate(() => {
    const mime = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
  });
  assert(available, browserName + ' runner must support H264/AAC MSE for this acceptance test');
  {
    await page.evaluate(() => {
      const video = document.querySelector('#player-video');
      window.__cencFrame = null;
      const record = async () => {
        if (window.__cencFrame) return;
        const network = await window.recordCencFirstFrame();
        window.__cencFrame = {
          currentTime: video.currentTime, videoWidth: video.videoWidth,
          mediaKeys: Boolean(video.mediaKeys), ...network
        };
      };
      if (video.requestVideoFrameCallback)
        video.requestVideoFrameCallback(record);
      else video.addEventListener('timeupdate', record, { once: true });
    });
    await page.waitForFunction(() =>
      document.querySelector('#series-title')?.textContent?.includes('CENC streaming fixture'),
      null, { timeout: 30000 });
    await page.locator('#mode-play').click();
    await page.locator('#episodes button.play-episode').first().click();
    try {
      await page.waitForFunction(() => document.querySelector('#player-source-info')
        ?.textContent.includes('增量解密轉封裝（MSE）'), null, { timeout: 20000 });
    } catch (error) {
      const state = await page.evaluate(async () => {
        const video = document.querySelector('#player-video');
        const mime = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
        const wasm = await fetch('/hongguo-dl/cenc/cenc-core.wasm',
          { method: 'HEAD' }).catch(() => null);
        return {
          status: document.querySelector('#player-status')?.textContent,
          source: document.querySelector('#player-source-info')?.textContent,
          videoReady: video?.readyState, videoError: video?.error?.message,
          videoCanPlay: video?.canPlayType(mime),
          mseSupports: MediaSource.isTypeSupported(mime),
          wasmStatus: wasm?.status, wasmType: wasm?.headers.get('content-type'),
          wasmLength: wasm?.headers.get('content-length')
        };
      });
      console.error('CENC browser diagnostics:', JSON.stringify({
        browserName, ...state, mediaRequests: mediaRequests.slice(0, 8),
        diagnosticMessages: diagnosticMessages.slice(-15), errors: errors.slice(-8)
      }));
      throw error;
    }
    await page.waitForFunction(() => window.__cencFrame?.videoWidth === 480,
      null, { timeout: 90000 });
    const frame = await page.evaluate(() => window.__cencFrame);
    assert(frame.lastByte < input.length - 1,
      'First presented frame occurred after HTTP EOF: ' + JSON.stringify(frame));
    assert(frame.requests >= 2 && !mediaRequests.some(req => req.unbounded),
      'Metadata and fragment HTTP ranges must both be used');
    assert.equal(frame.mediaKeys, false, 'Clear output should not need EME');
    await page.waitForFunction(() =>
      document.querySelector('#player-video')?.currentTime > 1.5,
      null, { timeout: 20000 });
    const playback = await page.evaluate(() => {
      const video = document.querySelector('#player-video');
      return {
        currentTime: video.currentTime,
        bufferedRanges: video.buffered.length,
        videoError: video.error?.code || null
      };
    });
    assert(playback.bufferedRanges > 0 && !playback.videoError,
      'MSE did not sustain playback: ' + JSON.stringify(playback));
    assert(!mediaRequests.some(r => r.unbounded),
      'Incremental playback must never request whole-file download');
    assert(!errors.length, 'Unexpected browser errors: ' + errors.join('; '));
    if (process.env.CENC_TEST_STRESS === '1') {
      await page.evaluate(() => {
        const video = document.querySelector('#player-video');
        video.muted = true;
        video.playbackRate = 8;
        const stats = window.__cencStress = {
          samples: 0, maxBufferedSpan: 0, maxBufferedAhead: 0,
          maxDurationSeconds: 0, lastTime: 0
        };
        const sample = () => {
          let total = 0, ahead = 0;
          for (let i = 0; i < video.buffered.length; i++) {
            const a = video.buffered.start(i), b = video.buffered.end(i);
            total += b - a;
            ahead = Math.max(ahead, b - video.currentTime);
          }
          stats.samples++;
          stats.maxBufferedSpan = Math.max(stats.maxBufferedSpan, total);
          stats.maxBufferedAhead = Math.max(stats.maxBufferedAhead, ahead);
          stats.maxDurationSeconds = Math.max(stats.maxDurationSeconds, video.duration || 0);
          stats.lastTime = video.currentTime;
        };
        video.addEventListener('timeupdate', sample);
        video.addEventListener('progress', sample);
        sample();
      });
      await page.waitForFunction(() => {
        const video = document.querySelector('#player-video');
        return video?.ended && video.currentTime >= 297 && video.duration >= 299;
      }, null, { timeout: 180000 });
      const stats = await page.evaluate(() => ({
        ...window.__cencStress,
        ended: document.querySelector('#player-video')?.ended,
        videoError: document.querySelector('#player-video')?.error?.code || null
      }));
      assert(stats.ended && !stats.videoError && stats.samples > 10,
        '300-second CENC playback must finish cleanly: ' + JSON.stringify(stats));
      assert(stats.maxBufferedSpan < 120 && stats.maxBufferedAhead < 90,
        'MSE window retained too much media during 300-second playback: ' +
        JSON.stringify(stats));
      assert(!mediaRequests.some(r => r.unbounded) && !errors.length,
        '300-second playback unexpectedly used whole-file fetch or emitted browser errors');
      console.log('PASS ' + browserName + ' 300-second CENC playback and bounded MSE window',
        JSON.stringify({ ...stats, rangeRequests: mediaRequests.length }));
    }
    if (process.env.CENC_TEST_SEEK === '1') {
      // 70s fixture; the worker should stop fetching after ~40s ahead.
      // A 55s seek is genuinely outside SourceBuffer, not a local seek.
      const target = 55;
      const before = await page.evaluate(time => {
        const video = document.querySelector('#player-video');
        return { duration: video.duration,
          buffered: Array.from({ length: video.buffered.length }, (_, i) =>
            [video.buffered.start(i), video.buffered.end(i)]),
          remoteTargetBuffered: Array.from({ length: video.buffered.length }, (_, i) =>
            video.buffered.start(i) <= time && video.buffered.end(i) >= time).some(Boolean)
        };
      }, target);
      assert(before.duration > target + 1,
        'MSE must expose source movie duration for unbuffered seeking: ' +
        JSON.stringify(before));
      assert.equal(before.remoteTargetBuffered, false,
        'Fixture target must not already be buffered: ' + JSON.stringify(before));
      const firstSeekRequest = mediaRequests.length;
      await page.evaluate(time => {
        document.querySelector('#player-video').currentTime = time;
      }, target);
      await page.waitForFunction(() =>
        document.querySelector('#player-status')?.textContent.includes('已跳轉到'),
        null, { timeout: 90000 });
      await page.waitForFunction(() => {
        const video = document.querySelector('#player-video');
        return video?.currentTime > 55.75 && video.readyState >= 2 &&
          Array.from({ length: video.buffered.length }, (_, i) =>
            video.buffered.start(i) <= 55.75 && video.buffered.end(i) > 55.75)
            .some(Boolean);
      }, null, { timeout: 90000 });
      const jumped = mediaRequests.slice(firstSeekRequest);
      assert(jumped.some(request => request.first > input.length * 0.5),
        'Remote indexed seek must request new high-offset HTTP byte ranges: ' +
        JSON.stringify(jumped.map(request => [request.first, request.last]).slice(0, 12)));
      assert(!jumped.some(request => request.unbounded),
        'Unbuffered seek cannot download the entire source');
      assert(!errors.length, 'Unexpected browser errors after seek: ' + errors.join('; '));
      console.log('PASS ' + browserName + ' unbuffered CENC RAP seek', JSON.stringify({
        target, duration: before.duration, newRangeCount: jumped.length,
        highestNewOffset: Math.max(...jumped.map(request => request.first))
      }));
      // The player's saved position must re-enter the indexed remux path on
      // reload, not re-download all earlier encrypted samples.
      const persisted = await page.evaluate(() => {
        const entries = Object.values(JSON.parse(
          localStorage.getItem('hongguo-dl-playback-history-v1') || '{}'));
        return entries.map(entry => ({
          seconds: entry.seconds, completed: entry.completed
        }));
      });
      assert(persisted.some(entry => !entry.completed && entry.seconds > 54.5),
        'A successful seek must persist a usable resume position before reload');
      const beforeReload = mediaRequests.length;
      await page.reload();
      await page.waitForFunction(() =>
        document.querySelector('#series-title')?.textContent?.includes('CENC streaming fixture'),
        null, { timeout: 30000 });
      await page.locator('#mode-play').click();
      await page.locator('#episodes button.play-episode').first().click();
      try {
        await page.waitForFunction(() => {
          const video = document.querySelector('#player-video');
          return video?.currentTime > 54.5 && video.videoWidth === 480 &&
            video.readyState >= 2;
        }, null, { timeout: 40000 });
      } catch (error) {
        const state = await page.evaluate(() => {
          const video = document.querySelector('#player-video');
          const records = JSON.parse(localStorage.getItem('hongguo-dl-playback-history-v1') || '{}');
          return {
            status: document.querySelector('#player-status')?.textContent,
            sourceInfo: document.querySelector('#player-source-info')?.textContent,
            currentTime: video?.currentTime, duration: video?.duration,
            readyState: video?.readyState, width: video?.videoWidth,
            errorCode: video?.error?.code || null,
            buffered: Array.from({ length: video?.buffered?.length || 0 }, (_, i) =>
              [video.buffered.start(i), video.buffered.end(i)]),
            savedPositions: Object.values(records).map(r => ({
              seconds: r.seconds, duration: r.duration, completed: r.completed
            }))
          };
        });
        console.error('CENC reload resume diagnostics:', JSON.stringify({
          browserName, ...state, mediaRequests: mediaRequests.slice(-12),
          diagnosticMessages: diagnosticMessages.slice(-8), errors: errors.slice(-6)
        }));
        throw error;
      }
      const resumedRanges = mediaRequests.slice(beforeReload);
      assert(resumedRanges.some(request => request.first > input.length * 0.5),
        'Reload resume must reindex near the saved timestamp instead of restarting at 0');
      assert(!resumedRanges.some(request => request.unbounded));
      assert(!errors.length, 'Unexpected browser errors after reload: ' + errors.join('; '));
      console.log('PASS ' + browserName + ' saved CENC seek reload', JSON.stringify({
        originalTarget: target, resumedRangeCount: resumedRanges.length
      }));
      if (process.env.CENC_TEST_MULTI_SEEK === '1') {
        // 10%, 50%, 90%, intentionally bouncing across noncontiguous ranges.
        // Each previous remote stream is disposed before a new one is opened.
        for (const desired of [7, 35, 63]) {
          const start = mediaRequests.length;
          const beforeSeek = await page.evaluate(() => {
            const video = document.querySelector('#player-video');
            return Array.from({ length: video.buffered.length }, (_, i) =>
              [video.buffered.start(i), video.buffered.end(i)]);
          });
          assert(!beforeSeek.some(([a, b]) => a <= desired && desired <= b),
            'Test requires genuinely unbuffered target ' + desired +
            ': ' + JSON.stringify(beforeSeek));
          await page.evaluate(time => {
            document.querySelector('#player-video').currentTime = time;
          }, desired);
          await page.waitForFunction(time => {
            const video = document.querySelector('#player-video');
            const status = document.querySelector('#player-status')?.textContent || '';
            return status.includes('已跳轉到 ' + time + ' 秒') &&
              video && video.videoWidth === 480 && video.readyState >= 2 &&
              video.currentTime >= time - 0.3 && video.currentTime < time + 5 &&
              Array.from({ length: video.buffered.length }, (_, i) =>
                video.buffered.start(i) <= time + 0.2 &&
                video.buffered.end(i) >= time + 0.2).some(Boolean);
          }, desired, { timeout: 40000 });
          const ranges = mediaRequests.slice(start);
          assert(ranges.some(r => r.first > input.length * Math.max(0.02, desired / 70 - 0.2)),
            'Seek must start new indexed Range near ' + desired + 's: ' +
            JSON.stringify(ranges.map(r => [r.first, r.last])));
          assert(!ranges.some(r => r.unbounded),
            'Rapid seeks may not fall back to full-file downloads');
          console.log('PASS ' + browserName + ' unbuffered indexed RAP seek', JSON.stringify({
            seconds: desired, sourceRanges: ranges.length
          }));
        }
        // Also verify last-watched position survives a second reload.
        const beforeFinalReload = mediaRequests.length;
        await page.reload();
        await page.waitForFunction(() =>
          document.querySelector('#series-title')?.textContent?.includes('CENC streaming fixture'),
          null, { timeout: 30000 });
        await page.locator('#mode-play').click();
        await page.locator('#episodes button.play-episode').first().click();
        await page.waitForFunction(() => {
          const video = document.querySelector('#player-video');
          return video?.videoWidth === 480 && video.readyState >= 2 &&
            video.currentTime >= 62.5 && video.currentTime < 67;
        }, null, { timeout: 40000 });
        const resumed = mediaRequests.slice(beforeFinalReload);
        assert(resumed.some(r => r.first > input.length * 0.65) &&
          !resumed.some(r => r.unbounded),
          '90% reload must resume with high-offset bounded HTTP Range');
        console.log('PASS ' + browserName + ' 90% CENC resume after cross-range seeking');
        // Switching to download mode must dispose the CENC Worker, rather
        // than leaving a hidden 40s remux task running in the background.
        await page.locator('#mode-download').click();
        await page.waitForFunction(() =>
          !document.querySelector('#player-video')?.getAttribute('src'),
          null, { timeout: 10000 });
        await page.waitForTimeout(350);
        const canceledAt = mediaRequests.length;
        await page.waitForTimeout(800);
        assert.equal(mediaRequests.length, canceledAt,
          'Download mode must stop requesting CENC media in the background');
        await page.locator('#mode-play').click();
        await page.waitForFunction(() => {
          const video = document.querySelector('#player-video');
          return video?.videoWidth === 480 && video.readyState >= 2 &&
            video.currentTime >= 62.5 && video.currentTime < 67;
        }, null, { timeout: 40000 });
        assert(!mediaRequests.some(r => r.unbounded),
          'Resuming from download mode must still use bounded Range');
        console.log('PASS ' + browserName + ' playback/download mode releases and resumes CENC');
      }
    }
    console.log('PASS ' + browserName + ' encrypted progressive MP4 remux first frame before HTTP EOF',
      JSON.stringify({ ...frame, playbackSeconds: playback.currentTime, inputBytes: input.length,
        downloadedPercentAtFirstFrame: +((frame.lastByte + 1) / input.length * 100).toFixed(1),
        KID: 'synthetic fixture' }));
  }
} finally {
  await browser.close();
}
