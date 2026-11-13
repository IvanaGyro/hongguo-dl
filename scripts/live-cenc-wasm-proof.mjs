// One-off real-media acceptance on an already publicly accessible sample.
// Fetches authorized /api/source metadata freshly, then ONLY strictly bounded
// HTTP 206 ranges through the user's own Worker. No credentials or media in logs,
// repo, cache, artifacts or commits; the clear fMP4 exists only in runner /tmp.
// Unlike synthetic browser CI this verifies the real HEVC/AAC CENC bitstream.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { probeCencKid } from '../src/clear-key.js';
import { readVerifiedRange } from '../src/http-range.js';
import { createFmp4Assembler } from '../src/fmp4-assembler.js';
import { assertHevcInitCodecMatches } from '../src/cenc-init-codec.js';
import { verifyManifest } from './cenc-wasm-bundle.mjs';

const ORIGIN = 'https://hongguo-dl.ivana-gyro.workers.dev';
const FRONTEND = 'https://ivanagyro.github.io';
const SID = '7699513062054710296';
const MAX_CANDIDATES = 10;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_HTTP_REQUESTS = 120;
const MAX_HTTP_BYTES = 32 * 1024 * 1024;
const WINDOW = 256 * 1024;
const OUTPUT_CAP = 40 * 1024 * 1024;
const OUTPUT_FILE = process.argv[2] || '/tmp/hongguo-live-clear-fmp4.mp4';
const timeout = ms => AbortSignal.timeout(ms);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let requests = 0, bytesRequested = 0, responses206 = 0, inspected = 0;
let rateLimited = false;
const statuses = new Map(), failureReasons = new Map();
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const snapshot = () => ({
  candidateAttempts: inspected, requests, bytesRequested,
  responses206, httpStatuses: Object.fromEntries(statuses),
  failureReasons: Object.fromEntries(failureReasons)
});
function stableError(error) {
  if (rateLimited) return 'SOURCE_RATE_LIMITED';
  // Never log error.message: native network errors can contain signed URLs.
  if (/^CENC_[A-Z_]+$/.test(error?.code || '')) return error.code;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
    return 'TRANSPORT_TIMEOUT';
  return 'RANGE_OR_REMUX_FAILED';
}
async function getJSON(path) {
  const response = await fetch(ORIGIN + path, {
    headers: { Origin: FRONTEND, Accept: 'application/json' },
    signal: timeout(20000), cache: 'no-store'
  });
  if (!response.ok) throw new Error('SOURCE_METADATA_HTTP_' + response.status);
  return response.json();
}
const fetchMedia = async (url, options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range || '');
  if (!match) throw new Error('RANGE_MUST_BE_BOUNDED');
  const requested = Number(match[2]) - Number(match[1]) + 1;
  if (!Number.isSafeInteger(requested) || requested < 1 ||
      requested > 1024 * 1024 ||
      requests >= MAX_HTTP_REQUESTS || bytesRequested + requested > MAX_HTTP_BYTES)
    throw new Error('RANGE_BUDGET_EXHAUSTED');
  requests++;
  bytesRequested += requested;
  const response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Origin: FRONTEND },
    signal: AbortSignal.any([timeout(20000), options.signal].filter(Boolean)),
    cache: 'no-store'
  });
  bump(statuses, String(response.status));
  if (response.status === 206) responses206++;
  if (response.status === 429) {
    rateLimited = true;
    await response.body?.cancel().catch(() => {});
    throw new Error('SOURCE_RATE_LIMITED');
  }
  return response;
};

async function proveCandidate(candidate, episodeNumber) {
  const media = new URL('/api/media', ORIGIN);
  media.searchParams.set('url', candidate.url);
  media.searchParams.set('profile', candidate.source === 'app' ? 'app' : 'web');
  const metadata = {};
  const kid = await probeCencKid(media.href, null, fetchMedia, metadata);
  if (!kid || !['hev1', 'hvc1'].includes(metadata.videoCodec) ||
      !metadata.hevcCodecString || !metadata.hasAac)
    throw new Error('SOURCE_NOT_VALID_HEVC_AAC_CENC');
  const size = metadata.fileSize;
  if (!Number.isSafeInteger(size) || size < 128 * 1024 || size > MAX_FILE)
    throw new Error('REAL_FILE_SIZE_OUTSIDE_BOUNDED_PROOF');

  // The same pinned, published WASM that the browser Worker loads.
  verifyManifest();
  const { default: createCore } = await import(
    new URL('../public/cenc/cenc-core.mjs', import.meta.url).href);
  let cacheStart = -1, cache = new Uint8Array(0), maxFetchedEnd = 0;
  const readRange = async (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length <= 0 || length > 1024 * 1024 ||
        offset + length > size) throw new Error('WASM_RANGE_OUT_OF_BOUNDS');
    if (cacheStart >= 0 && offset >= cacheStart &&
        offset + length <= cacheStart + cache.length)
      return cache.subarray(offset - cacheStart, offset - cacheStart + length);
    const end = Math.min(size, offset + Math.max(length, WINDOW)) - 1;
    const bytes = await readVerifiedRange(fetchMedia, media.href, offset, end,
      size, timeout(20000));
    cacheStart = offset;
    cache = bytes;
    maxFetchedEnd = Math.max(maxFetchedEnd, end + 1);
    return cache.subarray(0, length);
  };

  const pieces = [];
  let outputBytes = 0, firstMediaAt = null, initMime = null;
  const append = bytes => {
    outputBytes += bytes.length;
    if (outputBytes > OUTPUT_CAP) throw new Error('OUTPUT_MEMORY_CAP');
    pieces.push(Buffer.from(bytes));
  };
  const assembler = createFmp4Assembler({
    onInit: async bytes => {
      initMime = assertHevcInitCodecMatches(bytes, metadata.hevcCodecString);
      append(bytes);
    },
    onMedia: async bytes => {
      if (firstMediaAt == null) firstMediaAt = maxFetchedEnd;
      append(bytes);
    }
  });
  const core = await createCore({
    wasmBinary: readFileSync(new URL('../public/cenc/cenc-core.wasm', import.meta.url)),
    readRange, writeChunk: data => assembler.push(data)
  });
  assert.equal(core._cenc_remux_available(), 1, 'Pinned WASM MOV/mux unavailable');
  const result = await core.ccall('cenc_stream_remux', 'number',
    ['number', 'string'], [size, candidate.contentKey], { async: true });
  if (result !== 0) throw new Error('REAL_CENC_REMUX_FAILED');
  const fragmentCount = assembler.finish();
  assert(firstMediaAt != null && firstMediaAt < size,
    'No full fMP4 media unit before complete source fetch');
  assert(fragmentCount > 0, 'No playable fMP4 fragment');
  assert(initMime && /^h(?:vc|ev)1\./.test(initMime),
    'Output HEVC MIME must match real hvcC sample entry');
  writeFileSync(OUTPUT_FILE, Buffer.concat(pieces));
  console.log('PASS real HEVC CENC -> clear fMP4 via pinned Librempeg WASM:',
    JSON.stringify({
      episode: episodeNumber,
      codec: 'HEVC', audio: 'AAC', encrypted: true,
      fileSize: size, outputBytes,
      firstFragmentFetchedBytes: firstMediaAt,
      firstFragmentBeforeEOF: true, fragmentCount,
      hasExactHevcCodec: true,
      ...snapshot()
    }));
  return true;
}

const series = await getJSON('/api/series?input=' + SID);
const accessible = (series.episodes || [])
  .filter(e => e.available === true && e.vid)
  // Recently observed episode 3 serving a valid 206. Try that first, then
  // other openly available episodes/CDNs without repeating denied sources.
  .sort((a, b) => (a.index === 3 ? -1 : b.index === 3 ? 1 : a.index - b.index))
  .slice(0, 5);
if (!accessible.length) throw new Error('NO_ACCESSIBLE_PUBLIC_EPISODE');

let success = false;
for (const episode of accessible) {
  if (rateLimited || success || inspected >= MAX_CANDIDATES ||
      requests >= MAX_HTTP_REQUESTS) break;
  let candidates;
  try {
    const data = await getJSON('/api/source?' +
      new URLSearchParams({ sid: SID, vid: String(episode.vid),
        quality: 'auto', codec: 'auto' }));
    candidates = (data.variants || []).filter(v =>
      /^(hevc|h265|hvc1|hev1|bytevc1)$/i.test(v.codec || '') &&
      !!v.contentKey && /^https:\/\//.test(v.url || '') &&
      !/\.m3u8(?:[?#]|$)/i.test(v.url || ''))
      .sort((a, b) => (parseInt(b.quality, 10) || 0) -
        (parseInt(a.quality, 10) || 0))
      .slice(0, 2);
  } catch {
    bump(failureReasons, 'SOURCE_METADATA');
    continue;
  }
  for (const candidate of candidates) {
    if (rateLimited || success || inspected >= MAX_CANDIDATES ||
        requests >= MAX_HTTP_REQUESTS) break;
    inspected++;
    try {
      success = await proveCandidate(candidate, episode.index);
    } catch (error) {
      const reason = stableError(error);
      bump(failureReasons, reason);
      console.log('Real HEVC remux candidate did not pass:', JSON.stringify({
        episode: episode.index, candidate: inspected, reason
      }));
    }
    if (!success && !rateLimited) await delay(900);
  }
}
console.log('Real HEVC WASM proof summary:', JSON.stringify({
  verdict: success ? 'REAL_REMUX_PASS' : rateLimited
    ? 'STOPPED_ON_429' : 'REAL_REMUX_NOT_VERIFIED',
  ...snapshot()
}));
if (!success)
  throw new Error('Real HEVC WASM proof blocked; inspect sanitized summary');
// The caller runs FFmpeg -xerror against the temporary decoded video/audio.
