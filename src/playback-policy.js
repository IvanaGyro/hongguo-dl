// SPDX-License-Identifier: GPL-3.0-only
// HEVC CENC MP4 must not silently downgrade to whole-file playback.
import { codecId } from './source-options.js';
import { isHlsUrl } from './logic.js';

// Incremental decoding is the normal playback path. Keep whole-file mode as
// an explicit escape hatch, never an automatic multi-minute startup fallback.
export function bvc2PlaybackMode(search = '') {
  return new URLSearchParams(search).get('bvc2_stream') === 'whole-file'
    ? 'whole-file' : 'stream';
}

export function blockHevcFullFileFallback(source) {
  return codecId(source?.codec) === 'hevc' &&
    Boolean(source?.contentKey) && !isHlsUrl(source?.url || '');
}

// A diagnostic URL changes preliminary admission only, never native decoding,
// actual-hvcC validation, source access, or the whole-file fallback policy.
export function hevcMetadataProbeEnabled(search = '') {
  return new URLSearchParams(search).get('hevc_probe') === 'actual';
}
