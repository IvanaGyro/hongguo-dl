// SPDX-License-Identifier: GPL-3.0-only
// Fake CDN, fake WASM runtime and MP4 boxes for whole-file reads through the media Worker.
import { createLocalMediaWorker } from '../../../src/media-worker-local.js';

export const KEY = '00112233445566778899aabbccddeeff';
export const URL_A = 'https://worker.example/api/media?episode=a';
export const box = (name, payload = new Uint8Array(0)) => {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(Array.from(name, c => c.charCodeAt(0)), 4);
  out.set(payload, 8);
  return out;
};
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
export const KID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
export const moov = box('moov', box('trak', box('schi', box('tenc', concat(Uint8Array.of(0, 0, 0, 0, 0, 0, 1, 8), KID)))));
export const ftyp = box('ftyp', new Uint8Array(16));
export const payload = size => Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251);
export const faststart = concat(ftyp, moov, box('mdat', payload(300 * 1024)));
export const distant = concat(ftyp, box('mdat', payload(600 * 1024)), moov);

export function cdn(bytes, { status = 206, chunk = 16384, delayMs = 0 } = {}) {
  const ranges = [];
  const fetchImpl = async (_url, { headers, signal }) => {
    ranges.push(headers.Range);
    if (status !== 206) return new Response(null, { status });
    const [, a, b] = /^bytes=(\d+)-(\d*)$/.exec(headers.Range);
    const start = Number(a), end = b ? Math.min(Number(b), bytes.length - 1) : bytes.length - 1;
    let position = start;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (signal?.aborted || position > end) return controller.close();
        const next = Math.min(end + 1, position + chunk);
        controller.enqueue(bytes.slice(position, next));
        position = next;
      }
    }), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': String(end - start + 1)
    } });
  };
  return { ranges, fetchImpl };
}

// The same stand-in WASM engine as media-worker-core.test.mjs: every AVIO
// read goes through the Worker's byte cache.
export function fakeRuntime({ fail = false } = {}) {
  let hooks;
  const core = {
    _cenc_remux_available: () => 1,
    async ccall(_name, _ret, _types, [fileSize]) {
      await hooks.writeChunk(concat(box('ftyp', new Uint8Array(8)), box('moov', new Uint8Array(8))));
      for (let offset = 0; offset < fileSize; offset += 65536) {
        const bytes = await hooks.readRange(offset, Math.min(65536, fileSize - offset));
        await hooks.writeChunk(concat(box('moof', new Uint8Array(8)), box('mdat', bytes.subarray(0, 16))));
        if (fail && offset >= 131072) throw new Error('synthetic remux failure');
      }
      return 0;
    }
  };
  return async (_bridge, _signal, onStage, runtimeHooks) => { hooks = runtimeHooks; onStage('wasm-start'); return core; };
}

export function harness({ bytes = faststart, status, delayMs, failEngine = false, cacheBudget } = {}) {
  const network = cdn(bytes, { status, delayMs });
  const worker = createLocalMediaWorker({ fetchImpl: network.fetchImpl, origin: 'https://app.example',
    loadRuntime: fakeRuntime({ fail: failEngine }), cacheBudget });
  const events = [], waiters = [];
  worker.onmessage = ({ data }) => {
    events.push(data);
    if (data.type === 'capability-request')
      worker.postMessage({ type: 'capabilities', capabilities: {
        types: Object.fromEntries(data.types.map(type => [type, true])) } });
    if (data.type === 'init' || data.type === 'media') worker.postMessage({ type: 'ack', id: data.id });
    for (const waiter of waiters.splice(0)) waiter();
  };
  const until = async (predicate, label) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label + ': ' +
        JSON.stringify(events.filter(e => e.type !== 'stage').map(e => e.type + (e.code ? ':' + e.code : ''))));
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 20); });
    }
  };
  worker.postMessage({ type: 'capabilities', capabilities: { processing: { cenc: true } } });
  const need = demand => worker.postMessage({ type: 'need', demand: {
    source: { url: URL_A, bridge: 'cenc', key: KEY }, ...demand } });
  const wholeFile = () => events.find(e => e.type === 'whole-file');
  return { worker, events, until, need, network, wholeFile };
}
