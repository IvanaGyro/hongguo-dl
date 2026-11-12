import test from 'node:test';
import assert from 'node:assert/strict';
import { evictionEnd } from '../src/mse-eviction.js';
const ranges = (...pairs) => ({
  length: pairs.length,
  start: i => pairs[i][0],
  end: i => pairs[i][1]
});

test('evicts behind playhead while preserving a 30s rewind window', () => {
  assert.equal(evictionEnd(ranges([0, 140]), 100), 70);
  assert.equal(evictionEnd(ranges([40, 140]), 100), 70);
  assert.equal(evictionEnd(ranges([60, 140]), 100), 70);
});
test('does not evict while near start or with too little old buffer', () => {
  assert.equal(evictionEnd(ranges([0, 60]), 34), null);
  assert.equal(evictionEnd(ranges([0, 60]), 37), null);
  assert.equal(evictionEnd(ranges(), 100), null);
  assert.equal(evictionEnd(ranges([0, 60]), NaN), null);
});
