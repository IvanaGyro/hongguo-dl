import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHevcInitCodecMatches } from '../src/cenc-init-codec.js';
import { hevcCodecStringFromClearMoov } from '../src/mp4-track-formats.js';

const box = (type, payload = new Uint8Array(0)) => {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...type].map(x => x.charCodeAt(0)), 4);
  out.set(payload, 8);
  return out;
};
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
};
const hvcc = (profile = 2) => {
  const d = new Uint8Array(23);
  d[0] = 1;
  d[1] = profile;
  new DataView(d.buffer).setUint32(2, 0x20000000);
  d[6] = 0x90;
  d[12] = 120;
  return d;
};
const init = (tag = 'hvc1', data = hvcc()) => {
  const entry = box(tag, join(new Uint8Array(78), box('hvcC', data)));
  const stsd = box('stsd', join(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), entry));
  const moov = box('moov', box('trak', box('mdia', box('minf',
    box('stbl', stsd)))));
  return { moov, bytes: join(box('ftyp', new Uint8Array(8)), moov) };
};
test('clear HEVC Main10 init matches exact MSE MIME description', () => {
  const data = init();
  assert.equal(hevcCodecStringFromClearMoov(data.moov), 'hvc1.2.4.L120.90');
  assert.equal(assertHevcInitCodecMatches(data.bytes, 'hvc1.2.4.L120.90'),
    'hvc1.2.4.L120.90');
});
test('hev1 output sample entry must not be relabeled as hvc1', () => {
  const data = init('hev1');
  assert.equal(hevcCodecStringFromClearMoov(data.moov), 'hev1.2.4.L120.90');
  // The source metadata reports hvc1, but the remuxer may legally emit hev1.
  // The consumer must use the returned actual tag when creating SourceBuffer.
  assert.equal(assertHevcInitCodecMatches(data.bytes, 'hvc1.2.4.L120.90'),
    'hev1.2.4.L120.90');
  assert.equal(assertHevcInitCodecMatches(data.bytes, 'hev1.2.4.L120.90'),
    'hev1.2.4.L120.90');
});
test('wrong profile and missing hvcC fail before MSE append', () => {
  assert.throws(() => assertHevcInitCodecMatches(init().bytes,
    'hvc1.1.4.L120.90'), { code: 'HEVC_INIT_MISMATCH' });
  const missing = box('moov', box('trak', box('mdia', box('minf',
    box('stbl', box('stsd', join(new Uint8Array([0,0,0,0,0,0,0,1]),
      box('hvc1', new Uint8Array(78)))))))));
  assert.throws(() => assertHevcInitCodecMatches(join(box('ftyp'), missing),
    'hvc1.2.4.L120.90'), { code: 'HEVC_INIT_MISMATCH' });
});
test('malformed or truncated initialization is rejected within bounds', () => {
  const data = init().bytes;
  for (const bad of [new Uint8Array(0), data.subarray(0, data.length - 1),
    box('moov'), join(box('ftyp'), box('free'))]) {
    assert.throws(() => assertHevcInitCodecMatches(bad, 'hvc1.2.4.L120.90'),
      { code: 'HEVC_INIT_MISMATCH' });
  }
});
