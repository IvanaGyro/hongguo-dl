import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemandTable, normalizeDemand, wantsReadAhead, sourceKeyOf } from '../src/media-demand.js';
import { decideMediaRoute, mseCandidates, MAX_REMUX_FILE_BYTES } from '../src/media-route.js';

const KEY = '00112233445566778899aabbccddeeff';
const demand = (fields = {}) => ({
  id: 'a', revision: 1, output: 'playable-media', codec: 'h264',
  source: { url: 'https://worker.example/api/media?x=1', bridge: 'cenc', key: KEY },
  ...fields
});

test('repeated revisions are idempotent and older revisions never supersede newer ones', () => {
  const table = createDemandTable();
  assert.equal(table.upsert(demand()).status, 'created');
  assert.equal(table.upsert(demand()).status, 'unchanged');
  assert.equal(table.upsert(demand({ revision: 3, positionSeconds: 9 })).status, 'updated');
  const stale = table.upsert(demand({ revision: 2, positionSeconds: 1 }));
  assert.equal(stale.status, 'stale');
  assert.equal(table.get('a').positionSeconds, 9);
});

test('position revision only moves when the requested position or source changes', () => {
  const table = createDemandTable();
  table.upsert(demand());
  assert.equal(table.get('a').positionRevision, 1);
  const paused = table.upsert(demand({ revision: 2, playback: { paused: false } }));
  assert.equal(paused.positionChanged, false);
  assert.equal(table.get('a').positionRevision, 1, 'Pause/play is not a seek');
  const seek = table.upsert(demand({ revision: 3, positionSeconds: 42 }));
  assert.equal(seek.positionChanged, true);
  assert.equal(table.get('a').positionRevision, 3);
  const cdn = table.upsert(demand({ revision: 4, positionSeconds: 42,
    source: { url: 'https://worker.example/api/media?x=2', bridge: 'cenc', key: KEY } }));
  assert.equal(cdn.sourceChanged, true);
  assert.equal(table.get('a').positionRevision, 4);
});

test('consumers share a source key; only one playable output per Worker', () => {
  const table = createDemandTable();
  table.upsert(demand());
  table.upsert(demand({ id: 'preview', output: 'metadata', source: { url: demand().source.url, bridge: 'cenc' } }));
  assert.equal(table.sourceKeys().size, 1);
  assert.equal(table.consumers(sourceKeyOf(demand().source)).length, 2);
  assert.throws(() => table.upsert(demand({ id: 'other' })), { code: 'MEDIA_DEMAND_BUSY' });
  table.remove('preview');
  assert.equal(table.consumers(sourceKeyOf(demand().source)).length, 1);
  assert.equal(table.remove('missing'), null);
});

test('invalid demands are rejected without echoing URLs or keys', () => {
  for (const bad of [
    demand({ id: '' }), demand({ revision: -1 }), demand({ output: 'start' }),
    demand({ positionSeconds: Infinity }), demand({ priority: 'urgent' }),
    demand({ source: { url: 'https://cdn.example/a.mp4', bridge: 'cenc', key: 'zz' } }),
    demand({ source: { url: 'https://cdn.example/a.mp4', bridge: 'cenc' } })
  ]) {
    assert.throws(() => normalizeDemand(bad), error => error.code === 'MEDIA_DEMAND_INVALID' &&
      !/cdn\.example|0011223344/.test(error.message));
  }
  // A metadata-only demand needs no decryption key.
  assert.equal(normalizeDemand(demand({ output: 'metadata', source: { url: 'x', bridge: 'cenc' } })).source.key, '');
});

test('pause keeps the demand and reads ahead until the reported buffer target is met', () => {
  const base = normalizeDemand(demand());
  assert.equal(wantsReadAhead(base), false, 'Startup does not speculate before playback');
  assert.equal(wantsReadAhead({ ...base, playback: { paused: false, bufferedAheadSeconds: 90, bufferTargetSeconds: 40 } }), true);
  assert.equal(wantsReadAhead({ ...base, playback: { paused: true, bufferedAheadSeconds: 5, bufferTargetSeconds: 40 } }), true);
  assert.equal(wantsReadAhead({ ...base, playback: { paused: true, bufferedAheadSeconds: 45, bufferTargetSeconds: 40 } }), false);
  assert.equal(wantsReadAhead({ ...base, priority: 'speculative' }), true);
  assert.equal(wantsReadAhead({ ...base, output: 'metadata' }), false);
});

test('route: CENC remux limits and MSE answers stay separate from native EME eligibility', () => {
  const metadata = { indexed: true, fragmented: false, hasKid: true, hasAac: true,
    videoCodec: 'hvc1', hevcCodecString: 'hvc1.2.4.L120.90', fileSize: 1024 };
  const pending = decideMediaRoute({ bridge: 'cenc', codec: 'hevc', metadata, processing: true });
  assert.equal(pending.kind, 'pending');
  assert.deepEqual(pending.types, ['video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"',
    'video/mp4; codecs="hev1.2.4.L120.90, mp4a.40.2"']);
  const types = { [pending.types[0]]: false, [pending.types[1]]: true };
  assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', metadata, processing: true, typeSupport: types }).kind, 'mse');
  const none = { [pending.types[0]]: false, [pending.types[1]]: false };
  assert.deepEqual(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', metadata, processing: true, typeSupport: none }).kind, 'native');
  assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true, typeSupport: types,
    metadata: { ...metadata, fileSize: MAX_REMUX_FILE_BYTES + 1 } }).reason, 'remux-file-limit');
  assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true,
    metadata: { ...metadata, fragmented: true } }).kind, 'native');
  assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true,
    metadata: { ...metadata, hasKid: false } }).reason, 'no-cenc-kid');
  assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'h264', processing: true, metadata }).reason,
    'stsd-declared-codec-mismatch');
  assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: false, metadata }).reason,
    'remux-unavailable');
});

test('route: ByteVC2 needs an indexed progressive source and an H.264 MSE output', () => {
  const metadata = { indexed: true, fragmented: false, hasKid: false, hasAac: false, fileSize: 2048 };
  assert.equal(mseCandidates({ bridge: 'bvc2', codec: 'h264', metadata }).mime, 'video/mp4; codecs="avc1.42C01F"');
  assert.deepEqual(decideMediaRoute({ bridge: 'bvc2', metadata: { ...metadata, indexed: false }, processing: true }),
    { kind: 'error', code: 'BVC2_ERROR', reason: 'bvc2-unindexed' });
  assert.equal(decideMediaRoute({ bridge: 'bvc2', metadata, processing: false }).kind, 'unsupported');
  assert.equal(decideMediaRoute({ bridge: 'bvc2', metadata, processing: true,
    typeSupport: { 'video/mp4; codecs="avc1.42C01F"': true } }).kind, 'mse');
});
