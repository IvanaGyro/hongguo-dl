// SPDX-License-Identifier: GPL-3.0-only
// OFFLINE TEST ONLY: standard VVC pictures wrapped in bvc2/bv2C framing.
// This checks the BVC2 container/decoder wiring, not proprietary BTY2 conformance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const box = (type, data) => {
  const out = Buffer.alloc(8 + data.length);
  out.writeUInt32BE(out.length); out.write(type, 4, 4, 'ascii'); data.copy(out, 8); return out;
};
export function syntheticBvc2(vvcPath, { configurationRecord = false } = {}) {
  const raw = readFileSync(vvcPath);
  const annexb = execFileSync(process.env.VVC_FFMPEG || 'ffmpeg', ['-nostdin', '-v', 'error', '-i', vvcPath,
    '-map', '0:v', '-c', 'copy', '-bsf:v', 'vvc_mp4toannexb', '-f', 'vvc', '-'], { maxBuffer: 32 * 1024 * 1024 });
  // Retain the first copy of each parameter NAL. Include VPS/SPS/PPS and
  // optional OPI/DCI. ByteVC2's CBS reads 4-byte length-prefixed config NALs.
  const starts = [];
  for (let i = 0; i < annexb.length - 3; i++) {
    if (annexb[i] === 0 && annexb[i + 1] === 0 && annexb[i + 2] === 1) {
      starts.push({ prefix: i > 0 && annexb[i - 1] === 0 ? i - 1 : i, data: i + 3 }); i += 2;
    }
  }
  const parameters = [], seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const nal = annexb.subarray(starts[i].data, starts[i + 1]?.prefix ?? annexb.length);
    const type = (nal[1] >> 3) & 31;
    if (![12, 13, 14, 15, 16].includes(type) || seen.has(type)) continue;
    seen.add(type); const length = Buffer.alloc(4); length.writeUInt32BE(nal.length);
    parameters.push(length, nal);
  }
  assert(seen.has(15) && seen.has(16), 'SPS/PPS required');
  let config = Buffer.concat(parameters);
  if (configurationRecord) {
    const header = Buffer.alloc(19); header[0] = 1; header[1] = 7; header[18] = parameters.length / 2;
    const arrays = [];
    for (let i = 0; i < parameters.length; i += 2) {
      const nal = parameters[i + 1];
      const array = Buffer.alloc(5); array[0] = 0x80 | ((nal[1] >> 3) & 31);
      array.writeUInt16BE(1, 1); array.writeUInt16BE(nal.length, 3);
      arrays.push(array, nal);
    }
    config = Buffer.concat([header, ...arrays]);
  }
  let converted = false;
  const rewrite = data => {
    const out = [];
    for (let offset = 0; offset + 8 <= data.length;) {
      const size = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
      assert(size >= 8 && offset + size <= data.length);
      const b = data.subarray(offset + 8, offset + size);
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) out.push(box(type, rewrite(b)));
      else if (type === 'stsd') out.push(box(type, Buffer.concat([b.subarray(0, 8), rewrite(b.subarray(8))])));
      else if (type === 'vvc1' || type === 'vvi1') {
        converted = true;
        out.push(box('bvc2', Buffer.concat([b.subarray(0, 78), rewrite(b.subarray(78))])));
      } else if (type === 'vvcC') out.push(box('bv2C', config));
      else out.push(data.subarray(offset, offset + size));
      offset += size;
    }
    return Buffer.concat(out);
  };
  const top = [], moovs = [];
  for (let offset = 0; offset < raw.length;) {
    const size = raw.readUInt32BE(offset), type = raw.toString('ascii', offset + 4, offset + 8);
    assert(size >= 8 && offset + size <= raw.length);
    const b = raw.subarray(offset, offset + size);
    if (type === 'moov') {
      moovs.push(box('moov', rewrite(b.subarray(8))));
      // Keep media packet byte offsets unchanged; append rebuilt moov at EOF.
      const free = Buffer.from(b); free.write('free', 4, 4); top.push(free);
    } else top.push(b);
    offset += size;
  }
  assert(converted && moovs.length === 1);
  return Buffer.concat([...top, ...moovs]);
}
