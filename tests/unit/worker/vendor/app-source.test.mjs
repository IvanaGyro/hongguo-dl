// SPDX-License-Identifier: GPL-3.0-only
// Independent test vectors from N3urda/hongguoTV (GPL-3.0-only):
// kotlin-tv/core/src/test/resources/signing-v5-{f13,carrier}.json
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import source from '../../../../worker/vendor/app-source.js';
import f13 from '../../../fixtures/signing-v5-f13.json' with { type: 'json' };
import carriers from '../../../fixtures/signing-v5-carrier.json' with { type: 'json' };

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

test('v5 player signs the final gzip body and registered identity with the minimal official player header set', () => {
  const identity = { device_id: '1234567890123456', iid: '2345678901234567',
    cdid: '0c6c7f17-b3b7-4d3b-bf66-5cb2b1d400d5' };
  for (const level of [1, 2, 3]) {
    const payload = JSON.stringify({
      biz_param: { device_level: level, need_all_video_definition: true },
      mixed_video_id_map: { '1004': ['7703906910138813464'] }, dr_scene: 'player',
    });
    const signed = source.playbackRequest(payload, identity, source.VIDEO_HOSTS[level % 2]);
    const url = new URL(signed.url);
    assert.equal(url.origin, source.VIDEO_HOSTS[level % 2]);
    assert.equal(url.pathname, '/novel/player/multi_video_model/v1/');
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
    // The official-app player POST (mobile v5) carries only Khronos/Helios/Medusa
    // plus the body SS-STUB; the TTNet Argus/Ladon/Gorgon/Dt headers are not sent.
    for (const name of ['x-argus', 'x-ladon', 'x-gorgon', 'x-tt-dt', 'x-ss-req-ticket'])
      assert.equal(signed.headers[name], undefined, name);
  }
});

test('invalid device level fails before registration or any network call', async () => {
  await assert.rejects(
    source.fetchAppPlayUrl('7703906910138813464', { deviceLevel: 4 }),
    error => error.code === 'INVALID_DEVICE_LEVEL',
  );
});

const identity = { device_id: '1234567890123456', iid: '2345678901234567',
  cdid: '0c6c7f17-b3b7-4d3b-bf66-5cb2b1d400d5' };
const VID = '7703906910138813464';

test('v5 player hosts are the primary and backup official hosts; others are refused', () => {
  assert.deepEqual(source.VIDEO_HOSTS, ['https://api5-normal-sinfonlinea.fqnovel.com',
    'https://api5-normal-sinfonlineb.fqnovel.com']);
  assert.throws(() => source.playbackRequest('{}', identity, 'https://example.com'), TypeError);
});

test('video_tab recovery is a bodyless v5 GET signed over an empty-body digest', () => {
  const signed = source.videoTabRequest(VID, identity, 3);
  const url = new URL(signed.url);
  assert.equal(signed.method, 'GET');
  assert.equal(signed.body, null);
  assert.equal(url.origin, 'https://api5-normal-sinfonlineb.fqnovel.com');
  assert.equal(url.pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
  for (const [key, value] of Object.entries({ video_id: VID, video_id_type: '0', device_level: '3',
    need_all_video_definition: '1', video_platform: '1024', device_id: identity.device_id,
    iid: identity.iid, cdid: identity.cdid })) assert.equal(url.searchParams.get(key), value, key);
  // _rticket is the final signed field, so branch selection covers every parameter.
  assert.equal([...url.searchParams.keys()].pop(), '_rticket');
  const khronos = Number(signed.headers['x-khronos']);
  assert.equal(source.v5Branch(url.search.slice(1), Buffer.alloc(0), khronos), 12);
  assert.ok(signed.headers['x-helios'] && signed.headers['x-medusa']);
  for (const name of ['x-ss-stub', 'Content-Type', 'Content-Encoding', 'x-ss-req-ticket', 'x-argus', 'x-ladon', 'x-gorgon'])
    assert.equal(signed.headers[name], undefined, name);
});

// --- Mocked transport: recovery ordering and boundaries (no network). ---
function model(vid) {
  return { code: 0, data: { [vid]: { video_model: JSON.stringify({ video_list: { v1: {
    codec_type: 'h264', vwidth: 1080, vheight: 1920, encrypt: false,
    main_url: 'https://v1.qznovelvod.com/sample.mp4' } } }) } } };
}
async function withFetch(handler, run) {
  const native = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.hostname, path: u.pathname, method: init.method || 'GET', headers: init.headers,
      body: init.body, query: u.searchParams });
    return handler(calls.length - 1, u, init);
  };
  try { return await run(calls); } finally { globalThis.fetch = native; }
}
const emptyOk = (headers) => new Response('', { status: 200, headers });
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

test('empty primary and backup POSTs recover through signed video_tab with the same identity', async () => {
  await withFetch((i) => i < 2 ? emptyOk() : json(model(VID)), async calls => {
    const result = await source.fetchAppPlayUrl(VID, { identity });
    assert.equal(result.url, 'https://v1.qznovelvod.com/sample.mp4');
    assert.deepEqual(calls.map(c => `${c.method} ${c.host}`), [
      'POST api5-normal-sinfonlinea.fqnovel.com', 'POST api5-normal-sinfonlineb.fqnovel.com',
      'GET api5-normal-sinfonlineb.fqnovel.com']);
    assert.equal(calls[2].path, '/reading/bookapi/video_tab/multi_video_model/v1/');
    assert.equal(calls[2].body, undefined);
    assert.equal(calls[2].query.get('video_id'), VID);
    for (const call of calls) for (const key of ['device_id', 'iid', 'cdid'])
      assert.equal(call.query.get(key), identity[key]);
    // Every request is signed on its own; nothing is replayed.
    assert.equal(new Set(calls.map(c => c.headers['x-medusa'])).size, 3);
    assert.equal(calls[1].headers['x-ss-stub'], crypto.createHash('md5').update(calls[1].body).digest('hex').toUpperCase());
  });
});

test('a non-empty primary response does not touch the backup host or video_tab', async () => {
  await withFetch(() => json(model(VID)), async calls => {
    await source.fetchAppPlayUrl(VID, { identity });
    assert.equal(calls.length, 1);
  });
});

test('backup host success stops before video_tab', async () => {
  await withFetch((i) => i === 0 ? emptyOk() : json(model(VID)), async calls => {
    await source.fetchAppPlayUrl(VID, { identity });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].host, 'api5-normal-sinfonlineb.fqnovel.com');
  });
});

test('video_tab must return the exact requested episode', async () => {
  await withFetch((i) => i < 2 ? emptyOk() : json(model('7000000000000000001')), async calls => {
    await assert.rejects(source.fetchAppPlayUrl(VID, { identity }), e => e.code === 'MISSING_MODEL');
    assert.equal(calls.length, 3);
  });
});

test('Retry-After on an empty body ends recovery and exposes the backoff', async () => {
  await withFetch(() => emptyOk({ 'Retry-After': '7' }), async calls => {
    await assert.rejects(source.fetchAppPlayUrl(VID, { identity }),
      e => e.code === 'EMPTY_RESPONSE' && e.retryAfterMs === 7000 && e.emptyResponseCount === 1);
    assert.equal(calls.length, 1);
  });
});

test('three empty bodies report the bounded empty count; refusals are not retried', async () => {
  await withFetch(() => emptyOk(), async calls => {
    await assert.rejects(source.fetchAppPlayUrl(VID, { identity }),
      e => e.code === 'EMPTY_RESPONSE' && e.emptyResponseCount === 3 && e.upstreamStatus === 200);
    assert.equal(calls.length, 3);
  });
  for (const status of [403, 429]) await withFetch(() => new Response('', { status }), async calls => {
    await assert.rejects(source.fetchAppPlayUrl(VID, { identity }), e => e.status === status);
    assert.equal(calls.length, 1, String(status));
  });
});

test('cancellation during recovery stops before the next signed request', async () => {
  const controller = new AbortController();
  await withFetch((i) => { if (i === 1) controller.abort(); return emptyOk(); }, async calls => {
    await assert.rejects(source.fetchAppPlayUrl(VID, { identity, signal: controller.signal }),
      e => e.code === 'ERR_CANCELED');
    assert.equal(calls.length, 2);
  });
});
