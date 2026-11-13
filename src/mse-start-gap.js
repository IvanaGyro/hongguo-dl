// SPDX-License-Identifier: GPL-3.0-only
// A tiny MSE timestamp-gap correction for zero-start HEVC CENC playback.
// Real Librempeg fMP4 may buffer [0.16, ...] due to source AV timing. Safari
// WebKit then holds HAVE_METADATA if currentTime is still 0. Never rewrite
// timestamps or shift an explicit user seek; move only into the already
// buffered first interval, and only if the gap is sub-500ms.
export function alignInitialCencBufferedStart(video, startSeconds = 0) {
  if (!Number.isFinite(startSeconds) || startSeconds > 0.01 ||
      !video || video.readyState < 1 || video.seeking ||
      !video.buffered?.length || !Number.isFinite(video.currentTime) ||
      video.currentTime > 0.01 || video.currentTime < 0) return false;
  try {
    const start = video.buffered.start(0);
    const end = video.buffered.end(0);
    if (!Number.isFinite(start) || !Number.isFinite(end) ||
        !(start > 0.01 && start <= 0.5) || end - start < 0.1) return false;
    const target = Math.min(start + 0.04, end - 0.02);
    if (!(target > start && target < end)) return false;
    video.currentTime = target;
    return true;
  } catch {
    // Another video source may have replaced this SourceBuffer mid-append.
    return false;
  }
}
