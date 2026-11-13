// Live read-only, bounded verification of a public, accessible Hongguo series.
// Rotate across recently resolved accessible episodes/CDNs instead of retrying
// one possibly expired signed media URL. Never log a URL, token, KID or key.
import { probeCencKid } from '../src/clear-key.js';

const ORIGIN = 'https://hongguo-dl.ivana-gyro.workers.dev';
const FRONTEND = 'https://ivanagyro.github.io';
const SID = '7699513062054710296';
const MAX_EPISODES = 4;
const MAX_CANDIDATES_PER_EPISODE = 2;
const MAX_RANGE = 1024 * 1024;
const MAX_MEDIA_REQUESTS = 12;
const MAX_REQUESTED_BYTES = 6 * MAX_RANGE;
const REQUEST_TIMEOUT_MS = 14000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getMetadata(path) {
  const response = await fetch(ORIGIN + path, {
    headers: { Origin: FRONTEND, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000), cache: 'no-store'
  });
  if (!response.ok) throw new Error('Metadata API HTTP ' + response.status);
  return response.json();
}

const series = await getMetadata('/api/series?input=' + SID);
const episodes = (series.episodes || [])
  .filter(episode => episode.available === true && episode.vid)
  .slice(0, MAX_EPISODES);
if (!episodes.length) throw new Error('No accessible public episodes for bounded probe');

let requests = 0, requestedBytes = 0, confirmed206 = 0;
let inspectedCandidates = 0, timedOut = 0, transportFailures = 0;
let rateLimited = false;
const statuses = new Map(), reasons = new Map();
const countReason = name => reasons.set(name, (reasons.get(name) || 0) + 1);
const stats = () => ({
  episodesChecked: episodes.length, inspectedCandidates, requests, requestedBytes,
  confirmed206, timedOut, transportFailures,
  statuses: Object.fromEntries(statuses),
  reasons: Object.fromEntries(reasons)
});
const fetchRange = async (url, options) => {
  const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range || '');
  if (!range) throw new Error('Only bounded explicit Range requests permitted');
  const size = Number(range[2]) - Number(range[1]) + 1;
  if (!Number.isSafeInteger(size) || size < 8 || size > MAX_RANGE)
    throw new Error('Range must be <=1MiB');
  if (requests >= MAX_MEDIA_REQUESTS || requestedBytes + size > MAX_REQUESTED_BYTES)
    throw new Error('Range budget exhausted');
  requests++;
  requestedBytes += size;
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Origin: FRONTEND },
      signal: AbortSignal.any(
        [AbortSignal.timeout(REQUEST_TIMEOUT_MS), options.signal].filter(Boolean)),
      cache: 'no-store'
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') timedOut++;
    else transportFailures++;
    throw new Error(error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'RANGE_TIMEOUT' : 'RANGE_TRANSPORT');
  }
  statuses.set(String(response.status), (statuses.get(String(response.status)) || 0) + 1);
  if (response.status === 206) confirmed206++;
  if (response.status === 429) {
    rateLimited = true;
    await response.body?.cancel().catch(() => {});
    throw new Error('RANGE_RATE_LIMITED');
  }
  // probeCencKid checks the exact Content-Range, Content-Length, file bounds,
  // moov, tenc and hvcC. Never turn non-206 into whole-file fallback.
  return response;
};

let usable = false;
for (const episode of episodes) {
  if (rateLimited || usable || requests >= MAX_MEDIA_REQUESTS) break;
  // Fresh metadata call for each episode, not a cached expired CDN signature.
  let variants;
  try {
    const source = await getMetadata('/api/source?' +
      new URLSearchParams({ sid: SID, vid: String(episode.vid) }));
    variants = (source.variants || []).filter(v =>
      /^(hevc|h265|hvc1|hev1|bytevc1)$/i.test(v.codec || '') &&
      !!v.contentKey && /^https:\/\//.test(v.url || '') &&
      !/\.m3u8(?:[?#]|$)/i.test(v.url || ''))
      .sort((a, b) => (parseInt(b.quality, 10) || 0) -
        (parseInt(a.quality, 10) || 0))
      .slice(0, MAX_CANDIDATES_PER_EPISODE);
  } catch (error) {
    countReason('source-metadata-' + (error.name || 'Error'));
    console.log('Live HEVC source metadata unavailable for episode ' + episode.index);
    continue;
  }
  if (!variants.length) {
    countReason('no-encrypted-hevc-candidates');
    continue;
  }
  for (const [index, candidate] of variants.entries()) {
    if (rateLimited || usable || requests >= MAX_MEDIA_REQUESTS) break;
    inspectedCandidates++;
    const mediaUrl = new URL('/api/media', ORIGIN);
    mediaUrl.searchParams.set('url', candidate.url);
    mediaUrl.searchParams.set('profile', candidate.source === 'app' ? 'app' : 'web');
    const metadata = {};
    try {
      const kid = await probeCencKid(mediaUrl.href, null, fetchRange, metadata);
      // A valid HTTP 206 is useful evidence, but a playable CENC track also
      // needs an actual KID, HEVC video format and exact hvcC profile string.
      console.log('Live HEVC bounded metadata result:', JSON.stringify({
        episode: episode.index, candidate: index + 1,
        codec: candidate.codec, quality: candidate.quality,
        http206: confirmed206 > 0, hasCencKid: Boolean(kid),
        videoCodec: metadata.videoCodec || null,
        hasAac: metadata.hasAac ?? null,
        hasHevcProfile: Boolean(metadata.hevcCodecString),
        fragmented: metadata.fragmented ?? null,
        fileSizeBytes: metadata.fileSize ?? null
      }));
      if (kid && ['hev1', 'hvc1'].includes(metadata.videoCodec) &&
          metadata.hevcCodecString) {
        usable = true;
        break;
      }
      countReason('missing-cenc-hevc-metadata');
    } catch (error) {
      if (error.message === 'RANGE_RATE_LIMITED') {
        countReason('RANGE_RATE_LIMITED');
        break;
      }
      const known = ['RANGE_TIMEOUT', 'RANGE_TRANSPORT',
        'Range budget exhausted'].includes(error.message);
      const reason = known ? error.message :
        /^[A-Z_]+$/.test(error.code || '') ? error.code :
          error.name === 'Error' ? 'PROBE_ERROR' : (error.name || 'PROBE_ERROR');
      countReason(reason);
      console.log('Live HEVC bounded candidate failed:', JSON.stringify({
        episode: episode.index, candidate: index + 1, reason
      }));
    }
    // Avoid a burst of requests that could trigger upstream rate limits.
    if (!usable && !rateLimited) await delay(900);
  }
}

console.log('Live HEVC bounded probe summary:', JSON.stringify({
  verdict: usable ? 'CENC_METADATA_PASS' :
    rateLimited ? 'SOURCE_RATE_LIMITED' :
      confirmed206 ? 'HTTP_206_ONLY_NO_VERIFIED_HEVC' : 'NO_206',
  ...stats()
}));
if (!usable)
  throw new Error(rateLimited ? 'CDN 429: stopped further probes immediately' :
    'Real HEVC CENC metadata not verified; no playable authorized 206 candidate');
// Actual HEVC MSE decoding and the first displayed frame require a real device.
