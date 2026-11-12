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

// A quality tier does not imply a codec. For example Nova episode 30 has
// encrypted HEVC at 1080p, but encrypted ByteVC2/VVC at 720p and below.
export function codecsAtQuality(variants, quality = 'auto') {
  return availableRenditions((variants || []).filter(v =>
    quality === 'auto' || qualityId(v) === quality)).codecs;
}

export function browserCanPlayVariant(variant, canPlayType, canTranscodeBvc2 = false) {
  const codec = codecId(variant?.codec);
  // ByteVC2 is not interchangeable with ISO VVC. A native vvc1 capability
  // says nothing about this proprietary bitstream.
  if (codec === 'bytevc2') return !!canTranscodeBvc2;
  if (!codec) return !variant?.contentKey;
  const codecs = {
    h264: 'video/mp4; codecs="avc1.42E01E"',
    hevc: 'video/mp4; codecs="hvc1"',
    bytevc2: 'video/mp4; codecs="vvc1"'
  };
  return Boolean(canPlayType?.(codecs[codec]));
}

// Return exactly the selected tier if playable; allow a clearly announced
// substitute only when the user has chosen automatic codec selection.
// Explicit codec selection never silently changes to another codec.
export function playbackRendition(variants, preferences = {}, canPlayType, attempt = 0, canTranscodeBvc2 = false) {
  const requestedQuality = preferences.quality || 'auto';
  const requestedCodec = preferences.codec || 'auto';
  const playable = source => browserCanPlayVariant(source, canPlayType, canTranscodeBvc2);
  const exact = candidateRenditions(variants, { quality: requestedQuality, codec: requestedCodec })
    .filter(playable);
  if (exact.length) return { source: exact[Math.max(0, attempt) % exact.length], fallback: false };
  if (requestedQuality === 'auto' || requestedCodec !== 'auto')
    return { source: null, fallback: false };
  const requestedHeight = parseInt(requestedQuality, 10);
  const alternatives = candidateRenditions(variants, { quality: 'auto', codec: 'auto' })
    .filter(playable)
    .sort((a, b) => {
      const aHeight = parseInt(qualityId(a), 10) || 9999;
      const bHeight = parseInt(qualityId(b), 10) || 9999;
      const delta = Math.abs(aHeight - requestedHeight) - Math.abs(bHeight - requestedHeight);
      return delta || bHeight - aHeight;
    });
  return alternatives.length
    ? { source: alternatives[Math.max(0, attempt) % alternatives.length], fallback: true }
    : { source: null, fallback: false };
}
