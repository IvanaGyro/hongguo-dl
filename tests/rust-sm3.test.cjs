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
const signing = require('../worker/vendor/playback-signature.js');
const FIXTURES = [
  { query: 'aid=1967&device_id=dev_aaaaaaaa&iid=111', ts: 1700000000,
    randField: 659662259, ladonRandom: Buffer.from('01020304', 'hex') },
  { query: 'aid=1967&device_id=dev_bbbbbbbbbbbbbbbb&iid=222', ts: 1700000001,
    randField: 1315257197, ladonRandom: Buffer.from('05060708', 'hex') },
  { query: 'aid=1967&device_id=X&iid=333', ts: 1234567890,
    randField: 554000487, ladonRandom: Buffer.from('99aabbcc', 'hex') },
  { query: 'aid=1967&device_id=test_device_id&iid=456&version_name=6.5.1.32',
    ts: 1700000000, randField: 420072733, ladonRandom: Buffer.from('01020304', 'hex') },
  { query: 'aid=1967&device_id=test_device_id&iid=456&version_name=6.5.1.32',
    ts: 1700000000, randField: 420072733, ladonRandom: Buffer.from('01020304', 'hex'),
    body: Buffer.from('{"x":1}') },
  { query: 'aid=1967&device_id=中文&version_name=7.4.3.32',
    ts: 1740000000, randField: -1234567, ladonRandom: Buffer.from('11223344', 'hex'),
    body: Buffer.from('Hello Rust!') }
];
const originalSignatures = FIXTURES.map(data => signing.signPlayer(data));
const appSource = require('../worker/vendor/app-source.js');
const GORGON_FIXTURES = [
  ['aid=1967&device_id=123', null, 1700000000, 0x1234],
  ['a=1&url=%2F&timestamp=2026', Buffer.from('hello'), 1700000001, 0],
  ['query=%E4%B8%AD%E6%96%87', Buffer.from('a different payload'), 1700123456, 65535],
];
const originalGorgon = GORGON_FIXTURES.map(args => appSource.xGorgon(...args));
const compiled = readFileSync(resolve(__dirname, '../rust/crypto/dist/hongguo_crypto.wasm'));
const wasmModule = new WebAssembly.Module(compiled);
const { sm3: rustSm3, simonBlocks, ladonTransform, gorgonTransform } = require('../worker/rust-sm3.cjs')(wasmModule);
const { Argus, Simon, Ladon } = signing;

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

test('Rust Simon 72-round blocks match fixed 64-bit golden', () => {
  const key = [1111111111111111111n, 2222222222222222222n,
    3333333333333333333n, 4444444444444444444n];
  const keyBytes = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) keyBytes.writeBigUInt64LE(key[i], i * 8);
  const block = Buffer.alloc(16);
  block.writeBigUInt64LE(1234567890123456789n, 0);
  block.writeBigUInt64LE(9876543210987654321n, 8);
  const result = simonBlocks(keyBytes, block);
  assert.deepEqual([result.readBigUInt64LE(0), result.readBigUInt64LE(8)],
    [6071150433487837324n, 2027321285990159935n]);
  assert.deepEqual(Simon.encrypt(1234567890123456789n, 9876543210987654321n, key),
    [6071150433487837324n, 2027321285990159935n]);
});

test('Rust Ladon 34-round transform preserves fixed golden', () => {
  const random = Buffer.from('01020304', 'hex');
  const digest = Buffer.from('de0b56f1b46af782a3c13a78476be326');
  const payload = Buffer.from('1700000000-1611921764-1967');
  const pad = 16 - payload.length % 16;
  const input = Buffer.concat([payload, Buffer.alloc(pad, pad)]);
  const output = ladonTransform(digest, input);
  assert.equal(output.toString('hex'),
    'a33b63b6d69ce2145e64f26c3ebf32919bba07b8b01c1426cc87562be1b4cb07');
  assert.equal(Ladon.encrypt(1700000000, 1611921764, 1967, random),
    'AQIDBKM7Y7bWnOIUXmTybD6/MpGbuge4sBwUJsyHVivhtMsH');
});

test('Production Rust signing matches existing JS protocol byte-for-byte', () => {
  for (let i = 0; i < FIXTURES.length; ++i) {
    assert.deepEqual(signing.signPlayer(FIXTURES[i]), originalSignatures[i],
      'full signed request differs at fixture ' + i);
  }
});

test('Rust signing bridge rejects invalid or unsafe input lengths', () => {
  assert.throws(() => simonBlocks(Buffer.alloc(31), Buffer.alloc(16)), /32-byte key/);
  assert.throws(() => simonBlocks(Buffer.alloc(32), Buffer.alloc(17)), /aligned input/);
  assert.throws(() => ladonTransform(Buffer.alloc(32), Buffer.alloc(16 * 1024 * 1024 + 16)), /aligned input/);
});

test('Helios uses shared Rust Ladon rounds and matches fixed ciphertext', () => {
  const { helios } = require('../worker/vendor/app-source.js');
  const originalRandom = Math.random;
  Math.random = () => 0x12345678 / 0x100000000;
  try {
    assert.equal(helios(1700000000),
      'eFY0EoRGGi2qBu2z7mg9cewQHxhl2JqeXVHnmakVf60TcY/S');
  } finally {
    Math.random = originalRandom;
  }
});

test('Rust Gorgon legacy RC4-like transformation matches fixed vectors', () => {
  const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => i));
  for (const [random, hex] of [
    [0, '7c6ea4f8fd1b19a64fb5f17cf2c09ce864510400'],
    [0x1234, 'aa1bde6f7b948ad7823d322065098be5ba8a2733'],
    [65535, 'cb95f3729edc67f5cf7a645210f698674fd40085']
  ]) {
    assert.equal(gorgonTransform(bytes, random).toString('hex'), hex);
  }
  assert.throws(() => gorgonTransform(Buffer.alloc(19), 1), /20 bytes/);
  assert.throws(() => gorgonTransform(Buffer.alloc(20), 65536), /16-bit nonce/);
});

test('Rust Gorgon generates byte-for-byte compatible app signatures', () => {
  assert.equal(appSource.xGorgon(...GORGON_FIXTURES[0]),
    '840434124001db2d5bb9d9fe6cc91364e71df6105a4612699331');
  for (let i = 0; i < GORGON_FIXTURES.length; ++i) {
    assert.equal(appSource.xGorgon(...GORGON_FIXTURES[i]), originalGorgon[i],
      'Gorgon signature differs at fixture ' + i);
  }
});
