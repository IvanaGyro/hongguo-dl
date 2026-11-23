import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_H264_TRADEOFF, H264_TRADEOFFS, h264Tradeoff,
  h264TradeoffIndex, h264EncoderArgs } from '../../../src/h264-download-tradeoff.js';

test('six empirically tested presets are ordered by speed/size (without veryfast)', () => {
  assert.deepEqual(H264_TRADEOFFS.map(({ preset, crf }) => [preset, crf]), [
    ['ultrafast', 18], ['superfast', 19], ['faster', 16],
    ['fast', 17], ['medium', 18], ['slow', 18]
  ]);
});
test('each slider step maps to exact libx264 preset/CRF arguments', () => {
  for (let i = 0; i < H264_TRADEOFFS.length; i++) {
    const profile = h264Tradeoff(i);
    assert.deepEqual(h264EncoderArgs(i),
      ['-c:v','libx264','-preset',profile.preset,'-crf',String(profile.crf),'-pix_fmt','yuv420p']);
  }
  for (const invalid of [null, undefined, 'bad', -1, 6, 0.2, Infinity])
    assert.equal(h264TradeoffIndex(invalid), DEFAULT_H264_TRADEOFF);
  assert.equal(h264TradeoffIndex('0'), 0);
  assert.equal(h264TradeoffIndex('5'), 5);
});
