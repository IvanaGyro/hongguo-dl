// SPDX-License-Identifier: GPL-3.0-only
// Bounded MP4 metadata inspection (max 8 MiB moov). Pure fetch/byte logic,
// shared by the media Worker's download layer and Node tests; no DOM/EME/MSE.
import { retryAfterMs } from './retry-after.js';
import { withRangeDeadline, RANGE_TIMEOUT_MS, rangeTiming } from './range-deadline.js';
import { errorWith } from './logic.js';
import { inspectMp4TrackFormats, hevcCodecStringFromMoov,
  movieDurationSeconds } from './mp4-track-formats.js';

const HEADER_SIZE = 64 * 1024;
// Long progressive MP4 files can carry >1 MiB of indexed samples in moov
// (especially per-frame AAC sample tables). Cap this at 8 MiB rather than
// silently downgrading back to a full-episode fetch.
const MAX_MOOV = 8 * 1024 * 1024;
const MAX_RANGES = 4;

const read32 = (data, pos) =>
  (data[pos] * 0x1000000 + (data[pos + 1] << 16) + (data[pos + 2] << 8) + data[pos + 3]) >>> 0;
const typeAt = (data, pos) =>
  String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);

export function mp4Boxes(data, fileOffset = 0) {
  const boxes = [];
  for (let pos = 0; pos + 8 <= data.length;) {
    let size = read32(data, pos), header = 8;
    if (size === 1) {
      if (pos + 16 > data.length) break;
      size = read32(data, pos + 8) * 0x100000000 + read32(data, pos + 12);
      header = 16;
    }
    if (!Number.isSafeInteger(size) || size < header) break;
    const box = { type: typeAt(data, pos), offset: fileOffset + pos,
      size, complete: size <= data.length - pos };
    boxes.push(box);
    if (!box.complete) break;
    pos += size;
  }
  return boxes;
}

export function cencKidFromMoov(data) {
  if (!(data instanceof Uint8Array) || data.length > MAX_MOOV ||
      data.length < 32 || typeAt(data, 0) !== 'moov' ||
      read32(data, 0) !== data.length) return null;
  // Only examine moov (not mdat). Validate tenc size and version before
  // taking the default_KID; the rest of the CENC structure stays native.
  for (let typePos = 8; typePos + 28 <= data.length; typePos++) {
    if (data[typePos] !== 0x74 || data[typePos + 1] !== 0x65 ||
        data[typePos + 2] !== 0x6e || data[typePos + 3] !== 0x63) continue;
    const start = typePos - 4, size = read32(data, start);
    if (size < 32 || size > 128 || start + size > data.length ||
        data[start + 8] > 1 || ![8, 16].includes(data[start + 15])) continue;
    const kid = data.slice(start + 16, start + 32);
    if (kid.length === 16 && kid.some(Boolean)) return kid;
  }
  return null;
}

export function aborted(signal) {
  if (signal?.aborted) throw errorWith('CANCELED', '已切換影片');
}
function rangeFetch(url, start, bytes, signal, fetchImpl, onProbe, timeoutMs) {
  let phase = 'headers', receivedBytes = 0;
  return withRangeDeadline((localSignal, progress) =>
    rangeFetchOnce(url, start, bytes, localSignal, fetchImpl, (stage, fields) => {
      if (stage === 'range.response') phase = 'body';
      if (stage === 'range.progress') receivedBytes = fields.receivedBytes;
      onProbe(stage, fields);
    }, progress), signal, timeoutMs, { maxDurationMs: timeoutMs * 3 }).catch(error => {
      if (error.code === 'CENC_RANGE_TIMEOUT') onProbe('range.timeout', { readPhase: phase, receivedBytes, timeoutMs });
      throw error;
    });
}
async function rangeFetchOnce(url, start, bytes, signal, fetchImpl, onProbe = () => {}, progress = () => {}) {
  const started = performance.now();
  onProbe('range.request', { offset: start, bytes });
  aborted(signal);
  if (!Number.isSafeInteger(start) || start < 0 || bytes > MAX_MOOV ||
      bytes < 8 || !Number.isSafeInteger(start + bytes))
    throw errorWith('CENC_UNAVAILABLE', 'MP4 metadata 超出限定範圍');
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Range: 'bytes=' + start + '-' + (start + bytes - 1) },
      signal, cache: 'no-store'
    });
  } catch {
    aborted(signal);
    onProbe('range.fetch-failed', { elapsedMs: performance.now() - started });
    // Fetch errors may embed private/signed URLs: only publish a fixed stage.
    throw errorWith('CENC_RANGE_HTTP', 'HTTP Range 連線失敗');
  }
  if (signal?.aborted) {
    await res.body?.cancel().catch(() => {});
    aborted(signal);
  }
  progress();
  onProbe('range.response', { status: res.status, elapsedMs: performance.now() - started,
    ...rangeTiming(res) });
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    // Preserve HTTP failure semantics instead of reporting an HEVC decoder
    // failure or silently downloading the complete encrypted episode.
    const statuses = {
      200: ['CENC_RANGE_UNSUPPORTED', '來源不支援有限的 HTTP Range（HTTP 200）'],
      403: ['CENC_SOURCE_FORBIDDEN', 'CDN 拒絕存取影片（HTTP 403）'],
      416: ['CENC_RANGE_INVALID', '來源拒絕請求的影片範圍（HTTP 416）'],
      429: ['CENC_RATE_LIMITED', '來源限制請求頻率（HTTP 429）']
    };
    const [code, message] = statuses[res.status] ||
      ['CENC_RANGE_HTTP', '來源 HTTP Range 請求失敗（HTTP ' + res.status + '）'];
    throw Object.assign(errorWith(code, message), { status: res.status, retryAfterMs: retryAfterMs(res.headers?.get?.('retry-after')) });
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
  if (!match || Number(match[1]) !== start || Number(match[2]) >= start + bytes ||
      !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= Number(match[2])) {
    await res.body?.cancel();
    throw errorWith('CENC_RANGE_INVALID', 'HTTP Content-Range 不符合要求');
  }
  const length = Number(res.headers.get('content-length'));
  const declaredBytes = Number(match[2]) - start + 1;
  if (res.headers.has('content-length') &&
      (!Number.isSafeInteger(length) || length !== declaredBytes)) {
    await res.body?.cancel().catch(() => {});
    throw errorWith('CENC_RANGE_INVALID', 'HTTP Range Content-Length 不符合宣告');
  }
  const reader = res.body?.getReader();
  if (!reader) throw errorWith('CENC_RANGE_INVALID', 'HTTP Range 回應缺少串流');
  // A metadata Range may stall while the user switches episodes.
  // Do not wait for an unrelated network chunk to arrive to notice abort.
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let count = 0;
  try {
    while (true) {
      let packet;
      try { packet = await reader.read(); }
      catch {
        aborted(signal);
        throw errorWith('CENC_RANGE_HTTP', 'HTTP Range 串流中斷');
      }
      const { done, value } = packet;
      aborted(signal);
      if (done) break;
      count += value.byteLength;
      if (!(value instanceof Uint8Array) || count > declaredBytes)
        throw errorWith('CENC_RANGE_INVALID', 'HTTP Range 超過預算');
      chunks.push(value); progress();
      onProbe('range.progress', { receivedBytes: count, bytes: declaredBytes });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  aborted(signal);
  if (count !== declaredBytes)
    throw errorWith('CENC_RANGE_INVALID', 'HTTP Range 內容不完整');
  const output = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  onProbe('range.complete', {
    bytes: count, elapsedMs: performance.now() - started
  });
  return { data: output, fileSize: Number(match[3]) };
}

export async function probeCencKid(mediaUrl, signal, fetchImpl = fetch, metadata = null,
  onProbe = () => {}, timeoutMs = RANGE_TIMEOUT_MS, recovery = null, byteReader = null) {
  const initialRanges = [];
  const read = async (start, bytes, part) => {
    const once = () => rangeFetch(mediaUrl, start, bytes, signal, fetchImpl,
      (stage, fields) => onProbe(stage, { part, ...fields }), timeoutMs);
    const result = byteReader ? await byteReader.read(start, bytes, part) :
      await (recovery ? recovery.read(once, signal) : once());
    initialRanges.push({ offset: start, data: result.data });
    return result;
  };
  let offset = 0;
  const tried = new Set();
  for (let probe = 0; probe < MAX_RANGES; probe++) {
    aborted(signal);
    if (tried.has(offset)) return null;
    tried.add(offset);
    const { data, fileSize } = await read(offset, HEADER_SIZE, probe === 0 ? 'header' : 'locate-moov');
    const boxes = mp4Boxes(data, offset);
    if (probe === 0 && boxes[0]?.type !== 'ftyp') return null;
    for (const box of boxes) {
      if (box.type !== 'moov') continue;
      if (box.size > MAX_MOOV)
        throw errorWith('CENC_METADATA_LIMIT',
          'MP4 索引超過 8 MiB 有界串流安全限制，不能改用整檔下載');
      const moov = box.complete
        ? data.subarray(box.offset - offset, box.offset - offset + box.size)
        : (await read(box.offset, box.size, 'moov')).data;
      if (metadata) {
        metadata.fragmented = mp4Boxes(moov.subarray(8))
          .some(child => child.type === 'mvex');
        metadata.fileSize = fileSize;
        metadata.initialRanges = initialRanges;
        // Inspect stsd sample entries (including encrypted sinf/frma), not
        // arbitrary "mp4a" text in udta or another nested box.
        const tracks = inspectMp4TrackFormats(moov);
        metadata.hasAac = tracks.hasAac;
        metadata.videoCodec = tracks.videoCodec;
        metadata.hevcCodecString = hevcCodecStringFromMoov(moov);
        metadata.audioTracks = tracks.audioTracks;
        metadata.movieDurationSeconds = movieDurationSeconds(moov);
      }
      return cencKidFromMoov(moov);
    }
    const last = boxes.at(-1);
    if (!last || last.complete || last.type !== 'mdat') return null;
    const jump = last.offset + last.size;
    if (jump >= fileSize || jump <= offset) return null;
    offset = jump;
  }
  return null;
}
