// SPDX-License-Identifier: GPL-3.0-only
// Return a safe end timestamp for MSE SourceBuffer eviction.
export function evictionEnd(buffered, currentTime, keepBehind = 30, minEvict = 8) {
  if (!buffered || !Number.isFinite(currentTime) ||
      !Number.isFinite(keepBehind) || keepBehind < 0)
    return null;
  const end = Math.max(0, currentTime - keepBehind);
  try {
    if (!buffered.length || end - buffered.start(0) < minEvict) return null;
    // SourceBuffer.remove accepts a continuous range covering any gaps.
    // Never remove media at or ahead of the current playback time.
    return end > 0 ? end : null;
  } catch { return null; }
}
