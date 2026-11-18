// SPDX-License-Identifier: GPL-3.0-only
// From one fragmented MP4 with a top-level sidx, derive the two other index
// layouts the native EME route handles:
//   <out>/fmp4-mfra.mp4   sidx hidden (renamed `free`), trailing mfra/tfra/mfro
//   <out>/fmp4-none.mp4   sidx hidden, no index at all
// Offsets are unchanged, so the media bytes stay valid for MSE.
// Usage: node scripts/derive-fmp4-index-fixtures.mjs input.mp4 outdir
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error('usage: derive-fmp4-index-fixtures.mjs input.mp4 outdir');
const file = new Uint8Array(readFileSync(input));
const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
const type = p => String.fromCharCode(...file.subarray(p + 4, p + 8));
const boxesIn = (start, end) => {
  const out = [];
  for (let p = start; p + 8 <= end;) {
    let size = view.getUint32(p), header = 8;
    if (size === 1) { size = Number(view.getBigUint64(p + 8)); header = 16; }
    if (size === 0) size = end - p;
    out.push({ type: type(p), offset: p, start: p + header, end: p + size });
    p += size;
  }
  return out;
};
const top = boxesIn(0, file.length);
const sidx = top.find(box => box.type === 'sidx');
if (!sidx) throw new Error('input has no top-level sidx');
const hidden = file.slice();
hidden.set([0x66, 0x72, 0x65, 0x65], sidx.offset + 4); // 'free'

// tfra points: each moof's per-track decode time (tfdt) and offset.
const timesByTrack = new Map();
for (const moof of top.filter(box => box.type === 'moof')) {
  for (const traf of boxesIn(moof.start, moof.end).filter(box => box.type === 'traf')) {
    const children = boxesIn(traf.start, traf.end);
    const tfhd = children.find(box => box.type === 'tfhd');
    const tfdt = children.find(box => box.type === 'tfdt');
    if (!tfhd || !tfdt) throw new Error('moof needs tfhd and tfdt');
    const trackId = view.getUint32(tfhd.start + 4);
    const time = file[tfdt.start] === 1 ? Number(view.getBigUint64(tfdt.start + 4)) : view.getUint32(tfdt.start + 4);
    if (!timesByTrack.has(trackId)) timesByTrack.set(trackId, []);
    timesByTrack.get(trackId).push({ time, offset: moof.offset });
  }
}
const u32 = value => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value); return b; };
const u64 = value => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value)); return b; };
const concat = parts => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const box = (name, parts) => {
  const body = concat(parts);
  return concat([u32(8 + body.length), new TextEncoder().encode(name), body]);
};
const tfras = [...timesByTrack].map(([trackId, points]) => box('tfra', [
  Uint8Array.of(1, 0, 0, 0), u32(trackId), u32(0), u32(points.length),
  ...points.map(point => concat([u64(point.time), u64(point.offset), Uint8Array.of(1, 1, 1)]))
]));
const mfraSize = 8 + tfras.reduce((n, t) => n + t.length, 0) + 16;
const mfra = box('mfra', [...tfras, box('mfro', [Uint8Array.of(0, 0, 0, 0), u32(mfraSize)])]);
writeFileSync(join(out, 'fmp4-none.mp4'), hidden);
writeFileSync(join(out, 'fmp4-mfra.mp4'), concat([hidden, mfra]));
console.log('Derived fmp4 index fixtures', JSON.stringify({
  tracks: timesByTrack.size, fragments: top.filter(box => box.type === 'moof').length
}));
