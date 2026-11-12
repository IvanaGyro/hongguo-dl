import test from 'node:test';
import assert from 'node:assert/strict';
import { hevcCodecStringFromHvcc } from '../src/hevc-codec.js';
import { hevcCodecStringFromMoov } from '../src/mp4-track-formats.js';

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

test('hvcC Main10 profile produces precise codec string with reversed compatibility bits', () => {
  assert.equal(hevcCodecStringFromHvcc(hvcc(2, 0x20000000, 120,
    [0x90, 0, 0, 0, 0, 0])), 'hvc1.2.4.L120.90');
  assert.equal(hevcCodecStringFromHvcc(hvcc(1, 0x60000000, 93)),
    'hvc1.1.6.L93');
});

test('hvcC profile space, high tier and constraint order are preserved', () => {
  const data = hvcc(0x40 | 0x20 | 2, 0x20000000, 153,
    [0xB0, 0x00, 0x07, 0, 0, 0]);
  assert.equal(hevcCodecStringFromHvcc(data, 'hev1'), 'hev1.A2.4.H153.B0.00.07');
});

test('derive clear-output hvc1 codec from encrypted encv sample entry', () => {
  const moov = box('moov', track(encryptedHevc(
    hvcc(2, 0x20000000, 120, [0x90, 0, 0, 0, 0, 0]))));
  assert.equal(hevcCodecStringFromMoov(moov), 'hvc1.2.4.L120.90');
  assert.equal(hevcCodecStringFromMoov(box('moov', box('free',
    new TextEncoder().encode('fake hvcC')))), null);
});

test('invalid truncated, wrong version or missing hvcC is not guessed', () => {
  assert.equal(hevcCodecStringFromHvcc(new Uint8Array(13)), null);
  assert.equal(hevcCodecStringFromHvcc(hvcc(0, 0, 120)), null);
  const wrongVersion = hvcc(2, 0x20000000, 120);
  wrongVersion[0] = 7;
  assert.equal(hevcCodecStringFromHvcc(wrongVersion), null);
  assert.equal(hevcCodecStringFromMoov(box('moov',
    track(box('encv', join(new Uint8Array(78), sinf('hvc1'))))), null);
});
