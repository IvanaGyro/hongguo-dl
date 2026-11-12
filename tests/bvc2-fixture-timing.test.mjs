import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAvTimeline } from '../scripts/bvc2-fixture-timing.mjs';

test('matched AAC and video timeline passes with measured skew', () => {
  const metrics = checkAvTimeline(
    { start_time: '0.000', duration: '60.000' },
    { start_time: '0.023', duration: '60.019' });
  assert.equal(metrics.checked, true);
  assert.equal(metrics.startSkewSeconds, 0.023);
  assert.equal(metrics.endSkewSeconds, 0.042);
});

test('large AAC/video start mismatch fails rather than claiming sync', () => {
  assert.throws(() => checkAvTimeline(
    { start_time: '0', duration: '60' },
    { start_time: '4', duration: '60' }), /timeline mismatch/);
});

test('large AAC/video end mismatch fails rather than claiming sync', () => {
  assert.throws(() => checkAvTimeline(
    { start_time: '0', duration: '60' },
    { start_time: '0', duration: '55' }), /timeline mismatch/);
});

test('missing timing metadata is not silently declared verified', () => {
  assert.throws(() => checkAvTimeline(
    { start_time: '0', duration: 'N/A' },
    { start_time: '0', duration: '60' }), /Cannot validate/);
});

test('video-only fixture explicitly skips A/V timeline assertion', () => {
  assert.deepEqual(checkAvTimeline(
    { start_time: '0', duration: '60' }, null),
    { checked: false, reason: 'no-audio-track' });
});
