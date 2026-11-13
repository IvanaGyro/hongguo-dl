// End-to-end acceptance of real HEVC/AAC *browser* decoding on macOS WebKit.
// Runs only after first frame/time has already been verified. No media URLs,
// raw PCM, video data, cookies, content keys or downloaded files are logged.
import assert from 'node:assert/strict';

export async function verifyRealHevcAudioAndSeek(page, mediaControl = null) {
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
    // Capture only media-element state and audio-track presence, never samples.
    const mediaState = {
      muted: video.muted, volume: video.volume,
      audioTracks: video.audioTracks?.length ?? null,
      hasAudio: typeof video.webkitAudioDecodedByteCount === 'number'
        ? video.webkitAudioDecodedByteCount > 0 : null,
      audioDecodedBytes: typeof video.webkitAudioDecodedByteCount === 'number'
        ? video.webkitAudioDecodedByteCount : null,
      readyState: video.readyState, paused: video.paused,
      bufferedSeconds: video.buffered.length
        ? Number((video.buffered.end(video.buffered.length - 1) -
          video.buffered.start(0)).toFixed(3)) : 0
    };
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
    // Independent Web Audio control: a known local oscillator must produce
    // measurable PCM in this same headless macOS WebKit AudioContext.
    // If it does not, an all-zero media measurement cannot convict the AAC.
    const osc = probe.context.createOscillator();
    const controlGain = probe.context.createGain();
    controlGain.gain.value = 0.10;
    const controlAnalyser = probe.context.createAnalyser();
    controlAnalyser.fftSize = 2048;
    osc.frequency.value = 440;
    osc.connect(controlGain);
    controlGain.connect(controlAnalyser);
    controlAnalyser.connect(probe.context.destination);
    osc.start();
    let controlPeakRms = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 80));
      controlAnalyser.getFloatTimeDomainData(pcm);
      let power = 0;
      for (const x of pcm) power += x * x;
      controlPeakRms = Math.max(controlPeakRms, Math.sqrt(power / pcm.length));
    }
    osc.stop();
    osc.disconnect();
    controlGain.disconnect();
    controlAnalyser.disconnect();
    return {
      contextState: probe.context.state,
      trustedClick: Boolean(window.__hevcAudioTrustedClick),
      peakRms, nonSilentWindows, controlPeakRms,
      playableTimeAdvanced: Number((video.currentTime - before).toFixed(3)),
      mediaError: video.error?.code ?? null,
      mediaState
    };
  });
  console.log('macOS WebKit real HEVC/AAC decoded PCM:', JSON.stringify(audio));
  // Do not abort the independent seek acceptance when audio is inconclusive.
  // Keep AudioContext alive so its analyser can also measure post-seek media.
  const audioValid = audio.contextState === 'running' &&
    audio.trustedClick && audio.peakRms > 0.004 &&
    audio.nonSilentWindows >= 4 && audio.playableTimeAdvanced > 2 &&
    audio.mediaError == null;
  const audioControlValid = Number(audio.controlPeakRms || 0) > 0.01;
  const nativeElementPcm = Boolean(mediaControl?.native?.mediaPcmMeasured);
  const mseElementPcm = Boolean(mediaControl?.mse?.mediaPcmMeasured);
  console.log('macOS WebKit Web Audio control:', JSON.stringify({
    oscillatorProducesPCM: audioControlValid,
    knownAudibleNativeMp4PCM: nativeElementPcm,
    knownAudibleH264MsePCM: mseElementPcm,
    mediaProducesPCM: audioValid,
    interpretation: !audioControlValid ? 'WEB_AUDIO_SINK_UNVERIFIED'
      : audioValid ? 'REAL_AAC_PCM_PASS'
      : !nativeElementPcm ? 'MEDIA_ELEMENT_CAPTURE_NOT_VALIDATED'
      : !mseElementPcm ? 'MSE_AUDIO_CAPTURE_NOT_VALIDATED'
      : 'REAL_HEVC_MSE_PCM_NOT_DETECTED_DESPITE_VALID_CONTROLS'
  }));

  // The player must perform an indexed unbuffered seek, not pretend to seek
  // inside the first 40s of buffered media. This is the real CENC Range path.
  const target = 120;
  const before = await page.evaluate(target => {
    const video = document.querySelector('#player-video');
    return {
      currentTime: video.currentTime,
      frames: window.__liveHevcFrames || 0,
      totalFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
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
  await page.waitForFunction(({ target, beforeFrames, beforeTotalFrames }) => {
    const video = document.querySelector('#player-video');
    const status = document.querySelector('#player-status')?.textContent || '';
    const advanced = video?.currentTime > target - 1 &&
      video?.currentTime < target + 8 && video.readyState >= 2 &&
      ((window.__liveHevcFrames || 0) > beforeFrames + 1 ||
        (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > beforeTotalFrames + 1);
    return advanced || /已停止播放|跳轉失敗|無法播放/.test(status);
  }, { target, beforeFrames: before.frames, beforeTotalFrames: before.totalFrames },
  { timeout: 90000 }).catch(() => {});
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
      totalFrames: v?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
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
  const seekValid = Math.abs(seek.currentTime - target) < 8 &&
    seek.readyState >= 2 && !seek.seeking && seek.mediaError == null &&
    (seek.frames > before.frames + 1 || seek.totalFrames > before.totalFrames + 1);
  if (seekValid)
    console.log('PASS real Hongguo HEVC distant unbuffered seek and decoded frames');
  // The decoded audio track may legitimately be quiet at the start. If we
  // reached 120s, also check 3 more seconds of PCM at the seek destination.
  let afterSeekAudio = null;
  if (seekValid && !audioValid && audioControlValid) {
    afterSeekAudio = await page.evaluate(async () => {
      const probe = window.__hevcAudioProbe;
      if (!probe?.analyser || probe.context.state !== 'running')
        return { unavailable: true };
      const samples = new Float32Array(probe.analyser.fftSize);
      let maxRms = 0, nonSilentWindows = 0;
      const initial = document.querySelector('#player-video')?.currentTime || 0;
      for (let i = 0; i < 48; i++) {
        await new Promise(resolve => setTimeout(resolve, 80));
        probe.analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        maxRms = Math.max(maxRms, rms);
        if (rms > 0.002) nonSilentWindows++;
      }
      const current = document.querySelector('#player-video')?.currentTime || 0;
      return { peakRms: maxRms, nonSilentWindows,
        playbackSeconds: Number((current - initial).toFixed(3)) };
    });
    console.log('macOS WebKit real AAC after 120s HEVC seek:', JSON.stringify(afterSeekAudio));
  }
  await page.evaluate(() => {
    void window.__hevcAudioProbe?.context?.close().catch(() => {});
    document.querySelector('#hevc-enable-aac-pcm-test')?.remove();
  });
  const failures = [];
  if (!seekValid) failures.push('Real HEVC 120s remote seek / decoded frames did not pass');
  if (!audioControlValid) failures.push('Web Audio oscillator control did not produce PCM; cannot validate AAC');
  if (!audioValid && !(afterSeekAudio?.peakRms > 0.004 &&
      afterSeekAudio.nonSilentWindows >= 4)) {
    if (nativeElementPcm && mseElementPcm)
      failures.push('Real HEVC MSE AAC PCM not detected despite positive known-audible MP4/MSE controls');
    else
      // WebKit bug 266922: an audible MSE media element can produce all-zero
      // MediaElementAudioSourceNode samples. Do not turn an unmeasurable
      // output into a false playback failure or a false AAC PASS.
      console.warn('NOT TESTED real HEVC audible output: WebKit MSE MediaElementAudioSourceNode returned zero for known-audible synthetic AAC');
  }
  assert.deepEqual(failures, [], 'Extended real HEVC acceptance failures');
  console.log(nativeElementPcm && mseElementPcm
    ? 'PASS real Hongguo HEVC AAC PCM plus 120s distant seek'
    : 'PASS real Hongguo HEVC 120s distant seek; actual audible AAC remains NOT TESTED');

}
