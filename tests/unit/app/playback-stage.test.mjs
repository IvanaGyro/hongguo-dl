import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackStage } from '../../../src/playback-stage.js';

test('beta text distinguishes registration, source lists, CDN candidates and actual metadata byte reads', () => {
  assert.match(playbackStage('source.wait', { tasks: [{ phase: 'device-register', attempt: 3 }] }).message, /裝置.*第 3\/20 次/);
  assert.match(playbackStage('source.wait', { tasks: [{ phase: 'source-app', attempt: 4 }] }).message, /畫質候選.*第 4\/20 次/);
  assert.match(playbackStage('cdn.selected', { candidate: 2, attempt: 5 }).message, /CDN #2.*第 5\/20 次/);
  assert.match(playbackStage('range.retry', { part: 'moov', offset: 28, bytes: 90668, candidate: 2, attempt: 6, status: 502 }).message,
    /moov.*bytes 28–90695.*HTTP 502.*CDN #2.*第 6\/20 次/);
});
