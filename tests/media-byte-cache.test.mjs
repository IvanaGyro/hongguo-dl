import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaByteCache } from '../src/media-byte-cache.js';
const PAGE = 65536;
test('sparse cache merges overlapping bytes but never invents holes', () => {
  const cache = createMediaByteCache({ fileSize: PAGE * 10, budget: PAGE * 3 });
  cache.write(10, new Uint8Array([1, 2, 3]));
  cache.write(12, new Uint8Array([4, 5]));
  assert.deepEqual([...cache.read(10, 4)], [1, 2, 4, 5]);
  assert.equal(cache.read(9, 5), null);
  assert.equal(cache.firstMissing(10, 15), 14);
  assert.deepEqual(cache.stats.byteRanges, [[10, 14]]);
});
test('bounded LRU retains pinned MP4 index and recently read media', () => {
  const cache = createMediaByteCache({ fileSize: PAGE * 10, budget: PAGE * 3 });
  const bytes = new Uint8Array(PAGE).fill(42);
  cache.write(0, bytes, true); cache.write(PAGE, bytes); cache.write(2 * PAGE, bytes);
  cache.read(PAGE, 1); cache.write(3 * PAGE, bytes);
  assert.equal(cache.read(2 * PAGE, 1), null);
  assert.deepEqual([...cache.read(0, 1)], [42]);
  assert.deepEqual([...cache.read(PAGE, 1)], [42]);
  assert.equal(cache.stats.allocatedBytes, PAGE * 3);
  assert.equal(cache.stats.evictedBytes, PAGE);
});
