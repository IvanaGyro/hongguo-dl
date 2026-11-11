// Exercise the exact Rust-Wasm bridge that runs in Cloudflare workerd.
// Compare against independent SM3/Argus golden vectors and the legacy JS
// implementation, so a port cannot silently change signed API payloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const sm3 = require('../worker/vendor/sm3.js');
const lengths = [0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 255, 1024, 16384];
const payloads = lengths.map(len => {
  const input = Buffer.alloc(len);
  for (let i = 0; i < len; ++i) input[i] = (i * 31 + 7) & 0xff;
  return input;
});
const unicode = Buffer.from('繁體中文與 Rust WASM ✨');
// Capture legacy reference vectors BEFORE installing the Rust implementation.
const expected = payloads.map(input => sm3(input).toString('hex'));
const expectedUnicode = sm3(unicode).toString('hex');
const compiled = readFileSync(resolve(__dirname, '../rust/crypto/dist/hongguo_crypto.wasm'));
const wasmModule = new WebAssembly.Module(compiled);
const rustSm3 = require('../worker/rust-sm3.cjs')(wasmModule);
const { Argus } = require('../worker/vendor/playback-signature.js');

test('Rust WebAssembly SM3 official vectors', () => {
  assert.equal(rustSm3(Buffer.from('abc')).toString('hex'),
    '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0');
  assert.equal(rustSm3(Buffer.from('abcd'.repeat(16))).toString('hex'),
    'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732');
  assert.equal(Argus.queryHash('').toString('hex'), '106e34a2b8c7');
  assert.equal(Argus.queryHash('aid=1967&device_id=123').toString('hex'), '925b8d86b20f');
  assert.equal(Argus.bodyHash('ac3ef48caa08fa3ed5e025da69edc645').toString('hex'), '5048b6e949d0');
});

test('Rust SM3 wasm handles empty, Unicode, and block boundaries', () => {
  for (let i = 0; i < lengths.length; i++) {
    assert.equal(rustSm3(payloads[i]).toString('hex'), expected[i], 'mismatch at length ' + lengths[i]);
  }
  assert.equal(rustSm3(unicode).toString('hex'), expectedUnicode);
});
