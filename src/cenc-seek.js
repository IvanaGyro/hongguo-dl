// SPDX-License-Identifier: GPL-3.0-only
// A seek into an unbuffered interval must rebuild the CENC AVIO remux at the
// preceding RAP. A seek inside the existing SourceBuffer needs no network reset.
export function timeIsBuffered(ranges, seconds, tolerance = 0.15) {
  if (!ranges || !Number.isFinite(seconds) || seconds < 0) return false;
  try {
    for (let index = 0; index < ranges.length; index++) {
      if (seconds >= ranges.start(index) - tolerance &&
          seconds <= ranges.end(index) + tolerance) return true;
    }
  } catch { return false; }
  return false;
}
export function clampStreamSeek(seconds, duration) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, seconds);
  return Math.min(seconds, Math.max(0, duration - 0.3));
}
