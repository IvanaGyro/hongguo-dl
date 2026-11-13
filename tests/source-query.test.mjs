// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceQueryForPlayback } from '../src/source-options.js';

test('explicit 1080p bypasses the expensive public HTML source probe', () => {
  assert.deepEqual(sourceQueryForPlayback('1080p'),
    { quality: '1080p', codec: 'auto', partial: true });
});

test('auto and unsupported exact quality requests retain full metadata listing', () => {
  for (const quality of ['auto', '720p', '540p', '480p', '360p']) {
    assert.deepEqual(sourceQueryForPlayback(quality),
      { quality: 'auto', codec: 'auto', partial: false });
  }
});
