import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMp4TrackFormats, movieDurationSeconds } from '../src/mp4-track-formats.js';

const bytes = text => Uint8Array.from(text, c => c.charCodeAt(0));
const join = (...parts) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let i = 0; for (const part of parts) { result.set(part, i); i += part.length; }
  return result;
};
const box = (type, payload = new Uint8Array(0)) => {
  const value = new Uint8Array(payload.length + 8);
  new DataView(value.buffer).setUint32(0, value.length);
  value.set(bytes(type), 4);
  value.set(payload, 8);
  return value;
};
const track = entry => box('trak', box('mdia',
  box('minf', box('stbl', box('stsd', join(
    new Uint8Array([0,0,0,0,0,0,0,1]), entry))))));
const format = value => box('sinf', box('frma', bytes(value)));
const audio = codec => box('enca', join(new Uint8Array(28), format(codec)));
const video = codec => box('encv', join(new Uint8Array(78), format(codec)));

test('encrypted hvc1 and AAC entries are parsed only from stsd/frma paths', () => {
  const data = box('moov', join(track(video('hvc1')), track(audio('mp4a'))));
  assert.deepEqual(inspectMp4TrackFormats(data), {
    hasAac: true, videoCodec: 'hvc1', videoTracks: 1, audioTracks: 1
  });
});
test('an unrelated mp4a byte sequence cannot fabricate an AAC track', () => {
  const data = box('moov', join(track(video('hev1')),
    track(audio('ac-3')), box('udta', bytes('random mp4a payload'))));
  assert.deepEqual(inspectMp4TrackFormats(data), {
    hasAac: false, videoCodec: 'hev1', videoTracks: 1, audioTracks: 1
  });
});
test('malformed boxes cannot claim unsupported audio format as AAC', () => {
  assert.equal(inspectMp4TrackFormats(box('moov',
    box('trak', box('stsd', bytes('mp4a'))))).hasAac, false);
  assert.equal(inspectMp4TrackFormats(new Uint8Array(0)).videoCodec, null);
});

test('mvhd duration allows full seekable timeline without downloading video', () => {
  const payload = new Uint8Array(100);
  new DataView(payload.buffer).setUint32(12, 1000);
  new DataView(payload.buffer).setUint32(16, 12000);
  const moov = box('moov', box('mvhd', payload));
  assert.equal(movieDurationSeconds(moov), 12);
  new DataView(payload.buffer).setUint32(12, 0);
  assert.equal(movieDurationSeconds(box('moov', box('mvhd', payload))), null);
  assert.equal(movieDurationSeconds(box('moov', box('trak', bytes('mvhd')))), null);
});
test('version 1 mvhd duration supports 64-bit integer timescale safely', () => {
  const payload = new Uint8Array(100);
  payload[0] = 1;
  const view = new DataView(payload.buffer);
  view.setUint32(20, 1000);
  view.setUint32(24, 0);
  view.setUint32(28, 18000);
  assert.equal(movieDurationSeconds(box('moov', box('mvhd', payload))), 18);
});
