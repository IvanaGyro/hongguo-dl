// SPDX-License-Identifier: GPL-3.0-only
// Output-container timeline sanity checks; not a proof of per-frame A/V sync.
// Used only for a locally authorized ByteVC2 positive fixture.
function finiteSeconds(value) {
  if (value == null || value === 'N/A' || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function checkAvTimeline(video, audio, toleranceSeconds = 1.5) {
  if (!audio) return { checked: false, reason: 'no-audio-track' };
  const videoStart = finiteSeconds(video?.start_time);
  const audioStart = finiteSeconds(audio.start_time);
  const videoDuration = finiteSeconds(video?.duration);
  const audioDuration = finiteSeconds(audio.duration);
  if ([videoStart, audioStart, videoDuration, audioDuration].some(v => v === null) ||
      videoDuration <= 0 || audioDuration <= 0)
    throw new Error('Cannot validate ByteVC2 output A/V timestamps');
  const startSkew = Math.abs(videoStart - audioStart);
  const endSkew = Math.abs((videoStart + videoDuration) -
    (audioStart + audioDuration));
  if (startSkew > toleranceSeconds || endSkew > toleranceSeconds)
    throw new Error('ByteVC2 output audio/video timeline mismatch');
  return {
    checked: true,
    startSkewSeconds: +startSkew.toFixed(3),
    endSkewSeconds: +endSkew.toFixed(3)
  };
}
