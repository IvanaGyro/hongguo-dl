import test from 'node:test';
import assert from 'node:assert/strict';
import { timeIsBuffered, clampStreamSeek } from '../src/cenc-seek.js';

const ranges = (...pairs) => ({
  length: pairs.length,
  start: i => pairs[i][0],
  end: i => pairs[i][1]
});

test('CENC seek only restarts for unbuffered timestamps', () => {
  const b = ranges([1, 10], [16, 24]);
  assert.equal(timeIsBuffered(b, 3), true);
  assert.equal(timeIsBuffered(b, 18), true);
  assert.equal(timeIsBuffered(b, 13), false);
  assert.equal(timeIsBuffered(b, 90), false);
  assert.equal(timeIsBuffered(ranges(), 4), false);
  assert.equal(timeIsBuffered(b, NaN), false);
});
test('requested resume time stays inside the known movie duration', () => {
  assert.equal(clampStreamSeek(100, 120), 100);
  assert.equal(clampStreamSeek(120, 120), 119.7);
  assert.equal(clampStreamSeek(10, 5), 4.7);
  assert.equal(clampStreamSeek(-1, 120), null);
  assert.equal(clampStreamSeek(0, 120), 0);
});
