// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { allowsWholeFileFallback, isProcessingFailure } from '../../../src/fallback-policy.js';

test('the fallback order moves down only for processing failures', () => {
  for (const code of ['CENC_REMUX_FAILED', 'BVC2_TRANSCODE_FAILED', 'CENC_UNAVAILABLE',
    'HEVC_INIT_UNSUPPORTED', 'EME_UNAVAILABLE', 'FMP4_INDEX_UNAVAILABLE'])
    assert.equal(allowsWholeFileFallback({ code }), true, code);
  for (const code of ['CENC_SOURCE_FORBIDDEN', 'CENC_RATE_LIMITED', 'CENC_RANGE_HTTP',
    'CENC_RANGE_TIMEOUT', 'CENC_RANGE_UNSUPPORTED', 'CENC_SOURCE_SLOW', 'MEDIA_SOURCE_FORBIDDEN',
    'CANCELED', 'PLAYBACK_STEP_LIMIT', 'CENC_METADATA_LIMIT', 'MEMORY_LIMIT'])
    assert.equal(allowsWholeFileFallback({ code }), false, code);
  assert.equal(allowsWholeFileFallback(null), true, 'An unavailable route without an error falls back');
  assert.equal(isProcessingFailure('CENC_SOURCE_FORBIDDEN'), false);
});
