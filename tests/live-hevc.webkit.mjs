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
  await context.addInitScript(() => {
    localStorage.setItem('hongguo-dl-player-preferences-v1', JSON.stringify({
      quality: '1080p', codec: 'hevc', speed: '1', autoNext: false
    }));
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
      h264Mse: Boolean(MediaSource?.isTypeSupported?.(
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
    // If autoplay was blocked, click the actual app's Play button only while
    // paused. Avoid accidentally pausing a video which has already started.
    await page.waitForTimeout(2500);
    if (await page.locator('#player-video').evaluate(video =>
      video.paused && video.readyState > 0)) {
      await page.locator('#player-play-pause').click();
    }
    await page.waitForFunction(() => {
      const video = document.querySelector('#player-video');
      const failure = document.querySelector('#player-status')?.textContent || '';
      return (video?.currentTime > 0.5 && video?.videoWidth > 0 &&
          (window.__liveHevcFrames > 0 ||
            video.getVideoPlaybackQuality?.().totalVideoFrames > 0)) ||
        /已停止播放|無法播放/.test(failure);
    }, null, { timeout: 90000 }).catch(() => {});
    const state = await page.evaluate(() => {
      const v = document.querySelector('#player-video');
      const status = document.querySelector('#player-status')?.textContent || '';
      return {
        videoWidth: v?.videoWidth || 0,
        videoHeight: v?.videoHeight || 0,
        readyState: v?.readyState || 0,
        currentTime: Number(v?.currentTime || 0),
        presentedFrames: window.__liveHevcFrames || 0,
        totalVideoFrames: v?.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
        mediaError: v?.error?.code ?? null,
        statusCategory: /403/.test(status) ? 'SOURCE_403' :
          /429/.test(status) ? 'SOURCE_429' :
          /已停止播放/.test(status) ? 'STOPPED' :
          /無法播放/.test(status) ? 'UNSUPPORTED' :
          /串流|已續播|準備/.test(status) ? 'STREAMING_OR_READY' : 'OTHER'
      };
    });
    console.log('macOS WebKit real episode 1 result:', JSON.stringify({
      ...state, mediaHttpStatuses: counters()
    }));
    const decodedFrames = state.presentedFrames > 0 || state.totalVideoFrames > 0;
    assert(decodedFrames && state.videoWidth >= 640 &&
      state.currentTime > 0.5 && state.mediaError == null,
    'Real HEVC browser first frame/time proof did not pass (no URL or key logged)');
    console.log('PASS real Hongguo 1080p HEVC first decoded browser frame and advancing clock');
  }
} finally {
  await browser.close();
}
