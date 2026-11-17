// SPDX-License-Identifier: GPL-3.0-only
// Independent test vectors from N3urda/hongguoTV (GPL-3.0-only):
// kotlin-tv/core/src/test/resources/signing-v5-{f13,carrier}.json
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const source = require('../worker/vendor/app-source.js');
const f13 = require('./fixtures/signing-v5-f13.json');
const carriers = require('./fixtures/signing-v5-carrier.json');

test('v5 Medusa F13 matches all 32 independent SDK digest fixtures', () => {
  assert.equal(f13.length, 32);
  for (const [index, fixture] of f13.entries()) {
    const timestamp = Buffer.alloc(4);
    timestamp.writeUInt32LE(fixture.ts);
    const digest = source.hashF13(Buffer.from(fixture.query, 'hex'),
      Buffer.from(fixture.body, 'hex'), timestamp, fixture.ts, true);
    assert.equal(digest.length, 20);
    assert.equal(digest.subarray(0, 16).toString('hex'), fixture.digest,
      'F13 timestamp class ' + index);
    assert.equal(digest[16] & 0x24, 0x24);
  }
});

test('v5 Medusa carrier matches independent timestamp-variant fixtures', () => {
  assert.equal(carriers.length, 4);
  for (const [index, fixture] of carriers.entries()) {
    const carrier = new source.AesV3(Buffer.from(fixture.key, 'hex'), fixture.ts, true)
      .encrypt(Buffer.from(fixture.source, 'hex'), Buffer.from(fixture.iv, 'hex'));
    assert.equal(carrier.toString('hex'), fixture.encrypted, 'carrier variant ' + index);
  }
});

test('v5 player signs the final gzip body and registered identity, without legacy transport headers', () => {
  const identity = { device_id: '1234567890123456', iid: '2345678901234567',
    cdid: '0c6c7f17-b3b7-4d3b-bf66-5cb2b1d400d5' };
  for (const level of [1, 2, 3]) {
    const payload = JSON.stringify({
      biz_param: { device_level: level, need_all_video_definition: true },
      mixed_video_id_map: { '1004': ['7703906910138813464'] }, dr_scene: 'player',
    });
    const signed = source.playbackRequest(payload, identity);
    const url = new URL(signed.url);
    assert.equal(url.origin, 'https://api5-normal-sinfonlinea.fqnovel.com');
    assert.equal(url.pathname, '/novel/player/multi_video_model/player/v1');
    assert.equal(url.searchParams.get('device_id'), identity.device_id);
    assert.equal(url.searchParams.get('iid'), identity.iid);
    assert.equal(url.searchParams.get('cdid'), identity.cdid);
    assert.equal(url.searchParams.get('ts'), null);
    assert.equal(signed.method, 'POST');
    assert.equal(JSON.parse(gunzipSync(signed.body)).biz_param.device_level, level);
    assert.equal(signed.headers['x-ss-stub'],
      crypto.createHash('md5').update(signed.body).digest('hex').toUpperCase());
    assert.equal(source.v5Branch(url.search.slice(1), signed.body,
      Number(signed.headers['x-khronos'])), 12);
    assert.ok(signed.headers['x-helios']);
    assert.ok(signed.headers['x-medusa']);
    assert.equal(signed.headers['x-argus'], undefined);
    assert.equal(signed.headers['x-ladon'], undefined);
    assert.equal(signed.headers['x-gorgon'], undefined);
    assert.equal(signed.headers['x-ss-req-ticket'], undefined);
  }
});

test('invalid device level fails before registration or any network call', async () => {
  await assert.rejects(
    source.fetchAppPlayUrl('7703906910138813464', { deviceLevel: 4 }),
    error => error.code === 'INVALID_DEVICE_LEVEL',
  );
});
