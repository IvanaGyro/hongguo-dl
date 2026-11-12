// SPDX-License-Identifier: GPL-3.0-only
import { hevcCodecStringFromHvcc } from './hevc-codec.js';

// Inspect MP4 sample descriptions structurally; never string-scan arbitrary
// moov payload for "mp4a", which may appear inside unrelated metadata.
const u32 = (d, p) => (d[p] * 0x1000000 + (d[p + 1] << 16) +
  (d[p + 2] << 8) + d[p + 3]) >>> 0;
const u16 = (d, p) => (d[p] << 8) + d[p + 1];
const fourcc = (d, p) => String.fromCharCode(...d.subarray(p, p + 4));
function boxes(data, begin, end) {
  const result = [];
  for (let pos = begin; pos + 8 <= end;) {
    let size = u32(data, pos), header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = u32(data, pos + 8) * 0x100000000 + u32(data, pos + 12);
      header = 16;
    }
    if (!Number.isSafeInteger(size) || size < header || size > end - pos) break;
    result.push({ type: fourcc(data, pos + 4), start: pos,
      payload: pos + header, end: pos + size });
    pos += size;
  }
  return result;
}
function child(data, parent, type) {
  return boxes(data, parent.payload, parent.end).find(box => box.type === type);
}
function sampleEntries(data, stsd) {
  if (!stsd || stsd.payload + 8 > stsd.end) return [];
  const count = u32(data, stsd.payload + 4);
  return boxes(data, stsd.payload + 8, stsd.end).slice(0, Math.min(count, 32));
}
function formatForSample(data, entry) {
  const encrypted = entry.type === 'enca' || entry.type === 'encv';
  if (!encrypted) return entry.type;
  let childOffset;
  if (entry.type === 'encv') childOffset = entry.start + 86;
  else {
    if (entry.start + 36 > entry.end) return null;
    const version = u16(data, entry.start + 16);
    childOffset = entry.start + (version === 0 ? 36 : version === 1 ? 52 : 72);
  }
  if (childOffset > entry.end) return null;
  const sinf = boxes(data, childOffset, entry.end).find(box => box.type === 'sinf');
  const frma = sinf && child(data, sinf, 'frma');
  return frma && frma.payload + 4 <= frma.end
    ? fourcc(data, frma.payload) : null;
}

// Read the actual hvcC configuration from an HEVC sample entry instead of
// guessing a generic "hvc1" codec. The C remuxer's output uses clear HEVC
// samples (hvc1), regardless of whether the input encrypted entry was encv.
function parseHevcCodecFromMoov(moov, requireClear) {
  if (!(moov instanceof Uint8Array) || moov.length < 8 ||
      u32(moov, 0) !== moov.length || fourcc(moov, 4) !== 'moov') return null;
  for (const trak of boxes(moov, 8, moov.length).filter(box => box.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia'), minf = mdia && child(moov, mdia, 'minf'),
      stbl = minf && child(moov, minf, 'stbl'),
      stsd = stbl && child(moov, stbl, 'stsd');
    for (const entry of sampleEntries(moov, stsd)) {
      const originalFormat = formatForSample(moov, entry);
      if (!['hvc1', 'hev1'].includes(originalFormat)) continue;
      // For a clear fMP4 init, MIME must match the actual sample entry tag.
      // An encrypted encv entry cannot itself be used as a clear init.
      if (requireClear && entry.type !== originalFormat) continue;
      if (entry.start + 86 > entry.end) continue;
      const hvcc = boxes(moov, entry.start + 86, entry.end)
        .find(box => box.type === 'hvcC');
      if (!hvcc) continue;
      const sampleEntry = requireClear ? entry.type : 'hvc1';
      const codec = hevcCodecStringFromHvcc(
        moov.subarray(hvcc.payload, hvcc.end), sampleEntry);
      if (codec) return codec;
    }
  }
  return null;
}

// The C remuxer clears encv and uses an hvc1 sample description on output.
export function hevcCodecStringFromMoov(moov) {
  return parseHevcCodecFromMoov(moov, false);
}

// After remux, inspect the *actual* clear output tag and hvcC bytes rather
// than assuming hev1 and hvc1 are interchangeable in SourceBuffer MIME.
export function hevcCodecStringFromClearMoov(moov) {
  return parseHevcCodecFromMoov(moov, true);
}

export function inspectMp4TrackFormats(moov) {
  if (!(moov instanceof Uint8Array) || moov.length < 8 ||
      u32(moov, 0) !== moov.length || fourcc(moov, 4) !== 'moov')
    return { hasAac: false, videoCodec: null, videoTracks: 0, audioTracks: 0 };
  let hasAac = false, videoCodec = null, videoTracks = 0, audioTracks = 0;
  for (const trak of boxes(moov, 8, moov.length).filter(box => box.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia'), minf = mdia && child(moov, mdia, 'minf'),
      stbl = minf && child(moov, minf, 'stbl'),
      stsd = stbl && child(moov, stbl, 'stsd');
    for (const entry of sampleEntries(moov, stsd)) {
      const format = formatForSample(moov, entry);
      if (['hvc1', 'hev1', 'avc1', 'avc3'].includes(format)) {
        if (!videoCodec) videoCodec = format;
        videoTracks++;
      } else if (format === 'mp4a') {
        hasAac = true;
        audioTracks++;
      } else if (['ac-3', 'ec-3', 'alac', 'Opus', 'fLaC'].includes(format)) {
        audioTracks++;
      }
    }
  }
  return { hasAac, videoCodec, videoTracks, audioTracks };
}

// Movie header gives a finite seekable timeline even though an empty_moov
// streaming output cannot know its final duration until endOfStream.
export function movieDurationSeconds(moov) {
  if (!(moov instanceof Uint8Array) || moov.length < 32 ||
      u32(moov, 0) !== moov.length || fourcc(moov, 4) !== 'moov') return null;
  const mvhd = boxes(moov, 8, moov.length).find(box => box.type === 'mvhd');
  if (!mvhd) return null;
  const version = moov[mvhd.payload];
  let timescale = 0, duration = 0;
  if (version === 0 && mvhd.payload + 20 <= mvhd.end) {
    timescale = u32(moov, mvhd.payload + 12);
    duration = u32(moov, mvhd.payload + 16);
    if (duration === 0xffffffff) return null;
  } else if (version === 1 && mvhd.payload + 32 <= mvhd.end) {
    timescale = u32(moov, mvhd.payload + 20);
    const hi = u32(moov, mvhd.payload + 24);
    duration = hi * 0x100000000 + u32(moov, mvhd.payload + 28);
    if (hi === 0xffffffff && u32(moov, mvhd.payload + 28) === 0xffffffff)
      return null;
  } else return null;
  const seconds = duration / timescale;
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 24 * 3600 ? seconds : null;
}
