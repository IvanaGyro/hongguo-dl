// Read-only, bounded live metadata check for the public sample series.
// No full video, no media secrets in logs, at most one accessible episode.
import { probeCencKid } from '../src/clear-key.js';

const ORIGIN = 'https://hongguo-dl.ivana-gyro.workers.dev';
const FRONTEND = 'https://ivanagyro.github.io';
const SID = '7699513062054710296';
const MAX_RANGE = 1024 * 1024;
const MAX_MEDIA_REQUESTS = 6;
const json = async path => {
  const res = await fetch(ORIGIN + path, {
    headers: { Origin: FRONTEND, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000), cache: 'no-store'
  });
  if (!res.ok) throw new Error('Metadata API HTTP ' + res.status);
  return res.json();
};
const series = await json('/api/series?input=' + SID);
const episode = series.episodes?.find(e => e.available !== false);
if (!episode) throw new Error('No accessible sample episode for bounded check');
const params = new URLSearchParams({ sid: SID, vid: String(episode.vid),
  quality: 'auto', codec: 'auto' });
const source = await json('/api/source?' + params);
const choices = (source.variants || []).filter(v =>
  /^(hevc|h265|hvc1|hev1|bytevc1)$/i.test(v.codec || '') &&
  /^https:\/\//.test(v.url || '') && !/\.m3u8(?:[?#]|$)/i.test(v.url || ''));
const sorted = choices.sort((a, b) =>
  (Number(b.height || 0) || parseInt(b.quality, 10) || 0) -
  (Number(a.height || 0) || parseInt(a.quality, 10) || 0));
const candidates = sorted.filter(v => v.contentKey &&
  v.quality === sorted[0]?.quality).slice(0, 2);
if (!candidates.length) {
  console.log('Live CENC layout: no encrypted HEVC MP4 in accessible episode #' + episode.index);
  process.exit(0);
}
let count = 0, announcedBytes = 0;
const fetchImpl = async (url, options) => {
  const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range || '');
  if (!range) throw new Error('Only explicit bounded HTTP byte ranges are allowed');
  const bytes = Number(range[2]) - Number(range[1]) + 1;
  if (!Number.isSafeInteger(bytes) || bytes < 8 || bytes > MAX_RANGE)
    throw new Error('Probe exceeds 1 MiB per request');
  if (++count > MAX_MEDIA_REQUESTS)
    throw new Error('Probe request budget exceeded');
  announcedBytes += bytes;
  if (announcedBytes > 3 * MAX_RANGE)
    throw new Error('Probe combined byte budget exceeded');
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers, Origin: FRONTEND },
    signal: AbortSignal.timeout(20000), cache: 'no-store'
  });
  if (res.status === 429) throw new Error('CDN rate-limited; stopped immediately');
  if (res.status !== 206) {
    console.log('Live CENC metadata Range request returned HTTP ' + res.status +
      ' (no media bytes read)');
    await res.body?.cancel();
  }
  return res;
};
const problems = [];
let succeeded = false;
for (const [i, candidate] of candidates.entries()) {
  const mediaUrl = new URL('/api/media', ORIGIN);
  mediaUrl.searchParams.set('url', candidate.url);
  mediaUrl.searchParams.set('profile', candidate.source === 'app' ? 'app' : 'web');
  const metadata = {};
  try {
    const kid = await probeCencKid(mediaUrl.href, null, fetchImpl, metadata);
    console.log('Live CENC layout:', JSON.stringify({
      episode: episode.index,
      candidate: i + 1,
      codec: candidate.codec,
      quality: candidate.quality,
      encrypted: true,
      hasCencKid: Boolean(kid),
      fragmented: metadata.fragmented ?? null,
      fileSizeBytes: metadata.fileSize ?? null,
      rangeRequests: count,
      requestedBytesMax: announcedBytes
    }));
    succeeded = true;
    break;
  } catch (error) {
    if (String(error.message).includes('rate-limited')) throw error;
    problems.push(error.name || 'Error');
    console.log('Live CENC layout: candidate ' + (i + 1) +
      ' not accessible for bounded Range inspection');
  }
}
if (!succeeded) throw new Error('All ' + candidates.length +
  ' bounded CENC metadata probes were inaccessible (' + problems.join(', ') + ')');
// This check never downloads a complete episode or claims HEVC decode succeeds.
