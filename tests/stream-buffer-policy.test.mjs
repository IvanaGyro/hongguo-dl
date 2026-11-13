import test from 'node:test';
import assert from 'node:assert/strict';
import { streamBufferPolicy, bufferedAround } from '../src/stream-buffer-policy.js';
test('adaptive MSE lookahead respects bitrate, memory and save-data limits', () => {
  const short = streamBufferPolicy({ fileSize: 19 * 1024 * 1024, durationSeconds: 246 });
  assert(short.ahead > 100 && short.ahead <= 120);
  const high = streamBufferPolicy({ fileSize: 250 * 1024 * 1024, durationSeconds: 100 });
  assert.equal(high.ahead, 30);
  const save = streamBufferPolicy({ saveData: true });
  assert.equal(save.rawPrefetch, false);
  assert.equal(save.cacheBudget, 16 * 1024 * 1024);
});
test('a distant future range does not count as playable headroom at the seek target', () => {
  const ranges = { length: 2, start: i => [0, 150][i], end: i => [40, 200][i] };
  assert.deepEqual(bufferedAround(ranges, 70), { bufferedAhead: 0, bufferedBehind: 0 });
  assert.deepEqual(bufferedAround(ranges, 20), { bufferedAhead: 20, bufferedBehind: 20 });
});
