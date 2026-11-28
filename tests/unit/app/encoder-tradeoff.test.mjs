import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_H264_TRADEOFF, ENCODER_TRADEOFFS, DEFAULT_TRADEOFFS, H264_TRADEOFFS,
  encoderTradeoff, h264Tradeoff, h264TradeoffIndex, tradeoffIndex, tradeoffSuffix,
  isEncodingMode, encoderSettings, jobTradeoffIndex } from '../../../src/encoder-tradeoff.js';

test('six empirically tested H.264 presets are ordered by speed/size (without veryfast)', () => {
  assert.deepEqual(H264_TRADEOFFS.map(({ preset, crf }) => [preset, crf]), [
    ['ultrafast', 18], ['superfast', 19], ['faster', 16],
    ['fast', 17], ['medium', 18], ['slow', 18]
  ]);
  for (const invalid of [null, undefined, 'bad', -1, 6, 0.2, Infinity])
    assert.equal(h264TradeoffIndex(invalid), DEFAULT_H264_TRADEOFF);
  assert.equal(h264TradeoffIndex('0'), 0);
  assert.equal(h264TradeoffIndex('5'), 5);
  assert.equal(h264Tradeoff(4).preset, 'medium');
});

test('HEVC, AV1 and VVC stops use valid encoder presets ordered fast to small', () => {
  const x265 = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];
  const hevc = ENCODER_TRADEOFFS.hevc.map(s => x265.indexOf(s.preset));
  assert(hevc.every((v, i) => v >= 0 && (i === 0 || v > hevc[i - 1])));
  const av1 = ENCODER_TRADEOFFS.av1.map(s => Number(s.preset));
  assert(av1.every((v, i) => v >= 0 && v <= 13 && (i === 0 || v < av1[i - 1])));
  assert.deepEqual(ENCODER_TRADEOFFS.vvc.map(s => s.preset), ['faster', 'fast', 'medium']);
  for (const [mode, stops] of Object.entries(ENCODER_TRADEOFFS)) {
    assert(stops[DEFAULT_TRADEOFFS[mode]], mode);
    for (const s of stops) assert(Number.isInteger(s.quality) && s.quality > 0 && s.quality <= 51);
  }
});

test('mode-specific index validation, suffixes and non-encoding modes', () => {
  assert.equal(tradeoffIndex('vvc', 3), DEFAULT_TRADEOFFS.vvc);
  assert.equal(tradeoffIndex('vvc', 2), 2);
  assert.equal(encoderTradeoff('copy', 0), null);
  assert.equal(isEncodingMode('original'), false);
  assert.equal(isEncodingMode('av1'), true);
  assert.equal(tradeoffSuffix('av1', 1), '.av1-p10');
  assert.equal(tradeoffSuffix('hevc', 0), '.hevc-ultrafast');
  assert.equal(tradeoffSuffix('copy', 0), '');
});

test('every slider stop maps to the preset and quality sent to media_convert', () => {
  const expected = {
    h264: [['ultrafast', 18], ['superfast', 19], ['faster', 16], ['fast', 17], ['medium', 18], ['slow', 18]],
    hevc: [['ultrafast', 22], ['superfast', 22], ['veryfast', 22], ['faster', 22], ['fast', 22], ['medium', 22]],
    av1: [['12', 30], ['10', 30], ['9', 30], ['8', 30], ['7', 30], ['6', 30]],
    vvc: [['faster', 30], ['fast', 30], ['medium', 30]]
  };
  assert.deepEqual(Object.keys(expected), Object.keys(ENCODER_TRADEOFFS));
  for (const [mode, stops] of Object.entries(expected))
    assert.deepEqual(stops.map((_, i) => encoderSettings(mode, i)),
      stops.map(([preset, quality]) => ({ preset, quality })), mode);
  // An out-of-range stop uses the mode's default instead of a wrong preset.
  assert.deepEqual(encoderSettings('vvc', 5), { preset: 'faster', quality: 30 });
  assert.deepEqual(encoderSettings('av1', '-1'), { preset: '10', quality: 30 });
  // No stop (playback) and non-encoding modes: encoder defaults / packet copy.
  for (const [mode, index] of [['h264', null], ['av1', undefined], ['copy', 2], ['original', 0]])
    assert.deepEqual(encoderSettings(mode, index), { preset: '', quality: 0 }, mode);
});

test('queue jobs saved before per-codec sliders keep their H.264 stop', () => {
  const legacy = { mode: 'h264', h264TradeoffIndex: 4 };
  assert.equal(jobTradeoffIndex(legacy), 4);
  assert.deepEqual(encoderSettings(legacy.mode, jobTradeoffIndex(legacy)), { preset: 'medium', quality: 18 });
  assert.equal(jobTradeoffIndex({ mode: 'hevc', tradeoffIndex: 0, h264TradeoffIndex: 4 }), 0);
  assert.equal(jobTradeoffIndex({ mode: 'h264' }), null);
  assert.equal(jobTradeoffIndex(null), null);
});
