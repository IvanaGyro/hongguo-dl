import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRendition } from '../src/source-options.js';
test('quality survives episode changes while vanished codecs and quality tiers do not', () => {
  const variants = [{ quality: '720p', codec: 'bytevc2' }, { quality: '1080p', codec: 'hevc' }];
  assert.deepEqual(reconcileRendition(variants, { quality: '720p', codec: 'hevc' }), { quality: '720p', codec: 'bytevc2' });
  assert.deepEqual(reconcileRendition(variants, { quality: '540p', codec: 'hevc' }), { quality: 'auto', codec: 'auto' });
  assert.deepEqual(reconcileRendition(variants, { quality: 'auto', codec: 'hevc' }), { quality: 'auto', codec: 'auto' });
});
