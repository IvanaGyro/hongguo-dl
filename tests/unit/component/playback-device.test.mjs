import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { createPlaybackDeviceStore } from '../../../src/playback-device.js';
import worker from '../../../worker/worker.js';

const require = createRequire(import.meta.url);
const { PROFILE, prepareInstallation, installationSession, validateInstallation } = require('../../../worker/vendor/playback-installation.js');
const { fetchAppPlayUrl, signedSearchRequest, signedMetadataRequest, signedAccountRequest } = require('../../../worker/vendor/app-source.js');
const seed = () => ({ profile: PROFILE, clientId: randomUUID(), cdid: randomUUID(), clientudid: randomUUID(),
  openudid: '0123456789abcdef', firstInstallAt: Date.now() });
const registered = value => ({ ...value, device_id: '7123456789012345678', iid: '7987654321098765432', registeredAt: Date.now() });
const storage = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }; };
// Decode the actual registration payload rather than mirroring the header builder.
function registrationHeader(bytes) {
  const salt = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
  const key = createHash('sha512').update(Buffer.concat([createHash('sha512').update(bytes.subarray(6, 38)).digest(), salt])).digest();
  const decipher = createDecipheriv('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32));
  const clear = Buffer.concat([decipher.update(bytes.subarray(38)), decipher.final()]);
  return JSON.parse(gunzipSync(clear.subarray(64))).header;
}

test('browser refresh, concurrent lookups and different episodes reuse one persisted installation', async () => {
  const saved = storage(); let registrations = 0;
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /^https:\/\/(worker|other)\.test\/api\/device$/); registrations++;
    return Response.json(registered(JSON.parse(options.body).installation));
  };
  const browser = createPlaybackDeviceStore({ storage: saved, fetchImpl });
  const [a, b] = await Promise.all([browser.ensure('https://worker.test/api/source?vid=1', PROFILE), browser.ensure('https://worker.test/api/source?vid=2', PROFILE)]);
  assert.deepEqual(a, b); assert.equal(registrations, 1);
  const reloaded = createPlaybackDeviceStore({ storage: saved, fetchImpl });
  assert.deepEqual(await reloaded.ensure('https://worker.test/api/source?vid=3', PROFILE), a);
  assert.equal(registrations, 1);
  const other = await browser.ensure('https://other.test/api/source', PROFILE);
  assert.equal(other.clientId, a.clientId); assert.equal(other.device_id, a.device_id);
  assert.equal(registrations, 1, 'Changing proxy Worker keeps the same installation');
});

test('scheduled update preserves IDs on failure; installation seeds survive initial failure and storage errors', async () => {
  const saved = storage(); let fail = false, observed;
  let clock = Date.now();
  const fetchImpl = async (_url, options) => {
    observed = JSON.parse(options.body).installation;
    if (fail) throw new Error('offline');
    return Response.json({ ...registered(observed), registeredAt: clock });
  };
  const browser = createPlaybackDeviceStore({ storage: saved, fetchImpl, now: () => clock, background: () => false });
  const first = await browser.ensure('https://update.test', PROFILE);
  clock += 7 * 3600000; fail = true;
  assert.deepEqual(await browser.ensure('https://update.test', PROFILE), first);
  assert.equal(observed.device_id, first.device_id);
  const broken = { getItem() { throw new Error('storage blocked'); }, setItem() { throw new Error('storage blocked'); } };
  clock = Date.now();
  const memory = createPlaybackDeviceStore({ storage: broken, fetchImpl });
  await assert.rejects(memory.ensure('https://memory.test', PROFILE), /offline/);
  const seeds = observed; fail = false;
  const recovered = await memory.ensure('https://memory.test', PROFILE);
  for (const field of ['cdid', 'clientudid', 'openudid', 'firstInstallAt']) assert.equal(recovered[field], seeds[field]);
});

test('profile changes update the existing installation without replacing its seeds or registered IDs', async () => {
  const bodies = [], saved = storage();
  const browser = createPlaybackDeviceStore({ storage: saved, fetchImpl: async (_url, options) => {
    const identity = JSON.parse(options.body).installation; bodies.push(identity);
    return Response.json(registered(identity));
  } });
  const first = await browser.ensure('https://profile.test', PROFILE);
  const updated = await browser.ensure('https://another-proxy.test', 'android-next-v1');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(bodies.length, 2);
  for (const field of ['clientId', 'cdid', 'clientudid', 'openudid', 'firstInstallAt', 'device_id', 'iid']) {
    assert.equal(bodies[1][field], first[field]); assert.equal(updated[field], first[field]);
  }
});

test('registration update sends original did/iid and seeds; 6/12 hour scheduling is not expiry', async () => {
  let header, calls = 0;
  const installation = { ...registered(seed()), registeredAt: Date.now() - 7 * 3600000 };
  const register = async (_url, options) => {
    calls++; header = registrationHeader(options.data);
    assert.match(options.headers['User-Agent'], /^com\.phoenix\.read\/74532 /);
    return { device_id_str: installation.device_id, install_id_str: installation.iid };
  };
  assert.equal((await prepareInstallation(installation, register, { background: true })).device_id, installation.device_id);
  assert.equal(calls, 0);
  const [a, b] = await Promise.all([prepareInstallation(installation, register), prepareInstallation(installation, register)]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.equal(header.device_id, installation.device_id); assert.equal(header.install_id, installation.iid);
  assert.equal(header.apk_first_install_time, installation.firstInstallAt);
  assert.equal(header.app_version, '7.4.5.32');
  for (const key of ['version_code', 'update_version_code', 'manifest_version_code']) assert.equal(header[key], 74532);
  for (const key of ['cdid', 'clientudid', 'openudid']) assert.equal(header[key], installation[key]);
});

test('registration refusal stays isolated between browsers', async () => {
  const first = seed(), second = seed(); let calls = 0;
  await assert.rejects(prepareInstallation(first, async () => { throw Object.assign(new Error('denied'), { status: 403 }); }), { code: 'DEVICE_REGISTRATION_FAILED' });
  const result = await prepareInstallation(second, async () => { calls++; return { device_id: '123', install_id: '456' }; });
  assert.equal(calls, 1); assert.equal(result.device_id, '123');
  assert.notEqual(installationSession(first), installationSession(second));
  assert.equal(installationSession(result), installationSession(second));
  assert.throws(() => validateInstallation({ ...seed(), device_id: 123, iid: '456' }), { status: 400 });
});

test('source empty-200 retries retain the same IDs and never register another device', async () => {
  const original = globalThis.fetch; const installation = registered(seed()); const calls = [];
  try {
    globalThis.fetch = async (raw, options) => { const url = new URL(raw); calls.push(url);
      assert.equal(url.searchParams.get('device_id'), installation.device_id);
      assert.equal(url.searchParams.get('iid'), installation.iid);
      assert.equal(url.searchParams.has('clientId'), false);
      assert.equal(url.searchParams.has('registeredAt'), false);
      assert.equal(url.searchParams.get('version_name'), '7.4.5.32');
      for (const key of ['version_code', 'update_version_code']) assert.equal(url.searchParams.get(key), '74532');
      assert.equal(url.searchParams.has('ts'), false);
      assert.equal(new URLSearchParams(url.search).has('_rticket'), true);
      assert.ok(options.headers['x-medusa']);
      assert.ok(options.headers['x-helios']);
      assert.equal(options.headers['x-argus'], undefined);
      if (options.method === 'GET') {
        // Third step: bodyless signed video_tab recovery for the same episode.
        assert.equal(url.pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
        assert.equal(url.searchParams.get('video_id'), '123');
        assert.equal(url.searchParams.get('device_level'), '3');
        assert.equal(options.body, undefined);
      } else {
        assert.equal(url.pathname, '/novel/player/multi_video_model/player/v1');
        assert.equal(url.searchParams.has('video_id'), false);
        assert.equal(JSON.parse(gunzipSync(options.body)).biz_param.device_level, 3);
      }
      assert.match(options.headers['User-Agent'], /^com\.phoenix\.read\/74532 /);
      return new Response('');
    };
    await assert.rejects(fetchAppPlayUrl('123', { identity: installation, session: {} }), {
      code: 'EMPTY_RESPONSE', upstreamStatus: 200, emptyResponseCount: 3 });
    assert.deepEqual(calls.map(url => url.hostname.split('.')[0]), ['api5-normal-sinfonlinea', 'api5-normal-sinfonlineb', 'api5-normal-sinfonlineb']);
    assert.ok(calls.every(url => url.pathname.includes('multi_video_model')));
    const response = await worker.fetch(new Request('https://example.workers.dev/api/source?sid=1&vid=123&channel=app', {
      headers: { 'X-Playback-Device': JSON.stringify(installation) }
    }), {});
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json().then(data => ({ code: data.error.code,
      upstreamStatus: data.error.upstreamStatus, count: data.error.emptyResponseCount })), {
      code: 'EMPTY_RESPONSE', upstreamStatus: 200, count: 3 });
  } finally { globalThis.fetch = original; }
});

test('source variants, registration, search/account/catalogue and media proxy share one Android profile', async () => {
  const original = globalThis.fetch, installation = registered(seed()); let apiUa;
  try {
    globalThis.fetch = async (_raw, options) => {
      apiUa = options.headers['User-Agent'];
      return Response.json({ data: { '123': { video_model: { video_id: 'fixture', video_duration: 4,
        video_list: { main: { main_url: 'https://cdn.fqnovelvod.com/fixture.mp4', codec_type: 'h264', definition: '720p',
          vwidth: 1280, vheight: 720, encrypt: 0 } } } } } });
    };
    const result = await fetchAppPlayUrl('123', { identity: installation });
    assert.equal(result.userAgent, apiUa);
    const { registrationHeader: makeHeader } = require('../../../worker/vendor/device-profile.js');
    const registration = makeHeader();
    for (const signed of [signedSearchRequest({ keyword: 'test', identity: installation }),
      signedMetadataRequest('/reading/bookapi/bookmall/cell/change/v'),
      signedAccountRequest('/reading/user/info/v1/', {}, installation)]) {
      const query = new URL(signed.url).searchParams;
      assert.equal(query.get('version_name'), registration.app_version);
      assert.equal(query.get('version_code'), String(registration.version_code));
      assert.equal(query.get('device_type'), registration.device_model);
      assert.equal(query.get('device_brand'), registration.device_brand);
      assert.equal(query.get('os_version'), registration.os_version);
      assert.equal(query.get('os_api'), String(registration.os_api));
      assert.equal(query.get('dpi'), String(registration.density_dpi));
      assert.equal(signed.headers['User-Agent'], apiUa);
    }
    let mediaUa;
    globalThis.fetch = async (_url, options) => { mediaUa = new Headers(options.headers).get('User-Agent'); return new Response('media'); };
    await worker.fetch(new Request('https://example.workers.dev/api/media?profile=app&url=https%3A%2F%2Fcdn.fqnovelvod.com%2Ffixture.mp4'), {});
    assert.equal(mediaUa, apiUa); assert.match(apiUa, /^com\.phoenix\.read\/74532 /);
  } finally { globalThis.fetch = original; }
});

test('new browser source header and device POST pass CORS; malformed identity is rejected before network', async () => {
  const origin = 'https://ivanagyro.github.io';
  for (const [path, method, headers] of [['device', 'POST', 'content-type'], ['source', 'GET', 'x-playback-device']]) {
    const response = await worker.fetch(new Request('https://example.workers.dev/api/' + path, {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers }
    }), {});
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
  const response = await worker.fetch(new Request('https://example.workers.dev/api/source?sid=1&vid=2&channel=app', {
    headers: { 'X-Playback-Device': JSON.stringify({ profile: PROFILE }) }
  }), {});
  assert.equal(response.status, 400);
});

test('Worker device POST returns reusable state; source requests send those IDs without registering again', async () => {
  const original = globalThis.fetch; let registrations = 0, sources = 0;
  const installation = seed();
  try {
    globalThis.fetch = async (raw, options) => {
      const url = new URL(raw);
      if (url.pathname.includes('device_register')) {
        registrations++;
        assert.equal(registrationHeader(Buffer.from(options.body)).cdid, installation.cdid);
        return Response.json({ device_id_str: '7123456789012345678', install_id_str: '7987654321098765432' });
      }
      sources++;
      assert.equal(url.searchParams.get('device_id'), '7123456789012345678');
      assert.equal(url.searchParams.get('iid'), '7987654321098765432');
      return new Response('limited', { status: 429 });
    };
    const request = () => new Request('https://example.workers.dev/api/device', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installation }) });
    const response = await worker.fetch(request(), {}); assert.equal(response.status, 200);
    const identity = await response.json();
    assert.equal((await worker.fetch(request(), {})).status, 200); assert.equal(registrations, 1);
    for (const vid of ['101', '102']) {
      const source = await worker.fetch(new Request('https://example.workers.dev/api/source?sid=1&channel=app&vid=' + vid,
        { headers: { 'X-Playback-Device': JSON.stringify(identity) } }), {});
      assert.equal(source.status, 429);
    }
    assert.equal(sources, 2); assert.equal(registrations, 1);
  } finally { globalThis.fetch = original; }
});

// A stalled source and explicit refusal must not hold unrelated normal requests.

test('source requests run concurrently without pacing or propagating another request refusal', async () => {
  const original = globalThis.fetch, installation = registered(seed()), session = {};
  let release; const calls = [];
  try {
    globalThis.fetch = async (_raw, options) => {
      const vid = JSON.parse(gunzipSync(options.body)).mixed_video_id_map['1004'][0]; calls.push(vid);
      if (vid === '101') await new Promise(resolve => { release = resolve; });
      return new Response('denied', { status: vid === '101' ? 403 : 429 });
    };
    const slow = fetchAppPlayUrl('101', { identity: installation, session }).catch(error => error.status);
    const quick = fetchAppPlayUrl('102', { identity: installation, session }).catch(error => error.status);
    assert.equal(await quick, 429);
    assert.deepEqual(calls, ['101', '102']);
    release(); assert.equal(await slow, 403);
    assert.equal(await fetchAppPlayUrl('103', { identity: installation, session }).catch(error => error.status), 429);
    assert.deepEqual(calls, ['101', '102', '103']);
  } finally { release?.(); globalThis.fetch = original; }
});

test('scheduled registration can stall while normal source callers immediately reuse the IDs', async () => {
  let clock = Date.now(), release;
  const browser = createPlaybackDeviceStore({ storage: storage(), now: () => clock, fetchImpl: async (_url, options) => {
    const identity = JSON.parse(options.body).installation;
    if (identity.device_id) await new Promise(resolve => { release = resolve; });
    return Response.json({ ...registered(identity), registeredAt: clock });
  } });
  const first = await browser.ensure('https://worker.test', PROFILE);
  clock += 7 * 3600000;
  const second = await browser.ensure('https://worker.test', PROFILE);
  const third = await browser.ensure('https://other-worker.test', PROFILE);
  assert.equal(second.device_id, first.device_id); assert.equal(third.device_id, first.device_id);
  assert.equal(typeof release, 'function'); release();
});

test('Worker forwards each device level into the signed v5 gzip model body', async () => {
  const oldFetch = globalThis.fetch, installation = registered(seed());
  const levels = [];
  try {
    globalThis.fetch = async (raw, options) => {
      const url = new URL(raw);
      assert.equal(url.pathname, '/novel/player/multi_video_model/player/v1');
      assert.equal(url.searchParams.get('device_id'), installation.device_id);
      assert.ok(options.headers['x-medusa']);
      levels.push(JSON.parse(gunzipSync(options.body)).biz_param.device_level);
      return new Response('rate limited', { status: 429 });
    };
    for (const level of ['1', '2', '3']) {
      const response = await worker.fetch(new Request(
        'https://example.workers.dev/api/source?sid=1&vid=123&channel=app&device_level=' + level, {
          headers: { 'X-Playback-Device': JSON.stringify(installation) }
        }), {});
      assert.equal(response.status, 429);
    }
    assert.deepEqual(levels, [1, 2, 3]);
    for (const level of ['0', '4', '1.0', 'NaN']) {
      const response = await worker.fetch(new Request(
        'https://example.workers.dev/api/source?sid=1&vid=123&channel=app&device_level=' + level, {
          headers: { 'X-Playback-Device': JSON.stringify(installation) }
        }), {});
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'INVALID_DEVICE_LEVEL');
    }
    assert.deepEqual(levels, [1, 2, 3], 'invalid tiers never contact upstream');
  } finally { globalThis.fetch = oldFetch; }
});

test('v5 nested data.1004 response resolves only the requested episode', async () => {
  const oldFetch = globalThis.fetch, installation = registered(seed());
  try {
    globalThis.fetch = async () => Response.json({ code: 0, data: { '1004': {
      '123': { video_model: { video_id: 'fixture', video_duration: 4,
        video_list: { main: { main_url: 'https://cdn.fqnovelvod.com/fixture.mp4',
          codec_type: 'h264', definition: '720p', vwidth: 1280, vheight: 720, encrypt: 0 } } } }
    } } });
    const source = await fetchAppPlayUrl('123', { identity: installation, deviceLevel: 2 });
    assert.ok(source.variants?.length || source.url, 'nested model must resolve a video');
  } finally { globalThis.fetch = oldFetch; }
});
