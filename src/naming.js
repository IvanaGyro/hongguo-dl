import { safeName } from './logic.js';
const VIDEO_EXT = /^\.(mp4|m4v|mov|mkv|ts|webm)$/;
export function normalizedExtension(extension) {
  const ext = String(extension || '.mp4').toLowerCase();
  return VIDEO_EXT.test(ext) ? ext : '.mp4';
}
export function originalExtension(sourceUrl) {
  try {
    const ext = /\.[a-z0-9]+$/i.exec(new URL(sourceUrl).pathname)?.[0];
    return normalizedExtension(ext);
  } catch { return '.mp4'; }
}
// The same episode is named consistently regardless of source quality or mode.
// Episode digits follow the full series count, with a minimum width of two.
// Direct media does not belong to a series and retains its unique naming rule.
export function episodeFileName(job, extension = '.mp4') {
  if (!job.seriesId || job.vid === 'direct') {
    return '媒體直連_' + String(job.id || 'unknown').slice(0, 8) + normalizedExtension(extension);
  }
  const title = safeName(job.seriesTitle || job.title?.split(' · 第')[0] || '短劇');
  const total = Number(job.seriesTotal ?? job.total);
  const width = Number.isSafeInteger(total) && total > 0 ? Math.max(2, String(total).length) : 2;
  const index = Math.max(1, Math.trunc(Number(job.index) || 1));
  return title + '.E' + String(index).padStart(width, '0') + normalizedExtension(extension);
}
export function filenameExtension(filename) {
  return normalizedExtension(/\.[a-z0-9]+$/i.exec(String(filename || ''))?.[0]);
}
export function collectionFileName(items, format) {
  const ordered = [...items].sort((a, b) => Number(a.index) - Number(b.index));
  const series = new Set(ordered.map(j => String(j.seriesId || 'direct')));
  const title = series.size === 1 ? safeName(ordered[0]?.seriesTitle || '影集') : '多部影集';
  const range = series.size === 1 ? '_第' + ordered[0].index + '-' +
    ordered[ordered.length - 1].index + '集' : '_' + ordered.length + '集';
  return title + range + (format === 'zip' ? '.zip' : '_無損合併.mp4');
}
