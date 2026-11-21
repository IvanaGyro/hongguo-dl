// SPDX-License-Identifier: GPL-3.0-only
// Fragmented CENC MP4 fixtures (sidx, mfra, no index), a fake CDN and a media Worker harness.
import { createLocalMediaWorker } from '../../../src/media-worker-local.js';

export const KEY = '00112233445566778899aabbccddeeff';
export const URL_A = 'https://worker.example/api/media?episode=fmp4';
export const H264 = 'video/mp4; codecs="avc1.42E01E"';
export const u32 = value => Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
export const u64 = value => concat(u32(Math.floor(value / 2 ** 32)), u32(value >>> 0));
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
export const box = (name, ...payload) => {
  const body = concat(...payload);
  return concat(u32(8 + body.length), Uint8Array.from(name, c => c.charCodeAt(0)), body);
};
export const full = (name, version, ...payload) => box(name, Uint8Array.of(version, 0, 0, 0), ...payload);
export const KID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
export const TIMESCALE = 1000;
export const trak = trackId => box('trak',
  full('tkhd', 0, u32(0), u32(0), u32(trackId), new Uint8Array(68)),
  box('mdia', full('mdhd', 0, u32(0), u32(0), u32(TIMESCALE), u32(0), new Uint8Array(4)),
    box('schi', box('tenc', Uint8Array.of(0, 0, 0, 0, 0, 0, 1, 8), KID))));
export const ftyp = box('ftyp', new Uint8Array(16));
export const moov = box('moov', trak(1), box('mvex', box('trex', new Uint8Array(24))));
// Four one-second fragments with distinct payloads.
export const fragments = [0, 1, 2, 3].map(i => concat(
  box('moof', full('mfhd', 0, u32(i + 1)), new Uint8Array(32).fill(i)),
  box('mdat', new Uint8Array(20000).fill(10 + i))));

export function sidxFor(firstFragmentOffset) {
  const size = 8 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + fragments.length * 12;
  const firstOffset = firstFragmentOffset - (ftyp.length + moov.length + size);
  return full('sidx', 0, u32(1), u32(TIMESCALE), u32(0), u32(firstOffset), Uint8Array.of(0, 0, 0, fragments.length),
    ...fragments.map(f => concat(u32(f.length), u32(TIMESCALE), u32(0x90000000))));
}
export function withSidx() {
  const sidxSize = 8 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + fragments.length * 12;
  const first = ftyp.length + moov.length + sidxSize;
  return concat(ftyp, moov, sidxFor(first), ...fragments);
}
export function withMfra() {
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
export const noIndex = () => concat(ftyp, moov, ...fragments);

export function cdn(bytes) {
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

export function harness(bytes, { processing = false } = {}) {
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
