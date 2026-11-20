// SPDX-License-Identifier: GPL-3.0-only
// Native EME for fragmented CENC: fragment index parsing, route choice and
// the Worker's passthrough of encrypted fragments from its byte cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMediaWorker } from '../src/media-worker-local.js';
import { parseSidx, parseMfra, trackTimescales, mfraSizeFromMfro, fragmentStartOffset } from '../src/fmp4-index.js';

const KEY = '00112233445566778899aabbccddeeff';
const URL_A = 'https://worker.example/api/media?episode=fmp4';
const H264 = 'video/mp4; codecs="avc1.42E01E"';
const u32 = value => Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
const u64 = value => concat(u32(Math.floor(value / 2 ** 32)), u32(value >>> 0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const box = (name, ...payload) => {
  const body = concat(...payload);
  return concat(u32(8 + body.length), Uint8Array.from(name, c => c.charCodeAt(0)), body);
};
const full = (name, version, ...payload) => box(name, Uint8Array.of(version, 0, 0, 0), ...payload);
const KID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const TIMESCALE = 1000;
const trak = trackId => box('trak',
  full('tkhd', 0, u32(0), u32(0), u32(trackId), new Uint8Array(68)),
  box('mdia', full('mdhd', 0, u32(0), u32(0), u32(TIMESCALE), u32(0), new Uint8Array(4)),
    box('schi', box('tenc', Uint8Array.of(0, 0, 0, 0, 0, 0, 1, 8), KID))));
const ftyp = box('ftyp', new Uint8Array(16));
const moov = box('moov', trak(1), box('mvex', box('trex', new Uint8Array(24))));
// Four one-second fragments with distinct payloads.
const fragments = [0, 1, 2, 3].map(i => concat(
  box('moof', full('mfhd', 0, u32(i + 1)), new Uint8Array(32).fill(i)),
  box('mdat', new Uint8Array(20000).fill(10 + i))));

function sidxFor(firstFragmentOffset) {
  const size = 8 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + fragments.length * 12;
  const firstOffset = firstFragmentOffset - (ftyp.length + moov.length + size);
  return full('sidx', 0, u32(1), u32(TIMESCALE), u32(0), u32(firstOffset), Uint8Array.of(0, 0, 0, fragments.length),
    ...fragments.map(f => concat(u32(f.length), u32(TIMESCALE), u32(0x90000000))));
}
function withSidx() {
  const sidxSize = 8 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + fragments.length * 12;
  const first = ftyp.length + moov.length + sidxSize;
  return concat(ftyp, moov, sidxFor(first), ...fragments);
}
function withMfra() {
  const body = concat(ftyp, moov, ...fragments);
  let offset = ftyp.length + moov.length;
  const entries = fragments.map((f, i) => {
    const entry = concat(u64(i * TIMESCALE), u64(offset), Uint8Array.of(1, 1, 1));
    offset += f.length;
    return entry;
  });
  const tfra = full('tfra', 1, u32(1), u32(0), u32(entries.length), ...entries);
  const mfraSize = 8 + tfra.length + 16;
  return concat(body, box('mfra', tfra, full('mfro', 0, u32(mfraSize))));
}
const noIndex = () => concat(ftyp, moov, ...fragments);

function cdn(bytes) {
  const ranges = [];
  const fetchImpl = async (_url, { headers, signal }) => {
    ranges.push(headers.Range);
    const [, a, b] = /^bytes=(\d+)-(\d*)$/.exec(headers.Range);
    const start = Number(a), end = b ? Math.min(Number(b), bytes.length - 1) : bytes.length - 1;
    let position = start;
    return new Response(new ReadableStream({
      pull(controller) {
        if (signal?.aborted || position > end) return controller.close();
        const next = Math.min(end + 1, position + 16384);
        controller.enqueue(bytes.slice(position, next));
        position = next;
      }
    }), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1)
    } });
  };
  return { ranges, fetchImpl };
}

function harness(bytes, { processing = false } = {}) {
  const network = cdn(bytes);
  const worker = createLocalMediaWorker({ fetchImpl: network.fetchImpl, origin: 'https://app.example' });
  const events = [], waiters = [];
  worker.onmessage = ({ data }) => {
    events.push(data);
    if (data.type === 'capability-request')
      worker.postMessage({ type: 'capabilities', capabilities: {
        types: Object.fromEntries(data.types.map(type => [type, type === H264])) } });
    if (data.type === 'init' || data.type === 'media') worker.postMessage({ type: 'ack', id: data.id });
    for (const waiter of waiters.splice(0)) waiter();
  };
  const until = async (predicate, label) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label + ': ' +
        JSON.stringify(events.map(e => e.type === 'stage' ? e.stage : e.type)));
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 20); });
    }
  };
  worker.postMessage({ type: 'capabilities', capabilities: { processing: { cenc: processing } } });
  const need = demand => worker.postMessage({ type: 'need', demand: {
    output: 'playable-media', codec: 'h264', eme: true,
    source: { url: URL_A, bridge: 'cenc', key: KEY }, ...demand } });
  const units = generation => events.filter(e => ['init', 'media'].includes(e.type) &&
    (generation === undefined || e.generation === generation));
  return { worker, events, until, need, network, units };
}

test('sidx: subsegment offsets, times and the sync start for a seek', () => {
  const file = withSidx();
  const sidxOffset = ftyp.length + moov.length;
  const sidxSize = new DataView(file.buffer, sidxOffset, 4).getUint32(0);
  const index = parseSidx(file.subarray(sidxOffset, sidxOffset + sidxSize), sidxOffset);
  assert.equal(index.entries.length, 4);
  assert.equal(index.entries[0].offset, sidxOffset + sidxSize);
  assert.deepEqual(index.entries.map(e => e.time), [0, 1, 2, 3]);
  assert(index.entries.every(e => e.sap));
  assert.equal(fragmentStartOffset(index, 2.5), index.entries[2].offset);
  assert.equal(fragmentStartOffset(index, 0), index.entries[0].offset);
});

test('mfra: tfra points use each track timescale; mfro locates the box', () => {
  const file = withMfra();
  const size = mfraSizeFromMfro(file.subarray(file.length - 16));
  assert(size > 16);
  const index = parseMfra(file.subarray(file.length - size), trackTimescales(moov));
  const points = index.tracks.get(1);
  assert.deepEqual(points.map(p => p.time), [0, 1, 2, 3]);
  assert.equal(points[0].offset, ftyp.length + moov.length);
  assert.equal(fragmentStartOffset(index, 3.2), points[3].offset);
  assert.equal(mfraSizeFromMfro(new Uint8Array(16)), null);
});

for (const [name, make, extraRequests] of [['sidx', withSidx, 0], ['mfra', withMfra, 2]]) {
  test(`${name}: fragmented CENC passes encrypted fragments through for native EME from the cache`, async () => {
    const file = make();
    const h = harness(file);
    h.need({ id: 'play', revision: 1 });
    await h.until(() => h.events.some(e => e.type === 'done'), 'done');
    const route = h.events.find(e => e.type === 'route').route;
    assert.equal(route.kind, 'eme');
    assert.equal(route.mime, H264);
    const units = h.units();
    assert.deepEqual(new Uint8Array(units[0].bytes), concat(ftyp, moov), 'Init is the source ftyp+moov');
    assert.deepEqual(units.slice(1).map(u => new Uint8Array(u.bytes)), fragments,
      'Media units are the original encrypted moof+mdat fragments');
    assert.equal(h.network.ranges[0], 'bytes=0-');
    // An mfra costs at most two small tail reads (mfro, then mfra) when the
    // tail is not cached yet; nothing else opens another response.
    assert(h.network.ranges.length <= 1 + extraRequests,
      'Only the index probe may add requests: ' + h.network.ranges.join(', '));
    assert(h.events.some(e => e.type === 'stage' && e.stage === 'fmp4.index' && e.kind === name));
    h.worker.terminate();
  });

  test(`${name}: a seek restarts at the sync fragment for the target, with a new init`, async () => {
    const h = harness(make());
    h.need({ id: 'play', revision: 1 });
    await h.until(() => h.events.some(e => e.type === 'done'), 'done');
    const requests = h.network.ranges.length;
    h.need({ id: 'play', revision: 2, positionSeconds: 2.4 });
    await h.until(() => h.events.filter(e => e.type === 'done').length === 2, 'second done');
    const units = h.units(2);
    assert.equal(units[0].type, 'init');
    assert.deepEqual(units.slice(1).map(u => new Uint8Array(u.bytes)), fragments.slice(2));
    assert.equal(h.network.ranges.length, requests, 'A cached seek needs no new request');
    h.worker.terminate();
  });
}

test('no fragment index: without WASM the route is unsupported, with WASM it is remux', async () => {
  const h = harness(noIndex());
  h.need({ id: 'play', revision: 1 });
  await h.until(() => h.events.some(e => e.type === 'route'), 'route');
  assert.equal(h.events.find(e => e.type === 'route').route.reason, 'fmp4-index-unavailable');
  assert.equal(h.units().length, 0);
  h.worker.terminate();
  const remux = harness(noIndex(), { processing: true });
  remux.need({ id: 'play', revision: 1 });
  await remux.until(() => remux.events.some(e => e.type === 'route'), 'route');
  assert.equal(remux.events.find(e => e.type === 'route').route.reason, 'fragmented-remux');
  remux.worker.terminate();
});

test('turning EME off re-decides the route on the same source without a new request', async () => {
  const h = harness(withSidx(), { processing: true });
  h.need({ id: 'play', revision: 1 });
  await h.until(() => h.events.some(e => e.type === 'route'), 'eme route');
  assert.equal(h.events.find(e => e.type === 'route').route.kind, 'eme');
  h.need({ id: 'play', revision: 2, eme: false });
  await h.until(() => h.events.filter(e => e.type === 'route').length === 2, 'second route');
  assert.equal(h.events.filter(e => e.type === 'route')[1].route.reason, 'fragmented-remux');
  assert.deepEqual(h.network.ranges, ['bytes=0-'], 'The re-route keeps the probe response and cache');
  h.worker.terminate();
});
