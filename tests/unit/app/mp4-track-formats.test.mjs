import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hevcCodecStringFromMoov,
  inspectMp4TrackFormats,
  movieDurationSeconds
} from '../../../src/mp4-track-formats.js';

describe('encrypted HEVC sample entries', () => {
  const box = (type, payload) => {
    const data = new Uint8Array(8 + payload.length);
    new DataView(data.buffer).setUint32(0, data.length);
    data.set([...type].map(c => c.charCodeAt(0)), 4);
    data.set(payload, 8);
    return data;
  };
  const join = (...parts) => {
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    return data;
  };
  const hvcc = (profile, compatibility, level, constraints = [0, 0, 0, 0, 0, 0]) => {
    const data = new Uint8Array(23);
    data[0] = 1;
    data[1] = profile;
    new DataView(data.buffer).setUint32(2, compatibility);
    data.set(constraints, 6);
    data[12] = level;
    return data;
  };
  const track = entry => box('trak', box('mdia', box('minf', box('stbl',
    box('stsd', join(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), entry))))));
  const sinf = name => box('sinf', box('frma', Uint8Array.from(name, c => c.charCodeAt(0))));
  const encryptedHevc = hvccData => box('encv', join(
    new Uint8Array(78), box('hvcC', hvccData), sinf('hvc1')));

  test('derive clear-output hvc1 codec from encrypted encv sample entry', () => {
    const moov = box('moov', track(encryptedHevc(
      hvcc(2, 0x20000000, 120, [0x90, 0, 0, 0, 0, 0]))));
    assert.equal(hevcCodecStringFromMoov(moov), 'hvc1.2.4.L120.90');
    assert.equal(hevcCodecStringFromMoov(box('moov', box('free',
      new TextEncoder().encode('fake hvcC')))), null);
  });
});

describe('track formats', () => {
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
});
