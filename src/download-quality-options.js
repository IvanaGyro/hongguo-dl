// SPDX-License-Identifier: GPL-3.0-only
import { qualityId } from './source-options.js';

export function initialDownloadQualityEpisode(episodes = []) {
  return episodes.find(ep => ep.available === false) || episodes[0] || null;
}
export function downloadQualityOptions(variants = []) {
  return [...new Set(variants.map(qualityId).filter(q => /^\d{3,4}p$/.test(q)))]
    .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
}
export function hasExactDownloadQuality(variants, quality = 'auto') {
  return quality === 'auto' || variants.some(v => qualityId(v) === quality);
}
