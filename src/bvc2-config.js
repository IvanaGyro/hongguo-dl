// SPDX-License-Identifier: GPL-3.0-only
// Adapt version-1 bv2C parameter arrays to the pinned decoder's four-byte
// length-prefixed configuration. Keep every media/sample/CENC byte offset.
const invalid = () => Object.assign(new Error('不支援或損壞的 ByteVC2 設定資料'), { code: 'BVC2_CONFIG_INVALID' });
const u32 = (data, p) => new DataView(data.buffer, data.byteOffset + p, 4).getUint32(0);
const put32 = (data, p, value) => new DataView(data.buffer, data.byteOffset + p, 4).setUint32(0, value);
const type = (data, p) => String.fromCharCode(...data.subarray(p + 4, p + 8));
export function bvc2ParameterNals(data) {
  if (!(data instanceof Uint8Array) || data.length > 8 * 1024 * 1024) throw invalid();
  // Existing in-band/Annex-B-style configurations remain byte-identical.
  if (data[0] !== 1) return null;
  if (data.length < 19 || (data[1] & 3) !== 3) throw invalid();
  let p = 19, count = 0;
  const arrays = data[18], nals = [];
  if (!arrays || arrays > 32) throw invalid();
  for (let array = 0; array < arrays; array++) {
    if (p + 3 > data.length) throw invalid();
    const nalType = data[p++] & 31;
    const number = data[p++] * 256 + data[p++];
    if (!number || count + number > 1024) throw invalid();
    for (let i = 0; i < number; i++) {
      if (p + 2 > data.length) throw invalid();
      const size = data[p++] * 256 + data[p++];
      if (size < 2 || p + size > data.length || ((data[p + 1] >> 3) & 31) !== nalType) throw invalid();
      nals.push(data.subarray(p, p + size)); p += size; count++;
    }
  }
  if (p !== data.length) throw invalid();
  const output = new Uint8Array(nals.reduce((sum, nal) => sum + nal.length + 4, 0));
  p = 0;
  for (const nal of nals) { put32(output, p, nal.length); output.set(nal, p + 4); p += 4 + nal.length; }
  return output;
}
export function normalizeBvc2Config(input, { inPlace = false } = {}) {
  if (!(input instanceof Uint8Array)) throw invalid();
  let output = input, changed = 0;
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  function walk(start, end, depth = 0) {
    if (depth > 12) throw invalid();
    for (let p = start; p + 8 <= end;) {
      const size = u32(output, p), tag = type(output, p);
      if (size < 8) break;
      const complete = p + size <= end, limit = Math.min(end, p + size);
      if (tag === 'bv2C' && complete) {
        const normalized = bvc2ParameterNals(output.subarray(p + 8, limit));
        if (normalized) {
          const newSize = normalized.length + 8, gap = size - newSize;
          if (gap < 0) throw invalid();
          if (output === input && !inPlace) output = new Uint8Array(input);
          put32(output, p, newSize); output.set(normalized, p + 8);
          if (gap >= 8) {
            put32(output, p + newSize, gap);
            output.set([102, 114, 101, 101], p + newSize + 4);
            output.fill(0, p + newSize + 8, p + size);
          } else if (gap) {
            // Preserve following child boxes, padding only at parent end.
            output.copyWithin(p + newSize, p + size, end);
            output.fill(0, end - gap, end);
          }
          changed++;
          p += gap >= 8 ? size : newSize;
          continue;
        }
      }
      if (containers.has(tag)) walk(p + 8, limit, depth + 1);
      else if (tag === 'stsd' && p + 16 <= limit) walk(p + 16, limit, depth + 1);
      else if (['encv', 'bvc2'].includes(tag) && p + 86 <= limit) walk(p + 86, limit, depth + 1);
      // Partial metadata probes may contain the complete config near the
      // start of an incomplete moov. Never inspect media payload as boxes.
      if (!complete) break;
      p += size;
    }
  }
  walk(0, input.length);
  return { bytes: output, changed };
}
