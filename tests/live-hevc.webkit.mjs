// Platform-specific real-episode browser acceptance. This runs only on macOS
// WebKit after checking its HEVC MSE declaration; Linux synthetic H264 CI is
// NOT a substitute. No media URLs, keys, cookies, frames or video artifacts
// are logged, copied or uploaded.
import assert from 'node:assert/strict';
import { webkit } from 'playwright';

const APP = 'https://ivanagyro.github.io/hongguo-dl/?id=7699513062054710296';
const MIME_PROBES = [
  'video/mp4; codecs="hvc1.1.6.L93, mp4a.40.2"',
  'video/mp4; codecs="hev1.1.6.L93, mp4a.40.2"',
  'video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"',
  'video/mp4; codecs="hev1.2.4.L120.90, mp4a.40.2"'
];
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: false });
const page = await context.newPage();
const statuses = new Map();
page.on('response', response => {
  try {
    // Never report URL: /api/media contains a signed upstream URL in its
    // query string, which must not enter CI logs or uploaded artifacts.
    if (new URL(response.url()).pathname === '/api/media') {
      const key = String(response.status());
      statuses.set(key, (statuses.get(key) || 0) + 1);
    }
  } catch { /* no URL-bearing diagnostics */ }
});
const counters = () => Object.fromEntries(statuses);
try {
  // Calibrate WebKit's MediaElementAudioSourceNode with independent,
  // known-audible synthetic H.264/AAC first. A sine oscillator alone cannot
  // establish whether media-element audio is observable in headless WebKit.
  let mediaControl = null;
  if (process.env.CENC_WEBKIT_EXTENDED === '1') {
    const { verifyWebKitMediaAudioControl } =
      await import('./webkit-media-audio-control.mjs');
    mediaControl = await verifyWebKitMediaAudioControl(browser);
  }
  await context.addInitScript(() => {
    localStorage.setItem('hongguo-dl-player-preferences-v1', JSON.stringify({
      quality: '1080p', codec: 'hevc', speed: '1', autoNext: false
    }));
    // Instrument only aggregate SourceBuffer activity. Never inspect or
    // serialize the copyrighted media bytes, signed URL or CENC key.
    const stats = { appendCalls: 0, appendedBytes: 0, updateEnds: 0,
      appendErrors: 0, bufferErrors: 0, buffered: [] };
    globalThis.__liveHevcMseStats = stats;
    const proto = globalThis.SourceBuffer?.prototype;
    if (proto?.appendBuffer) {
      const original = proto.appendBuffer;
      const seen = new WeakSet();
      proto.appendBuffer = function (data) {
        if (!seen.has(this)) {
          seen.add(this);
          this.addEventListener('updateend', () => {
            stats.updateEnds++;
            try {
              stats.buffered = Array.from({ length: this.buffered.length },
                (_, i) => [Number(this.buffered.start(i).toFixed(3)),
                  Number(this.buffered.end(i).toFixed(3))]);
            } catch { /* SourceBuffer may be detached */ }
          });
          this.addEventListener('error', () => { stats.bufferErrors++; });
        }
        stats.appendCalls++;
        stats.appendedBytes += data?.byteLength || 0;
        try { return original.call(this, data); }
        catch (error) { stats.appendErrors++; throw error; }
      };
    }
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const capabilities = await page.evaluate(probes => {
    const video = document.createElement('video');
    const supported = probes.map(mime => Boolean(
      globalThis.MediaSource?.isTypeSupported?.(mime)));
    return {
      mseAvailable: typeof MediaSource !== 'undefined',
      hevcMseProbesSupported: supported,
      hevcVideo: video.canPlayType('video/mp4; codecs="hvc1"') || '',
      h264Mse: Boolean(globalThis.MediaSource?.isTypeSupported?.(
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'))
    };
  }, MIME_PROBES);
  console.log('macOS WebKit HEVC capability:', JSON.stringify(capabilities));
  if (!capabilities.hevcMseProbesSupported.some(Boolean)) {
    console.log('NOT TESTED real HEVC playback: WebKit platform reports no HEVC MSE support');
    process.exitCode = 0;
  } else {
    await page.waitForFunction(() =>
      document.querySelector('#series-title')?.textContent?.includes('nova'),
      null, { timeout: 30000 });
    await page.locator('#mode-play').click();
    await page.locator('#player-panel').waitFor({ state: 'visible', timeout: 30000 });
    // Pre-selected 1080p/HEVC deliberately avoids the separate BVC2
    // downloader/transcoder being implemented by another agent.
    assert.equal(await page.locator('#player-quality').inputValue(), '1080p');
    assert.equal(await page.locator('#player-codec').inputValue(), 'hevc');
    // The same video element receives successive MediaSource objects. Count
    // presented frames without copying the copyrighted video image.
    await page.evaluate(() => {
      const video = document.querySelector('#player-video');
      window.__liveHevcFrames = 0;
      if (typeof video?.requestVideoFrameCallback === 'function') {
        const count = () => {
          window.__liveHevcFrames++;
          video.requestVideoFrameCallback(count);
        };
        video.requestVideoFrameCallback(count);
      }
    });
    // Official /api/source can offer two 1080p HEVC CDN candidates whose
    // signed access differs: a 403 from one candidate is not a codec failure.
    // In addition to the player's in-episode HEVC rotation, test a *bounded*
    // selection of separately marked accessible episodes. Never bypass a 429
    // or the per-episode access flags, and never log a source URL/content key.
    const episodePositions = [0, 2, 1, 3];
    let verified = false, verifiedEpisode = null;
    for (const [attemptIndex, episodePosition] of episodePositions.entries()) {
      if (attemptIndex > 0) {
        const episodeButton = page.locator('#episodes button[data-play-vid]')
          .nth(episodePosition);
        if (!await episodeButton.count() || !await episodeButton.isEnabled()) continue;
        await episodeButton.click();
        await page.waitForTimeout(150);
      }
      await page.evaluate(() => { window.__liveHevcFrames = 0; });
      // Wait until metadata actually arrives before making a trusted gesture.
      // A denied candidate may stop first; don't wait 60s to observe a 403.
      await page.waitForFunction(() => {
        const video = document.querySelector('#player-video');
        const status = document.querySelector('#player-status')?.textContent || '';
        return video?.readyState >= 1 || /已停止播放|無法播放/.test(status);
      }, null, { timeout: 45000 }).catch(() => {});
      if (await page.locator('#player-video').evaluate(video =>
        video.paused && video.readyState >= 1)) {
        await page.locator('#player-play-pause').click();
      }
      // For root-cause investigation only: a test-side seek can be enabled
      // explicitly; regular CI must prove the production zero-start fix.
      if (process.env.CENC_WEBKIT_DIAG_SEEK === '1') {
        await page.waitForFunction(() => {
          const v = document.querySelector('#player-video');
          return v?.readyState >= 1 && v.buffered.length > 0 &&
            v.buffered.end(0) - v.buffered.start(0) > 1;
        }, null, { timeout: 30000 }).catch(() => {});
        const diagnostic = await page.evaluate(() => {
          const v = document.querySelector('#player-video');
          if (!v?.buffered.length) return 'NO_BUFFER';
          const start = v.buffered.start(0);
          if (!(start > 0.01 && start < 0.5 && v.currentTime < start))
            return 'NO_GAP';
          v.currentTime = start + 0.04;
          return 'MANUAL_FIRST_RANGE_SEEK';
        });
        console.log('macOS WebKit test-only diagnostic:', diagnostic);
      }
      await page.waitForFunction(() => {
        const video = document.querySelector('#player-video');
        const failure = document.querySelector('#player-status')?.textContent || '';
        return (video?.currentTime > 0.5 && video?.videoWidth > 0 &&
            (window.__liveHevcFrames > 0 ||
              video.getVideoPlaybackQuality?.().totalVideoFrames > 0)) ||
          /已停止播放|無法播放/.test(failure);
      }, null, { timeout: 70000 }).catch(() => {});
      const state = await page.evaluate(() => {
        const v = document.querySelector('#player-video');
        const status = document.querySelector('#player-status')?.textContent || '';
        return {
          videoWidth: v?.videoWidth || 0,
          videoHeight: v?.videoHeight || 0,
          readyState: v?.readyState || 0,
          networkState: v?.networkState ?? null,
          paused: v?.paused ?? null,
          seeking: v?.seeking ?? null,
          duration: Number.isFinite(v?.duration) ? Number(v.duration.toFixed(3)) : null,
          buffered: v ? Array.from({ length: v.buffered.length }, (_, i) =>
            [Number(v.buffered.start(i).toFixed(3)),
              Number(v.buffered.end(i).toFixed(3))]) : [],
          currentTime: Number(v?.currentTime || 0),
          mse: window.__liveHevcMseStats || null,
          presentedFrames: window.__liveHevcFrames || 0,
          totalVideoFrames: v?.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
          mediaError: v?.error?.code ?? null,
          statusCategory: /點選影片/.test(status) ? 'NEEDS_PLAY_GESTURE' :
            /429/.test(status) ? 'SOURCE_429' :
            /403/.test(status) ? 'SOURCE_403' :
            /已停止播放/.test(status) ? 'STOPPED' :
            /無法播放/.test(status) ? 'UNSUPPORTED' :
            /串流|已續播|準備/.test(status) ? 'STREAMING_OR_READY' : 'OTHER'
        };
      });
      console.log('macOS WebKit real HEVC episode attempt:', JSON.stringify({
        episode: episodePosition + 1, ...state, mediaHttpStatuses: counters()
      }));
      const decodedFrames = state.presentedFrames > 0 || state.totalVideoFrames > 0;
      if (decodedFrames && state.videoWidth >= 640 &&
          state.currentTime > 0.5 && state.mediaError == null) {
        verified = true;
        verifiedEpisode = episodePosition + 1;
        break;
      }
      if (state.statusCategory === 'SOURCE_429') break;
      // Otherwise continue to another already-accessible episode. This is
      // finite and does not try to defeat protected/missing episodes.
    }
    assert(verified,
      'Real HEVC browser first frame/time not verified across four accessible episodes');
    console.log('PASS real Hongguo 1080p HEVC first decoded browser frame and advancing clock',
      JSON.stringify({ episode: verifiedEpisode, mediaHttpStatuses: counters() }));
    if (process.env.CENC_WEBKIT_EXTENDED === '1') {
      const { verifyRealHevcAudioAndSeek } = await import('./live-hevc-extended.mjs');
      await verifyRealHevcAudioAndSeek(page, mediaControl);
      if (process.env.CENC_WEBKIT_JOURNEY === '1') {
        const { verifyRealHevcReloadAndEof } =
          await import('./live-hevc-journey.mjs');
        await verifyRealHevcReloadAndEof(page);
      }
    }
  }
} finally {
  await browser.close();
}
