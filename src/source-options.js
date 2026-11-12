// Player rendition selection uses actual metadata returned by /api/source.
// In particular the 60-episode Nova source exposes 1080p HEVC and several
// lower-resolution ByteVC2 variants; do not infer audio/subtitle/bitrate tracks.
export function codecId(value) {
  const v = String(value || '').toLowerCase();
  if (['h264', 'avc', 'avc1'].includes(v)) return 'h264';
  if (['h265', 'hevc', 'hvc1', 'hev1', 'bytevc1'].includes(v)) return 'hevc';
  if (v === 'bytevc2') return 'bytevc2';
  return '';
}
export function qualityId(variant) {
  const q = String(variant?.quality || '').toLowerCase();
  const match = /(\d{3,4})p/.exec(q);
  if (match) return match[1] + 'p';
  const dimension = Math.min(Number(variant?.width), Number(variant?.height));
  return Number.isFinite(dimension) && dimension >= 200
    ? Math.round(dimension) + 'p' : '';
}
export function availableRenditions(variants) {
  const codecs = new Set(), qualities = new Set();
  for (const variant of variants || []) {
    const codec = codecId(variant.codec);
    const quality = qualityId(variant);
    if (codec) codecs.add(codec);
    if (quality) qualities.add(quality);
  }
  return {
    codecs: [...codecs],
    qualities: [...qualities].sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
  };
}
export function chooseRendition(variants, { quality = 'auto', codec = 'auto' } = {}) {
  if (!Array.isArray(variants) || !variants.length) return null;
  let candidates = variants.filter(v => codec === 'auto' || codecId(v.codec) === codec);
  if (quality !== 'auto') {
    const exact = candidates.filter(v => qualityId(v) === quality);
    // Unknown quality: there is no basis to exclude a single public source.
    candidates = exact.length ? exact : candidates.filter(v => !qualityId(v));
  }
  return candidates.sort((a, b) =>
    (Number.parseInt(qualityId(b) || '0', 10) -
     Number.parseInt(qualityId(a) || '0', 10)) ||
    (['h264', 'hevc', 'bytevc2'].indexOf(codecId(a.codec)) -
     ['h264', 'hevc', 'bytevc2'].indexOf(codecId(b.codec))))[0] || null;
}
