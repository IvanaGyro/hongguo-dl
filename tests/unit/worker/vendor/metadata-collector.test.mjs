import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mc = require('../../../../worker/vendor/metadata-collector.js');

// Known answers from the reverse-bytedance recovery (baseline 74532).
test('pd / fkd match the recovered CRC32/MD5 formulas', () => {
  const uuid = '00000000-0000-4000-8000-000000000000';
  assert.equal(mc.crc32(Buffer.from(uuid, 'utf8')), 1004537367); // pd
  const md5hex = require('node:crypto').createHash('md5').update(uuid + '0').digest('hex');
  assert.equal(md5hex, 'f30b9c7d33010f4594f48a5d30e5e277');
  assert.equal(mc.crc32(Buffer.from(md5hex, 'ascii')), 2700164654); // fkd
});

test('initialFlMarkers reproduce the native fl[2:5]', () => {
  // The real field24 fl = "0|0|3487918576|4033471951|1979344725|0|0|0|0|…"
  assert.deepEqual(mc.initialFlMarkers(1700000000123n), [3487918576, 4033471951, 1979344725]);
});

test('giB folds signed64 bytes by 1/1024 three times in float32', () => {
  assert.equal(mc.giB(8 * 1024 ** 3), 8);
  assert.equal(mc.giB(0), 0);
});

test('tk predicate: missing/empty is true; non-base64 is false', () => {
  assert.equal(mc.diagnosticTk(null), true);
  assert.equal(mc.diagnosticTk(''), true);
  assert.equal(mc.diagnosticTk('AAAA'), true);
  assert.equal(mc.diagnosticTk('!!!'), false);
});

test('diagnosticsJson keeps the load-bearing key order and computed pd/fkd', () => {
  const json = mc.diagnosticsJson({ uuid: '00000000-0000-4000-8000-000000000000', kd: 0,
    tsMs: 1700000000000, initTsMs: 1700000000123, threadMarker: 3343305546, unHash: 0 });
  const keys = [...json.matchAll(/"([a-z_0-9]+)":/g)].map(m => m[1]);
  assert.deepEqual(keys, ['cmr', 'cmr2', 'un_h', 'vpn', 'sts', 'kd', 'fkd', 'pd', 'lp', 'fl', 'dyn', 'do', 'tk']);
  const o = JSON.parse(json);
  assert.equal(o.pd, 1004537367);
  assert.equal(o.fkd, 2700164654);
  assert.match(o.fl, /^0\|0\|3487918576\|4033471951\|1979344725\|/);
  assert.equal(o.tk, true);
});

test('device_profile encodes as valid nested protobuf', () => {
  const info = mc.deviceInfoProto({ deviceId: '123', requestClockMs: 1700000000000 });
  const env = mc.deviceProfileProto({ ts: 1700000000, info });
  assert.ok(Buffer.isBuffer(env) && env.length > 50);
  // f6 (SDK build string) present as a length-delimited field
  assert.ok(env.includes(Buffer.from('v04.10.03.04-bugfix')));
  assert.ok(info.includes(Buffer.from('Asia/Taipei,8')));
  assert.ok(info.includes(Buffer.from('25053RT47C')));
});
