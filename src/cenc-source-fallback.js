// SPDX-License-Identifier: GPL-3.0-only
// HTTP access/network failures concern a candidate, not necessarily all
// official renditions. Rotate only across distinct alternatives already
// supplied by /api/source at the same codec and quality. There is no retry
// on 429 or decoder/MSE failures; signed URLs/keys never enter logs.
import { candidateRenditions, codecId, qualityId } from './source-options.js';

export function isRecoverableMediaSourceError(code) {
  // Whole-file ByteVC2 transport errors are normalized to HTTP_403 by
  // playbackFailureMessage(), unlike streaming CENC's MEDIA_SOURCE_FORBIDDEN.
  // Rotate this exact refusal across already advertised same-tier CDN URLs.
  // Do not rotate HTTP_429, codec errors, or cancelled requests.
  return ['CENC_SOURCE_FORBIDDEN', 'MEDIA_SOURCE_FORBIDDEN', 'HTTP_403', 'CENC_RANGE_HTTP',
    'CENC_RANGE_TIMEOUT', 'CENC_SOURCE_SLOW', 'CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED', 'MEDIA_HTTP'].includes(code);
}

export function canTryNextCencSource({
  code, variants, variantsVid, episodeVid, tried, quality = 'auto',
  codec = 'auto', triedUrls = null, tier = null
}) {
  if (!isRecoverableMediaSourceError(code) ||
      !Array.isArray(variants) || variantsVid !== episodeVid ||
      !Number.isSafeInteger(tried) || tried < 1) return false;
  if (triedUrls && tier) return sameTierPlaybackCandidates(variants, { quality, codec }, tier)
    .some(source => !triedUrls.has(source.url));
  const options = candidateRenditions(variants, { quality, codec });
  const selected = options[0];
  if (!selected || codecId(selected.codec) !== 'hevc' ||
      !selected.contentKey || !selected.url) return false;
  const selectedQuality = qualityId(selected);
  const sameTier = options.filter(variant =>
    codecId(variant.codec) === 'hevc' &&
    qualityId(variant) === selectedQuality &&
    !!variant.contentKey && !!variant.url);
  // The main player currently indexes the complete candidateRenditions array.
  // Only advance while its next attempt still points to a same-tier HEVC item.
  if (tried >= sameTier.length) return false;
  return sameTier[tried] === options[tried] &&
    new Set(sameTier.slice(0, tried + 1).map(v => v.url)).size === tried + 1;
}


// Retry only distinct official HEVC URLs at the original resolution/codec.
export function sameTierHevcCandidates(variants, { quality = 'auto', codec = 'auto' } = {},
  tier = null) {
  if (!tier || tier.codec !== 'hevc' || !tier.quality) return [];
  const seen = new Set();
  return candidateRenditions(variants, { quality, codec }).filter(variant => {
    if (codecId(variant.codec) !== 'hevc' ||
        qualityId(variant) !== tier.quality ||
        !variant.contentKey || !variant.url ||
        seen.has(variant.url)) return false;
    seen.add(variant.url);
    return true;
  });
}

// A locked tier can rotate encrypted H.264/HEVC or ByteVC2 transport failures.
export function sameTierPlaybackCandidates(variants, preferences = {}, tier = null) {
  if (!tier || !['h264', 'hevc', 'bytevc2'].includes(tier.codec) || !tier.quality) return [];
  const seen = new Set();
  return candidateRenditions(variants, preferences).filter(v => {
    if (codecId(v.codec) !== tier.codec || qualityId(v) !== tier.quality ||
        !v.url || seen.has(v.url)) return false;
    seen.add(v.url); return true;
  });
}
