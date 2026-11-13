// End-to-end acceptance of real HEVC/AAC *browser* decoding on macOS WebKit.
// Runs only after first frame/time has already been verified. No media URLs,
// raw PCM, video data, cookies, content keys or downloaded files are logged.
import assert from 'node:assert/strict';

export async function verifyRealHevcAudioAndSeek(page) {
  // This is Web Audio PCM from the actual decoded MSE media element, NOT
  // ffprobe metadata or FFmpeg-only bitstream acceptance. Use a trusted
  // Playwright click to unlock AudioContext on browsers requiring activation.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'hevc-enable-aac-pcm-test';
    button.type = 'button';
    button.textContent = 'Verify real AAC audio';
    Object.assign(button.style, {
      position: 'fixed', top: '8px', left: '8px', zIndex: '2147483647'
    });
    button.addEventListener('click', event => {
      window.__hevcAudioTrustedClick = event.isTrusted;
      const video = document.querySelector('#player-video');
      video.muted = false;
      video.volume = 1;
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) {
        window.__hevcAudioProbe = { unavailable: true };
        return;
      }
      try {
        const context = new Context();
        const source = context.createMediaElementSource(video);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        analyser.connect(context.destination);
        window.__hevcAudioProbe = { context, analyser };
        void context.resume().catch(() => {
          window.__hevcAudioProbe.resumeFailed = true;
        });
      } catch {
        window.__hevcAudioProbe = { initFailed: true };
      }
    }, { once: true });
    document.body.append(button);
  });
  await page.locator('#hevc-enable-aac-pcm-test').click();
  await page.waitForFunction(() => {
    const probe = window.__hevcAudioProbe;
    return probe?.context?.state === 'running' || probe?.resumeFailed ||
      probe?.unavailable || probe?.initFailed;
  }, null, { timeout: 12000 }).catch(() => {});
  const audio = await page.evaluate(async () => {
    const probe = window.__hevcAudioProbe || {};
    const video = document.querySelector('#player-video');
    const before = video.currentTime;
    if (!probe.analyser || probe.context?.state !== 'running') {
      return { contextState: probe.context?.state || 'unavailable',
        trustedClick: Boolean(window.__hevcAudioTrustedClick),
        playableTimeAdvanced: 0, nonSilentWindows: 0, peakRms: 0,
        initFailed: !!probe.initFailed, resumeFailed: !!probe.resumeFailed };
    }
    const pcm = new Float32Array(probe.analyser.fftSize);
    let peakRms = 0, nonSilentWindows = 0;
    // ~9.6s sampling window tolerates a quiet introduction to a real drama.
    // Only aggregate audio energy, never transfer/record decoded samples.
    for (let i = 0; i < 120; i++) {
      await new Promise(resolve => setTimeout(resolve, 80));
      probe.analyser.getFloatTimeDomainData(pcm);
      let power = 0;
      for (const x of pcm) power += x * x;
      const rms = Math.sqrt(power / pcm.length);
      peakRms = Math.max(peakRms, rms);
      if (rms > 0.002) nonSilentWindows++;
    }
    return {
      contextState: probe.context.state,
      trustedClick: Boolean(window.__hevcAudioTrustedClick),
      peakRms, nonSilentWindows,
      playableTimeAdvanced: Number((video.currentTime - before).toFixed(3)),
      mediaError: video.error?.code ?? null
    };
  });
  console.log('macOS WebKit real HEVC/AAC decoded PCM:', JSON.stringify(audio));
  // Close WebAudio to avoid influencing the later seek video playback.
  await page.evaluate(() => {
    void window.__hevcAudioProbe?.context?.close().catch(() => {});
    document.querySelector('#hevc-enable-aac-pcm-test')?.remove();
  });
  assert.equal(audio.contextState, 'running', 'Real browser AAC AudioContext unavailable');
  assert.equal(audio.trustedClick, true, 'Web Audio was not activated by a trusted gesture');
  assert(audio.peakRms > 0.004 && audio.nonSilentWindows >= 4,
    'Real HEVC MSE AAC audio PCM not proven');
  assert(audio.playableTimeAdvanced > 2, 'Playback clock stalled during real AAC verification');
  assert.equal(audio.mediaError, null);
  console.log('PASS real Hongguo AAC decoded non-silent PCM on macOS WebKit');

  // The player must perform an indexed unbuffered seek, not pretend to seek
  // inside the first 40s of buffered media. This is the real CENC Range path.
  const target = 120;
  const before = await page.evaluate(target => {
    const video = document.querySelector('#player-video');
    return {
      currentTime: video.currentTime,
      frames: window.__liveHevcFrames || 0,
      targetAlreadyBuffered: Array.from({ length: video.buffered.length },
        (_, i) => [video.buffered.start(i), video.buffered.end(i)])
        .some(([start, end]) => target >= start && target <= end)
    };
  }, target);
  assert.equal(before.targetAlreadyBuffered, false,
    '120s seek is already buffered: not a real remote Range regression test');
  await page.locator('#player-video').evaluate((video, seconds) => {
    video.currentTime = seconds;
  }, target);
  await page.waitForFunction(({ target, beforeFrames }) => {
    const video = document.querySelector('#player-video');
    const status = document.querySelector('#player-status')?.textContent || '';
    const advanced = video?.currentTime > target - 1 &&
      video?.currentTime < target + 8 && video.readyState >= 2 &&
      ((window.__liveHevcFrames || 0) > beforeFrames + 1 ||
        video.getVideoPlaybackQuality?.().totalVideoFrames > 0);
    return advanced || /已停止播放|跳轉失敗|無法播放/.test(status);
  }, { target, beforeFrames: before.frames }, { timeout: 90000 }).catch(() => {});
  const seek = await page.evaluate(() => {
    const v = document.querySelector('#player-video');
    const status = document.querySelector('#player-status')?.textContent || '';
    return {
      target: 120,
      currentTime: Number((v?.currentTime || 0).toFixed(3)),
      readyState: v?.readyState || 0,
      paused: v?.paused ?? null,
      seeking: v?.seeking ?? null,
      frames: window.__liveHevcFrames || 0,
      mediaError: v?.error?.code ?? null,
      buffered: v ? Array.from({ length: v.buffered.length }, (_, i) =>
        [Number(v.buffered.start(i).toFixed(3)),
          Number(v.buffered.end(i).toFixed(3))]) : [],
      statusCategory: /403/.test(status) ? 'SOURCE_403' :
        /429/.test(status) ? 'SOURCE_429' :
        /跳轉失敗/.test(status) ? 'SEEK_FAILED' :
        /已停止播放/.test(status) ? 'STOPPED' : 'OTHER'
    };
  });
  console.log('macOS WebKit real HEVC distant seek:', JSON.stringify(seek));
  assert(Math.abs(seek.currentTime - target) < 8 &&
    seek.readyState >= 2 && !seek.seeking && seek.mediaError == null &&
    seek.frames > before.frames + 1,
  'Real HEVC unbuffered CENC seek not verified');
  console.log('PASS real Hongguo HEVC distant unbuffered seek and decoded frames');
}
