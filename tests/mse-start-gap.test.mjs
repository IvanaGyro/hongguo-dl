import test from 'node:test';
import assert from 'node:assert/strict';
import { alignInitialCencBufferedStart } from '../src/mse-start-gap.js';

function videoWithRange(start, end, overrides = {}) {
  return {
    readyState: 1, currentTime: 0, seeking: false,
    buffered: { length: 1, start: () => start, end: () => end },
    ...overrides
  };
}

test('real HEVC initial 0.16s MSE gap seeks into first buffered frame', () => {
  const video = videoWithRange(0.16, 2.97);
  assert.equal(alignInitialCencBufferedStart(video, 0), true);
  assert(Math.abs(video.currentTime - 0.2) < 1e-8);
});

test('zero-start buffered source needs no position correction', () => {
  const video = videoWithRange(0, 3);
  assert.equal(alignInitialCencBufferedStart(video), false);
  assert.equal(video.currentTime, 0);
});

test('never alter user seeks, saved resumes, nonzero clocks or active seek', () => {
  for (const [video, startSeconds] of [
    [videoWithRange(0.16, 3), 3],
    [videoWithRange(0.16, 3, { currentTime: 1.2 }), 0],
    [videoWithRange(0.16, 3, { currentTime: 0.03 }), 0],
    [videoWithRange(0.16, 3, { seeking: true }), 0],
    [videoWithRange(0.16, 3, { readyState: 0 }), 0]
  ]) {
    const before = video.currentTime;
    assert.equal(alignInitialCencBufferedStart(video, startSeconds), false);
    assert.equal(video.currentTime, before);
  }
});

test('never hide a large timeline defect or a too-short/no media range', () => {
  for (const video of [
    videoWithRange(0.7, 5),
    videoWithRange(0.16, 0.17),
    videoWithRange(0.16, 0.16),
    videoWithRange(NaN, 3),
    videoWithRange(0.16, 3, { buffered: { length: 0 } }),
  ]) {
    assert.equal(alignInitialCencBufferedStart(video), false);
    assert.equal(video.currentTime, 0);
  }
});

test('a detached buffered range or nonseekable media element is safe', () => {
  const detached = videoWithRange(0.16, 3, { buffered: {
    length: 1, start: () => { throw new Error('Detached'); }, end: () => 3
  } });
  assert.equal(alignInitialCencBufferedStart(detached), false);
  const nonseekable = videoWithRange(0.16, 3);
  Object.defineProperty(nonseekable, 'currentTime', {
    get() { return 0; }, set() { throw new Error('Not seekable'); }
  });
  assert.equal(alignInitialCencBufferedStart(nonseekable), false);
});
