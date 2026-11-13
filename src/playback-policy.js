// SPDX-License-Identifier: GPL-3.0-only
// HEVC CENC MP4 must not silently downgrade to whole-file playback.
import { codecId } from './source-options.js';
import { isHlsUrl } from './logic.js';

export function blockHevcFullFileFallback(source) {
  return codecId(source?.codec) === 'hevc' &&
    Boolean(source?.contentKey) && !isHlsUrl(source?.url || '');
}
