// SPDX-License-Identifier: GPL-3.0-only
// ISO/IEC 14496-15 HEVC codec parameter string from hvcC decoder record.
// No frame decoding, no media bytes beyond the bounded MP4 moov are inspected.
export function hevcCodecStringFromHvcc(data, sampleEntry = 'hvc1') {
  if (!(data instanceof Uint8Array) || data.length < 23 || data[0] !== 1 ||
      !['hvc1', 'hev1'].includes(sampleEntry)) return null;
  const profileSpace = data[1] >>> 6;
  const profileIdc = data[1] & 31;
  const tier = data[1] & 0x20 ? 'H' : 'L';
  const level = data[12];
  if (!profileIdc || !level) return null;
  const compatibility = (data[2] * 0x1000000 + (data[3] << 16) +
    (data[4] << 8) + data[5]) >>> 0;
  // The 32-bit compatibility flags are represented in reverse bit order.
  let bits = compatibility, reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = ((reversed << 1) | (bits & 1)) >>> 0;
    bits >>>= 1;
  }
  const constraints = [...data.subarray(6, 12)];
  while (constraints.length && constraints.at(-1) === 0) constraints.pop();
  const space = profileSpace ? 'ABC'[profileSpace - 1] : '';
  const suffix = constraints.map(n => '.' + n.toString(16).toUpperCase().padStart(2, '0')).join('');
  return sampleEntry + '.' + space + profileIdc + '.' +
    reversed.toString(16).toUpperCase() + '.' + tier + level + suffix;
}
