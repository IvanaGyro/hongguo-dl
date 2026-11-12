// One-episode lookahead, measured against actual startup latency.
// Keep ahead of the end without prefetching half the series or wasting traffic.
export function nextEpisode(episodes, currentVid) {
  if (!Array.isArray(episodes)) return null;
  const ordered = [...episodes].sort((a, b) => Number(a.index) - Number(b.index));
  const index = ordered.findIndex(ep => ep.vid === currentVid);
  return index >= 0 ? ordered[index + 1] || null : null;
}
export function prefetchLeadSeconds(durationSeconds, startupSeconds = 0) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const elapsed = Number.isFinite(startupSeconds) && startupSeconds > 0 ? startupSeconds : 0;
  const lead = Math.max(45, elapsed * 1.6 + 12);
  return Math.min(durationSeconds * 0.75, Math.min(90, lead));
}
export function shouldPrefetchNext({
  duration, position, startupSeconds = 0, paused = false, autoNext = true,
  saveData = false, hasNext = true
}) {
  if (!autoNext || paused || saveData || !hasNext || !Number.isFinite(position)) return false;
  const lead = prefetchLeadSeconds(duration, startupSeconds);
  return lead > 0 && position > 0 && position >= duration - lead && position < duration;
}
