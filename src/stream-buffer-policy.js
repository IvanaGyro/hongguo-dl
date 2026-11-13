// SPDX-License-Identifier: GPL-3.0-only
const MiB = 1024 * 1024;
export function streamBufferPolicy({ fileSize, durationSeconds, saveData = false, deviceMemory = 4 } = {}) {
  const lowMemory = deviceMemory > 0 && deviceMemory <= 2;
  const cacheBudget = lowMemory || saveData ? 16 * MiB : 32 * MiB;
  const bytesPerSecond = fileSize > 0 && durationSeconds > 0 ? fileSize / durationSeconds : 0;
  const ahead = saveData ? 30 : bytesPerSecond
    ? Math.max(30, Math.min(120, (lowMemory ? 4 : 8) * MiB / bytesPerSecond)) : 60;
  const behind = bytesPerSecond ? Math.max(30, Math.min(90, 4 * MiB / bytesPerSecond)) : 60;
  return { cacheBudget, ahead, refill: Math.max(15, ahead * 0.65), behind,
    rawPrefetch: !saveData };
}
export function bufferedIntervals(ranges) {
  try { return Array.from({ length: ranges?.length || 0 }, (_, i) => [ranges.start(i), ranges.end(i)]); }
  catch { return []; }
}
export function bufferedAround(ranges, time) {
  const interval = bufferedIntervals(ranges).find(([a, b]) => time >= a && time <= b);
  return { bufferedAhead: interval ? interval[1] - time : 0,
    bufferedBehind: interval ? time - interval[0] : 0 };
}
