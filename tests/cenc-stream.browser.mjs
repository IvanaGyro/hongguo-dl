// Browser end-to-end for true incremental CENC progressive MP4 -> clear fMP4.
// Network input is synthetic, locally generated, served as bounded Range requests.
// Requires the verified cenc-core assets in public/cenc; no Hongguo API calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';

const input = readFileSync(process.argv[2]);
const browserName = process.env.CENC_BROWSER === 'firefox' ? 'firefox' : 'chromium';
// Verify actual browser-decoded 440 Hz AAC PCM. A trusted Playwright click
// unlocks Firefox Web Audio, without weakening the amplitude requirement.
async function assertCencAacPcm(page, phase) {
    // A decoded video frame does not prove an AAC track is audible.
    // The synthetic fixture includes an original 440 Hz sine track.
    // Capture real browser PCM via Web Audio (never a file, URL or key).
    // Firefox blocks Web Audio until a real user activation even when the
    // media element itself is allowed to autoplay. Playwright's .click()
    // supplies a trusted browser input; element.click() / page.evaluate()
    // do not. Create and resume AudioContext synchronously in that handler.
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'cenc-activate-audio-test';
      button.type = 'button';
      button.textContent = 'Enable AAC PCM test';
      Object.assign(button.style, {
        position: 'fixed', top: '8px', left: '8px', zIndex: '2147483647'
      });
      button.addEventListener('click', event => {
        window.__cencAudioClickTrusted = event.isTrusted;
        const video = document.querySelector('#player-video');
        const context = new AudioContext();
        const source = context.createMediaElementSource(video);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        analyser.connect(context.destination);
        window.__cencAudioProbe = { context, analyser };
        void context.resume().catch(() => {
          window.__cencAudioProbe.resumeFailed = true;
        });
      }, { once: true });
      document.body.appendChild(button);
    });
    await page.locator('#cenc-activate-audio-test').click();
    try {
      await page.waitForFunction(() =>
        window.__cencAudioProbe?.context?.state === 'running' ||
        window.__cencAudioProbe?.resumeFailed, null, { timeout: 6000 });
    } catch (error) {
      // A Web Audio policy/backend issue is not an AAC decoding error.
      const state = await page.evaluate(() => {
        const video = document.querySelector('#player-video');
        const ctx = window.__cencAudioProbe?.context;
        return {
          trustedClick: window.__cencAudioClickTrusted || false,
          contextState: ctx?.state || 'missing',
          resumeFailed: Boolean(window.__cencAudioProbe?.resumeFailed),
          userActivated: navigator.userActivation?.hasBeenActive ?? null,
          videoPaused: video?.paused ?? null,
          videoMuted: video?.muted ?? null,
          videoReadyState: video?.readyState ?? null,
          videoError: video?.error?.code ?? null
        };
      });
      console.error('CENC AAC Web Audio activation diagnostics:',
        JSON.stringify({ browserName, phase, ...state }));
      throw error;
    }
    const audio = await page.evaluate(async () => {
      const video = document.querySelector('#player-video');
      const { context, analyser, resumeFailed } = window.__cencAudioProbe;
      if (resumeFailed || context.state !== 'running')
        throw new Error('AudioContext did not resume after trusted user activation');
      try {
        const pcm = new Float32Array(analyser.fftSize);
        let peakRms = 0, nonSilentWindows = 0;
        for (let i = 0; i < 25; i++) {
          await new Promise(resolve => setTimeout(resolve, 80));
          analyser.getFloatTimeDomainData(pcm);
          let power = 0;
          for (const sample of pcm) power += sample * sample;
          const rms = Math.sqrt(power / pcm.length);
          peakRms = Math.max(peakRms, rms);
          if (rms > 0.005) nonSilentWindows++;
        }
        return {
          contextState: context.state, peakRms,
          nonSilentWindows, playbackSeconds: video.currentTime,
          mediaError: video.error?.code || null
        };
      } finally {
        await context.close();
        document.querySelector('#cenc-activate-audio-test')?.remove();
        delete window.__cencAudioProbe;
      }
    });
    assert.equal(audio.contextState, 'running',
      'Browser AAC decode probe must use a running AudioContext');
    assert.equal(audio.mediaError, null, 'Audio probe encountered a media decoder error');
    assert(audio.peakRms > 0.01 && audio.nonSilentWindows >= 4,
      'Browser MSE AAC yielded no decoded PCM: ' + JSON.stringify(audio));
    console.log('PASS ' + browserName + ' CENC MSE AAC audible PCM proof (' + phase + ')',
      JSON.stringify(audio));

}

function browserProcessTreeRssBytes(rootPid) {
  if (!Number.isInteger(rootPid)) return null;
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], {
      encoding: 'utf8', timeout: 2000
    }).trim().split(/\n/).map(line => line.trim().split(/\s+/).map(Number))
      .filter(row => row.length === 3 && row.every(Number.isFinite));
    const descendants = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of rows) {
        if (descendants.has(ppid) && !descendants.has(pid)) {
          descendants.add(pid);
          changed = true;
        }
      }
    }
    return rows.filter(([pid]) => descendants.has(pid))
      .reduce((sum, [, , rssKiB]) => sum + rssKiB * 1024, 0);
  } catch { return null; }
}

const KID = '11223344556677889900aabbccddeeff';
const KEY = '00112233445566778899aabbccddeeff';
assert(input.byteLength > 600000, 'Fixture must exceed Worker Range prefetch window');
const browser = await (browserName === 'firefox' ? firefox : chromium).launch({
  headless: true, ...(browserName === 'firefox'
    ? { firefoxUserPrefs: {
      'media.eme.enabled': true,
      'media.autoplay.default': 0,
      // Headless Firefox separately blocks Web Audio even when video autoplay
      // is allowed. Explicitly allow the synthetic audio *test* while still
      // requiring a real trusted click and actual decoded non-silent PCM.
      'media.autoplay.block-webaudio': false
    } }
    : {})
});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
// Only the multi-seek/mode-switch acceptance needs lifetime instrumentation.
// Track MSE object URLs without exposing media URLs or CENC keys.
if (process.env.CENC_TEST_MULTI_SEEK === '1') {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const live = new Set();
    const stats = window.__cencMseUrlState = {
      active: 0, created: 0, revoked: 0
    };
    URL.createObjectURL = object => {
      const url = create(object);
      if (typeof MediaSource === 'function' && object instanceof MediaSource) {
        live.add(url);
        stats.created++;
        stats.active = live.size;
      }
      return url;
    };
    URL.revokeObjectURL = url => {
      if (live.delete(url)) {
        stats.revoked++;
        stats.active = live.size;
      }
      return revoke(url);
    };
  });
}
const mediaRequests = [], errors = [], diagnosticMessages = [], canceledSeekDemuxDiagnostics = [];
const rapidDiagnosticPhases = [];
let exercisingRepeatedSeeks = false, rapidPhase = 'not-started';
// A canceled Librempeg AVIO demux can report a partial audio packet on its
// stderr while the old Worker is being torn down. Track only these *specific*
// MOV diagnostics separately from JS page exceptions and MSE/video errors.
const canceledSeekMovError = /^\[mov,mp4,m4a,3gp,3g2,mj2 @ 0x[0-9a-f]+\] (?:subsample size exceeds the packet size left|Packet corrupt \(stream = \d+, dts = -?\d+\)\.|stream \d+, offset 0x[0-9a-f]+: partial file)$/i;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  const text = message.text();
  if (/^\[Hongguo (?:CENC|EME|playback|MSE)\]/.test(text))
    diagnosticMessages.push(text.slice(0, 200));
  if (message.type() === 'error' && !text.includes('favicon')) {
    if (exercisingRepeatedSeeks && canceledSeekMovError.test(text)) {
      canceledSeekDemuxDiagnostics.push(text.slice(0, 180));
      rapidDiagnosticPhases.push(rapidPhase);
      // A damaged sample in a fully re-established active stream is not a
      // canceled Worker. Keep it fatal even if video.currentTime advances.
      if (rapidPhase.startsWith('steady') || rapidPhase === 'pcm-proof')
        errors.push('Active CENC MOV demux error: ' + text.slice(0, 180));
    } else errors.push(text.slice(0, 180));
  }
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
    if (!process.env.CENC_TEST_STRESS && !process.env.CENC_TEST_SEEK) {
      // A Windows/Android user can copy this local report without providing
      // media URLs, CENC keys or any personally identifying device ID.
      await page.locator('#codec-diagnostics summary').click();
      await page.locator('#codec-diag-run').click();
      await page.waitForFunction(() => {
        const text = document.querySelector('#codec-diag-results')?.textContent || '';
        return text.includes('"HEVC + AAC"') && text.includes('"mseSupported"');
      }, null, { timeout: 15000 });
      const report = JSON.parse(await page.locator('#codec-diag-results').textContent());
      assert.equal(report.schema, 1);
      assert(report.formats.some(format => format.codec === 'HEVC + AAC'));
      assert(!JSON.stringify(report).includes('00112233445566778899aabbccddeeff'),
        'Local codec report must never disclose media decryption keys');
      await page.locator('#codec-diagnostics summary').click();
    }
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
    if (process.env.CENC_TEST_AUDIO === '1')
      await assertCencAacPcm(page, 'startup');
    if (process.env.CENC_TEST_STRESS === '1') {
      const expectedSeconds = Number(process.env.CENC_STRESS_SECONDS || 300);
      assert([300, 1800].includes(expectedSeconds), 'Unexpected bounded stress duration');
      await page.evaluate(duration => {
        const video = document.querySelector('#player-video');
        video.muted = true;
        video.playbackRate = duration >= 1800 ? 16 : 8;
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
        window.__cencStressExpected = duration;
      }, expectedSeconds);
      if (process.env.CENC_TEST_PAUSE === '1') {
        const pauseWindowMs = Number(process.env.CENC_TEST_PAUSE_MS || 3000);
        assert(Number.isSafeInteger(pauseWindowMs) &&
          pauseWindowMs >= 3000 && pauseWindowMs <= 180000,
          'Pause observation window must remain bounded (3-180s)');
        // Regression: a paused viewer must not cause an entire encrypted movie
        // to be fetched. Let the existing ~40s-ahead backpressure settle,
        // observe HTTP Range traffic, then resume and complete playback.
        const pausedAt = await page.evaluate(() => {
          const video = document.querySelector('#player-video');
          video.pause();
          return video.currentTime;
        });
        await page.waitForFunction(() => {
          const video = document.querySelector('#player-video');
          if (!video?.paused) return false;
          try {
            for (let i = 0; i < video.buffered.length; i++)
              if (video.buffered.end(i) - video.currentTime >= 40) return true;
          } catch { /* SourceBuffer range may be updating. */ }
          return false;
        }, null, { timeout: 45000 });
        // Account for the already in-flight AVIO Range read before comparing
        // request counts. There should be no new stream-wide media fetches.
        await page.waitForTimeout(1500);
        const rangesAtPause = mediaRequests.length;
        await page.waitForTimeout(pauseWindowMs);
        const rangesAfterPause = mediaRequests.length;
        const timeAfterPause = await page.evaluate(() =>
          document.querySelector('#player-video').currentTime);
        assert(rangesAfterPause - rangesAtPause <= 2,
          'Paused CENC continued issuing unbounded HTTP Range requests: ' +
          JSON.stringify({ rangesAtPause, rangesAfterPause }));
        assert(Math.abs(timeAfterPause - pausedAt) < 0.5,
          'Paused CENC video unexpectedly advanced its timeline');
        await page.evaluate(async () => {
          await document.querySelector('#player-video').play();
        });
        await page.waitForFunction(t => {
          const video = document.querySelector('#player-video');
          return video && !video.paused && video.currentTime > t + 2;
        }, pausedAt, { timeout: 30000 });
        console.log('PASS ' + browserName +
          ' paused CENC HTTP Range backpressure and playback resume',
          JSON.stringify({ pausedAt, pauseWindowMs,
            rangesAtPause, rangesAfterPause }));
      }
      // Linux ps RSS is observational only: includes the Node test harness,
      // child browser processes and shared pages, but not GPU allocations.
      // Use relative trend, never report this as exact browser-only RSS.
      const rssSamples = [];
      // Playwright's Browser (unlike Puppeteer) does not expose process().
      // The Node test runner is the parent of the browser subprocess tree.
      const pid = process.pid;
      const measure = () => {
        const rss = browserProcessTreeRssBytes(pid);
        if (rss !== null) rssSamples.push(rss);
      };
      measure();
      const rssTimer = setInterval(measure, 2000);
      try {
        await page.waitForFunction(() => {
          const video = document.querySelector('#player-video');
          const expected = window.__cencStressExpected || 300;
          return video?.ended && video.currentTime >= expected - 3 &&
            video.duration >= expected - 1;
        }, null, { timeout: expectedSeconds >= 1800 ? 240000 : 180000 });
      } finally {
        clearInterval(rssTimer);
        measure();
      }
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
      console.log('PASS ' + browserName + ' ' + expectedSeconds +
        '-second CENC playback and bounded MSE window',
        JSON.stringify({
          ...stats, rangeRequests: mediaRequests.length,
          processTreeRssMiB: rssSamples.length ? {
            first: +(rssSamples[0] / 1048576).toFixed(1),
            peak: +(Math.max(...rssSamples) / 1048576).toFixed(1),
            last: +(rssSamples.at(-1) / 1048576).toFixed(1),
            samples: rssSamples.length
          } : null
        }));
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
      // A new MediaSource must not reset the UI's selected speed.
      await page.locator('#player-settings-toggle').click();
      await page.locator('#player-speed').selectOption('1.25');
      await page.locator('#player-settings-close').click();
      assert.equal(await page.locator('#player-video').evaluate(v => v.playbackRate), 1.25);
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
      const seekRates = await page.locator('#player-video').evaluate(v => ({
        playbackRate: v.playbackRate, defaultPlaybackRate: v.defaultPlaybackRate
      }));
      assert.deepEqual(seekRates, { playbackRate: 1.25, defaultPlaybackRate: 1.25 },
        'Unbuffered CENC MSE seek must preserve 1.25x rate after video.load()');
      await page.locator('#player-settings-toggle').click();
      await page.locator('#player-speed').selectOption('1');
      await page.locator('#player-settings-close').click();
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
        // Each step is outside the previous stream's <=40s ahead window.
        // The 5s return is deliberate: a direct 35s->63s jump can be
        // already buffered and would not exercise remote RAP seeking.
        exercisingRepeatedSeeks = true;
        for (const desired of [7, 63, 35, 5, 63]) {
          rapidPhase = 'transition-seek-' + desired;
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
          rapidPhase = 'steady-after-seek-' + desired;
          await page.waitForTimeout(250);
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
        rapidPhase = 'transition-reload';
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
        rapidPhase = 'steady-after-reload';
        const resumed = mediaRequests.slice(beforeFinalReload);
        assert(resumed.some(r => r.first > input.length * 0.65) &&
          !resumed.some(r => r.unbounded),
          '90% reload must resume with high-offset bounded HTTP Range');
        console.log('PASS ' + browserName + ' 90% CENC resume after cross-range seeking');
        // Repeatedly switching modes must revoke each prior CENC MediaSource
        // object URL and stop its Range/Worker rather than leaking an old job.
        for (let cycle = 1; cycle <= 3; cycle++) {
          rapidPhase = 'transition-dispose-' + cycle;
          await page.locator('#mode-download').click();
          await page.waitForFunction(() =>
            !document.querySelector('#player-video')?.getAttribute('src'),
            null, { timeout: 10000 });
          await page.waitForFunction(() =>
            window.__cencMseUrlState?.active === 0,
            null, { timeout: 10000 });
          await page.waitForTimeout(350);
          const canceledAt = mediaRequests.length;
          await page.waitForTimeout(800);
          assert.equal(mediaRequests.length, canceledAt,
            'Download mode left a CENC Range request running in cycle ' + cycle);
          rapidPhase = 'transition-reopen-' + cycle;
          await page.locator('#mode-play').click();
          await page.waitForFunction(() => {
            const video = document.querySelector('#player-video');
            return video?.videoWidth === 480 && video.readyState >= 2 &&
              video.currentTime >= 62.5 && video.currentTime < 69.5 &&
              window.__cencMseUrlState?.active === 1;
          }, null, { timeout: 40000 });
          rapidPhase = 'steady-after-cycle-' + cycle;
          assert(!mediaRequests.some(r => r.unbounded),
            'Resuming from download mode must still use bounded Range');
        }
        const urlState = await page.evaluate(() => window.__cencMseUrlState);
        assert.equal(urlState.created - urlState.revoked, 1,
          'Only the currently playing CENC MediaSource URL may remain active');
        // MSE loadedmetadata alone is not a successful recovery: require an
        // actual forward clock and no HTMLMediaElement decoder error after
        // the final three tear-down/reopen cycles.
        const resumeAt = await page.locator('#player-video').evaluate(async video => {
          if (video.error) throw new Error('MSE playback has a media decoder error');
          video.muted = true;
          const t = video.currentTime;
          await video.play();
          return t;
        });
        await page.waitForFunction(start => {
          const video = document.querySelector('#player-video');
          return video && !video.error && video.videoWidth === 480 &&
            video.readyState >= 2 && video.currentTime > start + 0.35;
        }, resumeAt, { timeout: 12000 });
        if (process.env.CENC_TEST_AUDIO === '1') {
          rapidPhase = 'pcm-proof';
          // The post-seek recovery must produce decoded AAC PCM, not merely a
          // moving video clock. Restore audible routing after the video-only
          // no-decoder-error check above.
          await page.locator('#player-video').evaluate(video => { video.muted = false; });
          await assertCencAacPcm(page, 'after-five-seeks-and-three-mode-cycles');
        }
        assert(!errors.length, 'Browser errors after mode cycling: ' + errors.join('; '));
        // Do not silently erase Librempeg diagnostics. The synthetic sample
        // still needs an independent AAC quality test on a real device.
        if (canceledSeekDemuxDiagnostics.length)
          console.warn('CENC rapid seek/cancel MOV demux diagnostics:',
            JSON.stringify({ count: canceledSeekDemuxDiagnostics.length,
              kinds: [...new Set(canceledSeekDemuxDiagnostics.map(line =>
                line.includes('subsample size') ? 'subsample' :
                  line.includes('partial file') ? 'partial-file' : 'corrupt-packet'))],
              phases: Object.fromEntries([...new Set(rapidDiagnosticPhases)].map(phase =>
                [phase, rapidDiagnosticPhases.filter(name => name === phase).length])) }));
        console.log('PASS ' + browserName +
          ' 3 playback/download cycles release MSE URLs and stop CENC Range',
          JSON.stringify({ ...urlState, playbackAdvanced: true,
            demuxWarningsAfterRapidSeeks: canceledSeekDemuxDiagnostics.length }));
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
