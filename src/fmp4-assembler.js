// SPDX-License-Identifier: GPL-3.0-only
// Reassemble libavformat's arbitrary write_packet byte chunks into complete
// MSE appendable units. Do not assume each AVIO write equals one moof/mdat.
const MAX_BOX = 16 * 1024 * 1024;
const join = parts => {
  const data = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let pos = 0;
  for (const part of parts) { data.set(part, pos); pos += part.length; }
  return data;
};
const fourcc = (bytes, pos) => String.fromCharCode(
  bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
const u32 = (bytes, pos) =>
  (bytes[pos] * 0x1000000 + (bytes[pos + 1] << 16) +
    (bytes[pos + 2] << 8) + bytes[pos + 3]) >>> 0;

/** @param {{onInit: (bytes:Uint8Array)=>Promise<void>,onMedia:(bytes:Uint8Array)=>Promise<void>}} handlers */
export function createFmp4Assembler({ onInit, onMedia }) {
  let pending = new Uint8Array(0), ftyp = null, moof = null, init = false, fragments = 0;
  const push = async chunk => {
    if (!(chunk instanceof Uint8Array) || !chunk.length) return;
    if (pending.length + chunk.length > MAX_BOX)
      throw new Error('fMP4 單一 box 超過 16 MiB 上限');
    pending = join([pending, chunk]);
    while (pending.length >= 8) {
      const size = u32(pending, 0), type = fourcc(pending, 4);
      // Reject size=0 and extended-size boxes until a dedicated test covers them.
      if (size < 8 || size > MAX_BOX)
        throw new Error('fMP4 box 尺寸不受支援');
      if (pending.length < size) break;
      const box = pending.slice(0, size);
      pending = pending.slice(size);
      if (type === 'ftyp') ftyp = box;
      else if (type === 'moov') {
        if (!ftyp || init) throw new Error('fMP4 初始化片段無效');
        init = true;
        await onInit(join([ftyp, box]));
        ftyp = null;
      } else if (type === 'moof') {
        if (!init || moof) throw new Error('fMP4 moof 次序無效');
        moof = box;
      } else if (type === 'mdat') {
        if (!moof) throw new Error('fMP4 mdat 缺少 moof');
        await onMedia(join([moof, box]));
        moof = null;
        fragments++;
      } else if (type === 'free' || type === 'sidx' || type === 'mfra' ||
                 type === 'styp' || type === 'skip') {
        // A compliant MSE stream can omit these optional top-level boxes.
      } else throw new Error('不支援的 fMP4 box: ' + type);
    }
  };
  const finish = () => {
    if (pending.length || moof || !init || !fragments)
      throw new Error('fMP4 輸出尚有不完整的盒狀結構');
    return fragments;
  };
  return { push, finish };
}
