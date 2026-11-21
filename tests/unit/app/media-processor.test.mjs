// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaProcessor } from '../../../src/media-processor.js';
import { KEY, URL_A, faststart, cdn } from '../helpers/whole-file-media.mjs';

test('a retained Worker stops processing and read-ahead until its next owner', () => {
  const processor = createMediaProcessor({ bridge: 'cenc', fetchImpl: cdn(faststart).fetchImpl });
  processor.need({ source: { url: URL_A, bridge: 'cenc', key: KEY }, output: 'playable-media',
    codec: 'h264', processing: true, playback: { paused: false, bufferedAheadSeconds: 4, bufferTargetSeconds: 30 } });
  processor.keepSourceOnly();
  assert.equal(processor.demand.output, 'playable-media', 'The demand, and so the source and cache, are kept');
  assert.equal(processor.demand.processing, false);
  assert.deepEqual(processor.demand.playback, { paused: true, bufferedAheadSeconds: 0, bufferTargetSeconds: 0 });
  processor.close({ discard: true });
});
