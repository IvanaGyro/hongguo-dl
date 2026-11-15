import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceDeviceRecovery } from '../src/source-device-recovery.js';
import { createPlaybackDeviceStore } from '../src/playback-device.js';
const empty = count => Object.assign(new Error('empty'), { code: 'EMPTY_RESPONSE', status: 502,
  ...(count ? { upstreamStatus: 200, emptyResponseCount: count } : {}) });
const memory = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }; };
function fixture() {
  let serial = 0, fail = false, clock = Date.now();
  const storage = memory(), registrations = [];
  const devices = createPlaybackDeviceStore({ storage, now: () => clock, fetchImpl: async (_url, options) => {
    const { installation } = JSON.parse(options.body); registrations.push(installation);
    if (fail) throw new Error('offline');
    return Response.json({ ...installation, device_id: String(++serial), iid: String(serial + 100), registeredAt: clock });
  } });
  const create = () => createSourceDeviceRecovery({ devices, storage, now: () => clock });
  const options = { apiUrl: 'https://fixture.test/api/source', profile: 'test', onWait() {} };
  return { options, registrations, create, fail(value) { fail = value; }, advance(ms) { clock += ms; } };
}

test('three upstream empty 200s rotate all installation IDs then retry source with persisted identity', async () => {
  const f = fixture(), recovery = f.create(); const seen = [];
  const result = await recovery.request({ ...f.options, run: async identity => {
    seen.push(identity);
    if (seen.length === 1) throw empty(3);
    return 'source';
  } });
  assert.equal(result, 'source'); assert.equal(f.registrations.length, 2);
  for (const field of ['clientId', 'cdid', 'clientudid', 'openudid', 'device_id', 'iid']) assert.notEqual(seen[0][field], seen[1][field]);
  const reloaded = f.create();
  await reloaded.request({ ...f.options, run: async identity => assert.deepEqual(identity, seen[1]) });
  assert.equal(f.registrations.length, 2);
});

test('legacy empty errors count individually and intervening success or nonempty error resets streak', async () => {
  const f = fixture(), recovery = f.create();
  const request = run => recovery.request({ ...f.options, run });
  const bad = async () => { throw empty(); };
  await assert.rejects(request(bad)); await assert.rejects(request(bad));
  await request(async () => 'ok');
  await assert.rejects(request(bad)); await assert.rejects(request(async () => { throw new Error('502'); }));
  await assert.rejects(request(bad)); await assert.rejects(request(bad));
  assert.equal(f.registrations.length, 1);
  let calls = 0;
  assert.equal(await request(async () => { if (!calls++) throw empty(); return 'recovered'; }), 'recovered');
  assert.equal(f.registrations.length, 2);
});

test('three failed registrations persist a one-minute cooldown and resume recovery after it', async () => {
  const f = fixture(); let recovery = f.create(), sourceCalls = 0;
  await recovery.request({ ...f.options, run: async () => 'initial' });
  f.fail(true);
  const request = () => recovery.request({ ...f.options, run: async () => { sourceCalls++; throw empty(3); } });
  await assert.rejects(request(), { code: 'DEVICE_RECOVERY_COOLDOWN', retryAfterMs: 60000 });
  assert.equal(f.registrations.length, 4); assert.equal(sourceCalls, 1);
  recovery = f.create();
  await assert.rejects(request(), { code: 'DEVICE_RECOVERY_COOLDOWN', retryAfterMs: 60000 });
  f.advance(59999);
  await assert.rejects(request(), { retryAfterMs: 1 });
  assert.equal(f.registrations.length, 4); assert.equal(sourceCalls, 1);
  f.advance(1); f.fail(false);
  assert.equal(await recovery.request({ ...f.options, run: async () => 'ok' }), 'ok');
  assert.equal(f.registrations.length, 5);
});

test('concurrent source failures share a single replacement and stale errors cannot rotate it again', async () => {
  const f = fixture(), recovery = f.create(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  await recovery.request({ ...f.options, run: async () => 'initial' });
  const late = recovery.request({ ...f.options, run: async () => { await gate; throw empty(3); } });
  const caught = late.catch(e => e);
  let calls = 0;
  await recovery.request({ ...f.options, run: async () => { if (!calls++) throw empty(3); return 'ok'; } });
  release(); assert.equal((await caught).code, 'EMPTY_RESPONSE');
  assert.equal(f.registrations.length, 2);
});

test('canceling a source request never starts device recovery', async () => {
  const f = fixture(), recovery = f.create(), controller = new AbortController();
  await assert.rejects(recovery.request({ ...f.options, signal: controller.signal, run: async () => {
    controller.abort(); throw empty(3);
  } }), { code: 'CANCELED' });
  assert.equal(f.registrations.length, 1);
});

test('concurrent consumers share all three registration attempts and receive current progress', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const devices = { ensure: async () => ({ clientId: 'old' }), renew: async () => {
    calls++; await gate;
    if (calls < 3) throw new Error('registration failed');
    return { clientId: 'new' };
  } };
  const recovery = createSourceDeviceRecovery({ devices });
  const run = async identity => { if (identity.clientId === 'old') throw empty(3); return 'ok'; };
  const firstStages = [], secondStages = [];
  const first = recovery.request({ apiUrl: 'https://fixture.test', profile: 'test', run,
    onWait: (phase, fields) => firstStages.push([phase, fields.attempt]) });
  const second = recovery.request({ apiUrl: 'https://fixture.test', profile: 'test', run,
    onWait: (phase, fields) => secondStages.push([phase, fields.attempt]) });
  await new Promise(resolve => setTimeout(resolve, 0)); release();
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
  assert.equal(calls, 3);
  for (const stages of [firstStages, secondStages]) assert(stages.some(([phase, attempt]) => phase === 'device-renew' && attempt === 3));
});
