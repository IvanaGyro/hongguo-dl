// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideMediaRoute, BVC2_RENDER_MIME } from '../src/media-route.js';
import { normalizeDemand, createDemandTable } from '../src/media-demand.js';

const metadata = (fields = {}) => ({ indexed: true, fragmented: false, fileSize: 4 * 1024 * 1024,
  hasAac: true, ...fields });
const bvc2 = (fields = {}) => decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata(),
  processing: true, typeSupport: { [BVC2_RENDER_MIME]: true,
    'video/mp4; codecs="avc1.42C01F, mp4a.40.2"': true }, ...fields });

test('ByteVC2 render demand uses the AAC-only MSE route', () => {
  const route = bvc2({ render: true });
  assert.equal(route.kind, 'mse');
  assert.equal(route.render, true);
  assert.equal(route.reason, 'bvc2-render');
  assert.equal(route.candidates.mime, BVC2_RENDER_MIME);
});

test('ByteVC2 keeps the H.264 transcode without render or without AAC', () => {
  assert.equal(bvc2().render, undefined);
  assert.equal(bvc2().candidates.mime, 'video/mp4; codecs="avc1.42C01F, mp4a.40.2"');
  const silent = decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata({ hasAac: false }),
    processing: true, typeSupport: { 'video/mp4; codecs="avc1.42C01F"': true }, render: true });
  assert.equal(silent.kind, 'mse');
  assert.equal(silent.render, undefined);
  assert.equal(silent.candidates.mime, 'video/mp4; codecs="avc1.42C01F"');
});

test('render asks for AAC MSE support before routing', () => {
  const route = decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata(),
    processing: true, typeSupport: {}, render: true });
  assert.equal(route.kind, 'pending');
  assert.deepEqual(route.types, [BVC2_RENDER_MIME]);
});

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

test('render falls back to the H.264 transcode when AAC-only MSE is unsupported', () => {
  const route = bvc2({ render: true, typeSupport: { [BVC2_RENDER_MIME]: false,
    'video/mp4; codecs="avc1.42C01F, mp4a.40.2"': true } });
  assert.equal(route.kind, 'mse');
  assert.equal(route.render, undefined);
  assert.equal(route.candidates.mime, 'video/mp4; codecs="avc1.42C01F, mp4a.40.2"');
});
