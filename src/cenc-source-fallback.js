// SPDX-License-Identifier: GPL-3.0-only
// An HTTP 403 is a *candidate* access refusal, not a reason to abandon all
// official HEVC renditions. Rotate only across distinct alternatives already
// supplied by /api/source at the same codec and quality. There is no retry
// on 429 or decoder/MSE failures; signed URLs/keys never enter logs.
import { candidateRenditions, codecId, qualityId } from './source-options.js';

export function canTryNextCencSource({
  code, variants, variantsVid, episodeVid, tried, quality = 'auto',
  codec = 'auto'
}) {
  if (!['CENC_SOURCE_FORBIDDEN', 'MEDIA_SOURCE_FORBIDDEN'].includes(code) ||
      !Array.isArray(variants) || variantsVid !== episodeVid ||
      !Number.isSafeInteger(tried) || tried < 1) return false;
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
