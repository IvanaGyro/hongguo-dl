// SPDX-License-Identifier: GPL-3.0-only
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideMediaRoute, BVC2_RENDER_MIME } from '../../../src/media-route.js';
import {
  normalizeDemand,
  createDemandTable,
  wantsReadAhead,
  sourceKeyOf
} from '../../../src/media-demand.js';

describe('ByteVC2 render preference', () => {
  const metadata = (fields = {}) => ({ indexed: true, fragmented: false, fileSize: 4 * 1024 * 1024,
    hasAac: true, ...fields });
  const bvc2 = (fields = {}) => decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata(),
    processing: true, typeSupport: { [BVC2_RENDER_MIME]: true,
      'video/mp4; codecs="avc1.42C01F, mp4a.40.2"': true }, ...fields });

  test('render is a ByteVC2-only demand preference that re-decides the route', () => {
    const base = { id: 'd', source: { url: 'https://cdn.example/a.mp4', bridge: 'bvc2' },
      output: 'playable-media' };
    assert.equal(normalizeDemand({ ...base, revision: 1, render: true }).render, true);
    assert.equal(normalizeDemand({ ...base, revision: 1, source: { url: base.source.url, bridge: 'cenc',
      key: '0'.repeat(32) }, render: true }).render, false);
    assert.throws(() => normalizeDemand({ ...base, revision: 1, render: 'yes' }));
    const table = createDemandTable();
    table.upsert({ ...base, revision: 1, render: false });
    const changed = table.upsert({ ...base, revision: 2, render: true });
    assert.equal(changed.sourceChanged, true);
    assert.equal(changed.positionChanged, true);
  });

  test('a repeated seek to the demanded position starts a new output generation', () => {
    const base = { id: 'd', source: { url: 'https://cdn.example/a.mp4', bridge: 'bvc2' },
      output: 'playable-media', positionSeconds: 0 };
    const table = createDemandTable();
    const first = table.upsert({ ...base, revision: 1 }).demand;
    const same = table.upsert({ ...base, revision: 2 });
    assert.equal(same.positionChanged, false);
    assert.equal(same.demand.positionRevision, first.positionRevision);
    const seek = table.upsert({ ...base, revision: 3, seekId: 1 });
    assert.equal(seek.positionChanged, true);
    assert.equal(seek.demand.positionRevision, 3);
    assert.throws(() => normalizeDemand({ ...base, revision: 4, seekId: -1 }));
  });
});

describe('demand table', () => {
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
});
