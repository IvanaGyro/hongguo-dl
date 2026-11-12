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
// The same episode receives a stable, naturally sorted name. Quality/codec
// suffixes prevent overwriting a different rendition in a selected directory.
export function episodeFileName(job, extension = '.mp4') {
  if (!job.seriesId || job.vid === 'direct') {
    return '媒體直連_' + String(job.id || 'unknown').slice(0, 8) + normalizedExtension(extension);
  }
  const title = safeName(job.seriesTitle || job.title?.split(' · 第')[0] || '短劇');
  const padded = String(Number(job.index) || 1).padStart(3, '0');
  const variants = [job.quality !== 'auto' ? job.quality : '',
    job.codec !== 'auto' ? job.codec : '',
    job.mode === 'h264' ? '轉H264' : ''].filter(Boolean);
  return title + '_第' + padded + '集' + (variants.length ? '_' + safeName(variants.join('_')) : '') +
    normalizedExtension(extension);
}
export function collectionFileName(items, format) {
  const ordered = [...items].sort((a, b) => Number(a.index) - Number(b.index));
  const series = new Set(ordered.map(j => String(j.seriesId || 'direct')));
  const title = series.size === 1 ? safeName(ordered[0]?.seriesTitle || '影集') : '多部影集';
  const range = series.size === 1 ? '_第' + ordered[0].index + '-' +
    ordered[ordered.length - 1].index + '集' : '_' + ordered.length + '集';
  return title + range + (format === 'zip' ? '.zip' : '_無損合併.mp4');
}
