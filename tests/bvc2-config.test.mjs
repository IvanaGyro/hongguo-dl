import test from 'node:test';
import assert from 'node:assert/strict';
import { bvc2ParameterNals, normalizeBvc2Config } from '../src/bvc2-config.js';
function box(type, payload) {
  const out = Buffer.alloc(8 + payload.length); out.writeUInt32BE(out.length);
  out.write(type, 4); payload.copy(out, 8); return out;
}
function fixture() {
  const sps = Buffer.from([0, (15 << 3) | 1, 3, 4, 5]);
  const record = Buffer.alloc(19); record[0] = 1; record[1] = 7; record[18] = 1;
  const array = Buffer.from([0x80 | 15, 0, 1, 0, sps.length]);
  const config = Buffer.concat([record, array, sps]);
  const entry = box('encv', Buffer.concat([Buffer.alloc(78), box('bv2C', config), box('sinf', Buffer.alloc(16))]));
  const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', Buffer.concat([Buffer.alloc(8), entry])))))));
  return { config, sps, moov };
}
test('version-1 configuration arrays become exact four-byte-length parameter NALs', () => {
  const { config, sps } = fixture();
  const result = bvc2ParameterNals(config);
  assert.equal(new DataView(result.buffer).getUint32(0), sps.length);
  assert.deepEqual([...result.subarray(4)], [...sps]);
  assert.equal(bvc2ParameterNals(result), null);
});
test('MP4 normalization keeps all sample offsets and following encryption metadata unchanged', () => {
  const { moov } = fixture(), original = Buffer.from(moov);
  const result = normalizeBvc2Config(moov);
  assert.equal(result.changed, 1); assert.equal(result.bytes.length, moov.length);
  assert.deepEqual(moov, original);
  assert.equal(Buffer.from(result.bytes).indexOf('sinf'), original.indexOf('sinf'));
  assert.equal(normalizeBvc2Config(result.bytes).changed, 0);
});
test('partial header probes and full moov produce the same overlapping rewritten bytes', () => {
  const { moov } = fixture();
  const first = moov.subarray(0, moov.length - 10);
  const a = normalizeBvc2Config(first), b = normalizeBvc2Config(moov);
  assert.equal(a.changed, 1);
  assert.deepEqual([...a.bytes], [...b.bytes.subarray(0, first.length)]);
});
test('malformed lengths, mismatched NAL types, unsupported length widths and trailing bytes fail closed', () => {
  const { config } = fixture();
  for (const edit of [b => { b[1] = 0; }, b => { b[22] = 255; }, b => { b[25] = 1; }]) {
    const corrupt = Buffer.from(config); edit(corrupt);
    assert.throws(() => bvc2ParameterNals(corrupt), { code: 'BVC2_CONFIG_INVALID' });
  }
  assert.throws(() => bvc2ParameterNals(Buffer.concat([config, Buffer.from([0])])), { code: 'BVC2_CONFIG_INVALID' });
});
