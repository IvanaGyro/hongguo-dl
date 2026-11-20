// SPDX-License-Identifier: GPL-3.0-only
// Fragment index for fragmented MP4: maps presentation time to the byte
// offset of a fragment that starts with a sync sample. Two sources are
// supported: a top-level `sidx` (normally right after `moov`) and a trailing
// `mfra`/`tfra` (located through the final 16-byte `mfro`). Without either,
// native EME passthrough is not used; the WASM demuxer can still scan.
// Pure byte parsing: no I/O, DOM or Worker state.

const u32 = (data, p) => ((data[p] << 24) >>> 0) + (data[p + 1] << 16) + (data[p + 2] << 8) + data[p + 3];
const u64 = (data, p) => u32(data, p) * 2 ** 32 + u32(data, p + 4);
const type = (data, p) => String.fromCharCode(data[p + 4], data[p + 5], data[p + 6], data[p + 7]);
const invalid = what => Object.assign(new Error('Invalid ' + what), { code: 'FMP4_INDEX_INVALID' });

/** Box header at `p` in `data`: { type, size, header } or null when truncated. */
export function boxHeader(data, p = 0) {
  if (p + 8 > data.length) return null;
  let size = u32(data, p), header = 8;
  if (size === 1) {
    if (p + 16 > data.length) return null;
    size = u64(data, p + 8); header = 16;
  }
  if (size !== 0 && size < header) throw invalid('box size');
  return { type: type(data, p), size, header };
}

function children(data, start, end) {
  const out = [];
  for (let p = start; p + 8 <= end;) {
    const box = boxHeader(data, p);
    if (!box) break;
    const size = box.size || end - p;
    if (p + size > end) break;
    out.push({ type: box.type, start: p + box.header, end: p + size });
    p += size;
  }
  return out;
}

/**
 * Parse a complete `sidx` box. `boxOffset` is its absolute file offset.
 * Returns subsegments with absolute offsets and times in seconds.
 */
export function parseSidx(data, boxOffset) {
  const box = boxHeader(data, 0);
  if (!box || box.type !== 'sidx' || data.length < box.size) throw invalid('sidx');
  let p = box.header;
  const version = data[p]; p += 4;
  p += 4; // reference_ID
  const timescale = u32(data, p); p += 4;
  if (!timescale) throw invalid('sidx timescale');
  let earliest, firstOffset;
  if (version === 0) { earliest = u32(data, p); firstOffset = u32(data, p + 4); p += 8; }
  else { earliest = u64(data, p); firstOffset = u64(data, p + 8); p += 16; }
  p += 2; // reserved
  const count = (data[p] << 8) | data[p + 1]; p += 2;
  if (p + count * 12 > box.size) throw invalid('sidx references');
  let offset = boxOffset + box.size + firstOffset, time = earliest;
  const entries = [];
  for (let i = 0; i < count; i++, p += 12) {
    const reference = u32(data, p);
    // A hierarchical sidx (reference_type 1) points to further sidx boxes.
    if (reference >>> 31) return null;
    const size = reference & 0x7fffffff, duration = u32(data, p + 4);
    const sap = Boolean(data[p + 8] & 0x80);
    entries.push({ offset, size, time: time / timescale, duration: duration / timescale, sap });
    offset += size; time += duration;
  }
  return entries.length ? { kind: 'sidx', entries } : null;
}

/** Track ID → media timescale, from a complete `moov` box. */
export function trackTimescales(moov) {
  const result = new Map();
  const top = boxHeader(moov, 0);
  if (!top || top.type !== 'moov') throw invalid('moov');
  for (const trak of children(moov, top.header, Math.min(moov.length, top.size || moov.length))) {
    if (trak.type !== 'trak') continue;
    let trackId = null, timescale = null;
    for (const child of children(moov, trak.start, trak.end)) {
      if (child.type === 'tkhd') {
        const version = moov[child.start];
        trackId = u32(moov, child.start + (version === 1 ? 20 : 12));
      } else if (child.type === 'mdia') {
        for (const media of children(moov, child.start, child.end)) {
          if (media.type !== 'mdhd') continue;
          const version = moov[media.start];
          timescale = u32(moov, media.start + (version === 1 ? 20 : 12));
        }
      }
    }
    if (trackId !== null && timescale) result.set(trackId, timescale);
  }
  return result;
}

/**
 * Parse a complete `mfra` box. Returns per-track random access points in
 * seconds with absolute `moof` offsets.
 */
export function parseMfra(data, timescales) {
  const box = boxHeader(data, 0);
  if (!box || box.type !== 'mfra' || data.length < box.size) throw invalid('mfra');
  const tracks = new Map();
  for (const child of children(data, box.header, box.size)) {
    if (child.type !== 'tfra') continue;
    let p = child.start;
    const version = data[p]; p += 4;
    const trackId = u32(data, p); p += 4;
    const sizes = u32(data, p); p += 4;
    const trafBytes = ((sizes >> 4) & 3) + 1, trunBytes = ((sizes >> 2) & 3) + 1, sampleBytes = (sizes & 3) + 1;
    const count = u32(data, p); p += 4;
    const timescale = timescales.get(trackId);
    if (!timescale) continue;
    const entryBytes = (version === 1 ? 16 : 8) + trafBytes + trunBytes + sampleBytes;
    if (p + count * entryBytes > child.end) throw invalid('tfra entries');
    const points = [];
    for (let i = 0; i < count; i++, p += entryBytes) {
      const time = version === 1 ? u64(data, p) : u32(data, p);
      const offset = version === 1 ? u64(data, p + 8) : u32(data, p + 4);
      points.push({ time: time / timescale, offset });
    }
    if (points.length) tracks.set(trackId, points.sort((a, b) => a.time - b.time));
  }
  return tracks.size ? { kind: 'mfra', tracks } : null;
}

/** Size of the `mfra` box announced by a trailing 16-byte `mfro`, or null. */
export function mfraSizeFromMfro(tail) {
  if (tail?.length !== 16 || type(tail, 0) !== 'mfro' || u32(tail, 0) !== 16) return null;
  const size = u32(tail, 12);
  return size >= 16 ? size : null;
}

/**
 * Byte offset to start reading for a seek to `seconds`: the last fragment
 * that starts with a sync sample at or before that time. For `mfra`, audio
 * and video fragments are interleaved, so the earliest per-track offset
 * covers every track.
 */
export function fragmentStartOffset(index, seconds) {
  const target = Math.max(0, Number(seconds) || 0);
  const pick = points => {
    let chosen = points[0];
    for (const point of points) if (point.time <= target + 1e-6) chosen = point; else break;
    return chosen.offset;
  };
  if (index.kind === 'sidx') {
    const sync = index.entries.filter(entry => entry.sap);
    return pick(sync.length ? sync : index.entries);
  }
  return Math.min(...[...index.tracks.values()].map(pick));
}
