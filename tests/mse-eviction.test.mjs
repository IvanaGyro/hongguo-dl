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

test('300-second playback keeps the last 30 seconds rather than retaining all history', () => {
  // Pure eviction policy test: this does not measure browser heap or GPU RAM.
  for (const t of [60, 120, 180, 240, 300]) {
    const end = evictionEnd(ranges([0, t + 40]), t);
    assert.equal(end, t - 30);
    assert.ok(end < t, 'must not evict the frame currently being presented');
  }
});
test('long playback with discontinuous ranges and seeked times is still bounded', () => {
  const segments = ranges([0, 40], [260, 320], [400, 480]);
  assert.equal(evictionEnd(segments, 300), 270);
  assert.equal(evictionEnd(segments, 450), 420);
  assert.equal(evictionEnd(segments, -1), null);
});
