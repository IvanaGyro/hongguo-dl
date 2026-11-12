// SPDX-License-Identifier: GPL-3.0-only
// Verify the clear fMP4 initialization segment before giving it to MSE.
// The Worker publishes a complete ftyp+moov, with a 16 MiB assembler bound.
import { hevcCodecStringFromClearMoov } from './mp4-track-formats.js';

const MAX_INIT_BYTES = 16 * 1024 * 1024;
const u32 = (d, p) => (d[p] * 0x1000000 + (d[p + 1] << 16) +
  (d[p + 2] << 8) + d[p + 3]) >>> 0;
const fourcc = (d, p) => String.fromCharCode(...d.subarray(p, p + 4));
const mismatch = () => Object.assign(
  new Error('HEVC 初始化片段與 MSE codec 描述不一致'),
  { code: 'HEVC_INIT_MISMATCH' });

export function assertHevcInitCodecMatches(bytes, expectedCodec) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 ||
      bytes.length > MAX_INIT_BYTES || typeof expectedCodec !== 'string')
    throw mismatch();
  let pos = 0, ftyp = false, moov = null;
  while (pos + 8 <= bytes.length) {
    const size = u32(bytes, pos), type = fourcc(bytes, pos + 4);
    if (size < 8 || size > bytes.length - pos) throw mismatch();
    if (type === 'ftyp' && !ftyp && !moov) ftyp = true;
    else if (type === 'moov' && ftyp && !moov)
      moov = bytes.subarray(pos, pos + size);
    else throw mismatch();
    pos += size;
  }
  if (pos !== bytes.length || !ftyp || !moov ||
      hevcCodecStringFromClearMoov(moov) !== expectedCodec) throw mismatch();
  return true;
}
