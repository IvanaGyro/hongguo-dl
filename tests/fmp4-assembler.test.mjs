import test from 'node:test';
import assert from 'node:assert/strict';
import { createFmp4Assembler } from '../src/fmp4-assembler.js';

function box(name, payload = new Uint8Array(3)) {
  const value = new Uint8Array(8 + payload.length);
  new DataView(value.buffer).setUint32(0, value.byteLength);
  value.set([...name].map(c => c.charCodeAt(0)), 4);
  value.set(payload, 8);
  return value;
}
function concat(...parts) {
  const result = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0; for (const part of parts) { result.set(part, pos); pos += part.length; }
  return result;
}
test('remux fragments survive arbitrary AVIO callback boundaries', async () => {
  const events = [];
  const ftyp = box('ftyp'), moov = box('moov'), moofA = box('moof'),
    moofB = box('moof'), mdatA = box('mdat', new Uint8Array(300)),
    mdatB = box('mdat', new Uint8Array(57));
  const bytes = concat(ftyp, moov, moofA, mdatA, moofB, mdatB);
  const stream = createFmp4Assembler({
    onInit: async data => { events.push(['init', data]); },
    onMedia: async data => { events.push(['media', data]); }
  });
  for (let i = 0; i < bytes.length; i += 7)
    await stream.push(bytes.subarray(i, i + 7));
  assert.equal(stream.finish(), 2);
  assert.deepEqual(events.map(([type]) => type), ['init', 'media', 'media']);
  assert.deepEqual(events[0][1], concat(ftyp, moov));
  assert.deepEqual(events[1][1], concat(moofA, mdatA));
  assert.deepEqual(events[2][1], concat(moofB, mdatB));
});
test('incomplete and oversized boxes are rejected rather than published', async () => {
  const stream = createFmp4Assembler({ onInit: async () => {}, onMedia: async () => {} });
  await stream.push(box('ftyp'));
  assert.throws(() => stream.finish(), /不完整/);
  await assert.rejects(stream.push(box('mdat')), /缺少 moof/);
  const bad = new Uint8Array(8);
  new DataView(bad.buffer).setUint32(0, 0x7fffffff);
  bad.set([109,111,111,102], 4);
  await assert.rejects(stream.push(bad), /尺寸/);
});
