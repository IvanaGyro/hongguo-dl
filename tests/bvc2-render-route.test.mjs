// SPDX-License-Identifier: GPL-3.0-only
import { test, expect } from 'bun:test';
import { decideMediaRoute, BVC2_RENDER_MIME } from '../src/media-route.js';
import { normalizeDemand, createDemandTable } from '../src/media-demand.js';

const metadata = (fields = {}) => ({ indexed: true, fragmented: false, fileSize: 4 * 1024 * 1024,
  hasAac: true, ...fields });
const bvc2 = (fields = {}) => decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata(),
  processing: true, typeSupport: { [BVC2_RENDER_MIME]: true,
    'video/mp4; codecs="avc1.42C01F, mp4a.40.2"': true }, ...fields });

test('ByteVC2 render demand uses the AAC-only MSE route', () => {
  const route = bvc2({ render: true });
  expect(route.kind).toBe('mse');
  expect(route.render).toBe(true);
  expect(route.reason).toBe('bvc2-render');
  expect(route.candidates.mime).toBe(BVC2_RENDER_MIME);
});

test('ByteVC2 keeps the H.264 transcode without render or without AAC', () => {
  expect(bvc2().render).toBeUndefined();
  expect(bvc2().candidates.mime).toBe('video/mp4; codecs="avc1.42C01F, mp4a.40.2"');
  const silent = decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata({ hasAac: false }),
    processing: true, typeSupport: { 'video/mp4; codecs="avc1.42C01F"': true }, render: true });
  expect(silent.kind).toBe('mse');
  expect(silent.render).toBeUndefined();
  expect(silent.candidates.mime).toBe('video/mp4; codecs="avc1.42C01F"');
});

test('render asks for AAC MSE support before routing', () => {
  const route = decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata(),
    processing: true, typeSupport: {}, render: true });
  expect(route.kind).toBe('pending');
  expect(route.types).toEqual([BVC2_RENDER_MIME]);
});

test('render is a ByteVC2-only demand preference that re-decides the route', () => {
  const base = { id: 'd', source: { url: 'https://cdn.example/a.mp4', bridge: 'bvc2' },
    output: 'playable-media' };
  expect(normalizeDemand({ ...base, revision: 1, render: true }).render).toBe(true);
  expect(normalizeDemand({ ...base, revision: 1, source: { url: base.source.url, bridge: 'cenc',
    key: '0'.repeat(32) }, render: true }).render).toBe(false);
  expect(() => normalizeDemand({ ...base, revision: 1, render: 'yes' })).toThrow();
  const table = createDemandTable();
  table.upsert({ ...base, revision: 1, render: false });
  const changed = table.upsert({ ...base, revision: 2, render: true });
  expect(changed.sourceChanged).toBe(true);
  expect(changed.positionChanged).toBe(true);
});
