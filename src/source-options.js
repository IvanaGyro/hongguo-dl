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
  const dimension = Math.min(Number(variant?.width), Number(variant?.height));
  // Some upstream 720p requests return a 1920x1080 rendition mislabelled 720p.
  // Allow small tier/dimension differences (e.g. 540p is commonly 1024x576).
  if (match) {
    const labelled = Number(match[1]);
    if (Number.isFinite(dimension) && dimension >= 200 &&
        Math.abs(dimension - labelled) >= 180) return Math.round(dimension) + 'p';
    return match[1] + 'p';
  }
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
export function candidateRenditions(variants, { quality = 'auto', codec = 'auto' } = {}) {
  if (!Array.isArray(variants) || !variants.length) return [];
  let candidates = variants.filter(v => codec === 'auto' || codecId(v.codec) === codec);
  if (quality !== 'auto') {
    const exact = candidates.filter(v => qualityId(v) === quality);
    // Unknown-quality public URLs remain allowed, but a known wrong tier is not.
    candidates = exact.length ? exact : candidates.filter(v => !qualityId(v));
  }
  return candidates.sort((a, b) =>
    (Number.parseInt(qualityId(b) || '0', 10) -
     Number.parseInt(qualityId(a) || '0', 10)) ||
    (['h264', 'hevc', 'bytevc2'].indexOf(codecId(a.codec)) -
     ['h264', 'hevc', 'bytevc2'].indexOf(codecId(b.codec))));
}
export function renditionForAttempt(variants, preferences = {}, attempt = 0) {
  const candidates = candidateRenditions(variants, preferences);
  return candidates.length ? candidates[Math.max(0, attempt) % candidates.length] : null;
}
export function chooseRendition(variants, preferences = {}) {
  return renditionForAttempt(variants, preferences);
}
