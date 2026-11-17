import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMediaWorker } from '../src/media-worker-local.js';

const KEY = '00112233445566778899aabbccddeeff';
const URL_A = 'https://worker.example/api/media?episode=a';
const H264 = 'video/mp4; codecs="avc1.42E01E"';
const box = (name, payload = new Uint8Array(0)) => {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(Array.from(name, c => c.charCodeAt(0)), 4);
  out.set(payload, 8);
  return out;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const KID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const moov = box('moov', box('trak', box('schi', box('tenc', concat(Uint8Array.of(0, 0, 0, 0, 0, 0, 1, 8), KID)))));
const ftyp = box('ftyp', new Uint8Array(16));
const payload = size => Uint8Array.from({ length: size }, (_, i) => i % 251);
const faststart = concat(ftyp, moov, box('mdat', payload(300 * 1024)));
// moov beyond the sequential-scan window: needs one bounded distant read.
const distant = concat(ftyp, box('mdat', payload(600 * 1024)), moov);

function cdn(bytes, { status = 206, chunk = 16384 } = {}) {
  const ranges = [];
  const fetchImpl = async (_url, { headers, signal }) => {
    ranges.push(headers.Range);
    if (status !== 206) return new Response(null, { status });
    const [, a, b] = /^bytes=(\d+)-(\d*)$/.exec(headers.Range);
    const start = Number(a), end = b ? Math.min(Number(b), bytes.length - 1) : bytes.length - 1;
    let position = start;
    return new Response(new ReadableStream({
      pull(controller) {
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

// A stand-in for the WASM engine: AVIO reads through the Worker's byte
// cache and writes one fMP4 fragment per 64 KiB read.
function fakeRuntime() {
  const calls = { loads: 0, runs: [], active: 0, maxActive: 0 };
  let hooks;
  const core = {
    _cenc_remux_available: () => 1,
    _cenc_stream_remux_at: () => 0,
    async ccall(name, _ret, _types, [fileSize, , seconds = 0]) {
      calls.runs.push({ name, seconds });
      calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        await hooks.writeChunk(concat(box('ftyp', new Uint8Array(8)), box('moov', new Uint8Array(8))));
        for (let offset = 0; offset < fileSize; offset += 65536) {
          const bytes = await hooks.readRange(offset, Math.min(65536, fileSize - offset));
          await hooks.writeChunk(concat(box('moof', new Uint8Array(8)), box('mdat', bytes.subarray(0, 16))));
        }
        return 0;
      } catch {
        // Like Asyncify, an interrupted call needs time to unwind.
        await new Promise(resolve => setTimeout(resolve, 30));
        return -1;
      } finally { calls.active--; }
    }
  };
  const loadRuntime = async (_bridge, _signal, onStage, runtimeHooks) => {
    calls.loads++; hooks = runtimeHooks; onStage('wasm-start');
    return core;
  };
  return { calls, loadRuntime };
}

function harness({ bytes = faststart, status, ack = true, types = { [H264]: true } } = {}) {
  const network = cdn(bytes, { status });
  const runtime = fakeRuntime();
  const worker = createLocalMediaWorker({ fetchImpl: network.fetchImpl,
    origin: 'https://app.example', loadRuntime: runtime.loadRuntime });
  const events = [], waiters = [];
  worker.onmessage = ({ data }) => {
    events.push(data);
    if (data.type === 'capability-request') {
      worker.postMessage({ type: 'capabilities', capabilities: {
        types: Object.fromEntries(data.types.map(type => [type, Boolean(types[type])])) } });
    }
    if (ack && (data.type === 'init' || data.type === 'media'))
      worker.postMessage({ type: 'ack', id: data.id });
    for (const waiter of waiters.splice(0)) waiter();
  };
  const until = async (predicate, label) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label +
        ': ' + JSON.stringify(events.filter(e => e.type !== 'stage').map(e => e.type)));
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 20); });
    }
  };
  worker.postMessage({ type: 'capabilities', capabilities: { processing: { cenc: true } } });
  const need = demand => worker.postMessage({ type: 'need', demand: {
    output: 'playable-media', codec: 'h264', source: { url: URL_A, bridge: 'cenc', key: KEY }, ...demand } });
  const stages = () => events.filter(e => e.type === 'stage').map(e => e.stage);
  return { worker, events, until, need, network, runtime, stages };
}

test('one bytes=0- response serves metadata, route and first frame in the same Worker', async () => {
  const h = harness();
  h.need({ id: 'play', revision: 1 });
  await h.until(() => h.events.some(e => e.type === 'done'), 'done');
  assert.deepEqual(h.network.ranges, ['bytes=0-'], 'Metadata→WASM must reuse the first response');
  const order = h.events.filter(e => ['metadata', 'route', 'init', 'done'].includes(e.type)).map(e => e.type);
  assert.deepEqual([order[0], order[1], order[2], order.at(-1)], ['metadata', 'route', 'init', 'done']);
  const { metadata } = h.events.find(e => e.type === 'metadata');
  assert.equal(metadata.fileSize, faststart.length);
  assert.equal(metadata.kid, Buffer.from(KID).toString('hex'));
  assert.equal(h.events.find(e => e.type === 'route').route.kind, 'mse');
  assert.equal(h.runtime.calls.loads, 1);
  assert(!JSON.stringify(h.events.filter(e => e.type !== 'init' && e.type !== 'media')).includes(KEY),
    'Worker events never echo the content key');
  h.worker.terminate();
});

test('a distant moov needs one bounded read; WASM continues on the original response', async () => {
  const h = harness({ bytes: distant });
  h.need({ id: 'play', revision: 1 });
  await h.until(() => h.events.some(e => e.type === 'done'), 'done');
  const moovOffset = distant.length - moov.length;
  assert.deepEqual(h.network.ranges, ['bytes=0-', `bytes=${moovOffset}-${distant.length - 1}`]);
  h.worker.terminate();
});

test('metadata-only demands reuse the source without WASM and release the connection', async () => {
  const h = harness();
  h.need({ id: 'preview', revision: 1, output: 'metadata', source: { url: URL_A, bridge: 'cenc' } });
  await h.until(() => h.stages().includes('media.network.released'), 'network release');
  assert.equal(h.events.filter(e => e.type === 'metadata').length, 1);
  assert.equal(h.events.some(e => e.type === 'route'), false);
  assert.equal(h.runtime.calls.loads, 0, 'Metadata must not initialize WASM');
  // A later playable consumer of the same source keeps the cached metadata
  // ranges and reopens only the bytes it still needs.
  h.need({ id: 'play', revision: 1 });
  await h.until(() => h.events.some(e => e.type === 'done'), 'done');
  assert.equal(h.network.ranges.length, 2);
  assert.equal(h.network.ranges[0], 'bytes=0-');
  assert.notEqual(h.network.ranges[1], 'bytes=0-', 'The metadata prefix is not downloaded twice');
  h.worker.terminate();
});

test('multiple demand owners share one source; dropping one keeps the other running', async () => {
  const h = harness({ ack: false });
  h.need({ id: 'preview', revision: 1, output: 'metadata', source: { url: URL_A, bridge: 'cenc' } });
  h.need({ id: 'play', revision: 1 });
  await h.until(() => h.events.some(e => e.type === 'init'), 'init');
  assert.deepEqual(h.events.filter(e => e.type === 'metadata').map(e => e.demand).sort(), ['play', 'preview']);
  h.worker.postMessage({ type: 'dont-need', id: 'preview' });
  for (let i = 0; i < 40 && !h.events.some(e => e.type === 'done'); i++) {
    const unit = h.events.filter(e => e.type === 'init' || e.type === 'media').at(-1);
    h.worker.postMessage({ type: 'ack', id: unit.id });
    await h.until(() => h.events.filter(e => ['init', 'media', 'done'].includes(e.type)).length > i + 1, 'unit');
  }
  assert(h.events.some(e => e.type === 'done'), 'Remaining consumer completes');
  assert.deepEqual(h.network.ranges, ['bytes=0-']);
  h.worker.terminate();
});

test('newer revisions seek in place; stale revisions are ignored', async () => {
  const h = harness({ ack: false });
  h.need({ id: 'play', revision: 1 });
  await h.until(() => h.events.some(e => e.type === 'init'), 'init');
  h.need({ id: 'play', revision: 3, positionSeconds: 20 });
  h.need({ id: 'play', revision: 2, positionSeconds: 5 });
  // Pause/play state is a demand update but not a seek.
  h.need({ id: 'play', revision: 4, positionSeconds: 20, playback: { paused: false } });
  let acked = 0;
  for (let i = 0; i < 80 && !h.events.some(e => e.type === 'done'); i++) {
    const units = h.events.filter(e => (e.type === 'init' || e.type === 'media') && e.generation === 3);
    if (units.length > acked) { h.worker.postMessage({ type: 'ack', id: units.at(-1).id }); acked = units.length; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(h.runtime.calls.runs.map(run => run.seconds), [0, 20]);
  assert.equal(h.events.find(e => e.type === 'done').generation, 3);
  assert.equal(h.runtime.calls.loads, 1, 'Seek reuses the engine');
  const runs = h.events.filter(e => e.type === 'stage' && e.stage === 'seek.run').map(e => e.generation);
  assert.deepEqual(runs, [1, 3]);
  assert(h.stages().includes('media.prefetch'), 'Playback state toggles network read-ahead');
  h.worker.terminate();
});

test('a failed source reports the same public error to every consumer, without URLs', async () => {
  const h = harness({ status: 403 });
  h.need({ id: 'preview', revision: 1, output: 'metadata', source: { url: URL_A, bridge: 'cenc' } });
  h.need({ id: 'play', revision: 1 });
  await h.until(() => h.events.filter(e => e.type === 'error').length === 2, 'errors');
  for (const error of h.events.filter(e => e.type === 'error')) {
    assert.equal(error.code, 'CENC_SOURCE_FORBIDDEN');
    assert.equal(error.status, 403);
  }
  assert.equal(h.network.ranges.length, 1, 'A failed CDN is not reopened by another consumer');
  assert(!JSON.stringify(h.events).includes('worker.example'));
  h.worker.terminate();
});

test('release lends a completed engine but never an interrupted one', async () => {
  const done = harness();
  done.need({ id: 'play', revision: 1 });
  await done.until(() => done.events.some(e => e.type === 'done'), 'done');
  done.worker.postMessage({ type: 'release' });
  await done.until(() => done.events.some(e => e.type === 'idle'), 'idle');
  assert.equal(done.events.find(e => e.type === 'idle').reusable, true);

  const interrupted = harness({ ack: false });
  interrupted.need({ id: 'play', revision: 1 });
  await interrupted.until(() => interrupted.events.some(e => e.type === 'init'), 'init');
  interrupted.worker.postMessage({ type: 'release' });
  await interrupted.until(() => interrupted.events.some(e => e.type === 'idle'), 'idle');
  assert.equal(interrupted.events.find(e => e.type === 'idle').reusable, false);
});

test('speculative demands download while CPU work waits for processing capacity', async () => {
  const h = harness();
  h.need({ id: 'next', revision: 1, priority: 'speculative', processing: false });
  await h.until(() => h.stages().includes('processing.waiting'), 'waiting');
  await h.until(() => h.events.some(e => e.type === 'stage' && e.stage === 'media.cache' && e.complete), 'download');
  assert.equal(h.runtime.calls.loads, 0, 'No WASM before processing is granted');
  h.need({ id: 'next', revision: 2, priority: 'speculative', processing: true });
  await h.until(() => h.events.some(e => e.type === 'done'), 'done');
  assert.equal(h.runtime.calls.loads, 1);
  assert.deepEqual(h.network.ranges, ['bytes=0-']);
  h.worker.terminate();
});

test('a replacing playable demand waits for the previous engine call to unwind', async () => {
  const h = harness({ ack: false });
  h.need({ id: 'first', revision: 1 });
  await h.until(() => h.events.some(e => e.type === 'init'), 'init');
  h.worker.postMessage({ type: 'dont-need', id: 'first' });
  h.need({ id: 'second', revision: 1 });
  let acked = 0;
  for (let i = 0; i < 80 && !h.events.some(e => e.type === 'done'); i++) {
    const units = h.events.filter(e => e.type === 'init' || e.type === 'media');
    if (units.length > acked + 1 || (units.length > 1 && units.length > acked)) {
      h.worker.postMessage({ type: 'ack', id: units.at(-1).id }); acked = units.length;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(h.events.some(e => e.type === 'done'), 'Replacement demand completes');
  assert.equal(h.runtime.calls.runs.length, 2);
  assert.equal(h.runtime.calls.maxActive, 1, 'The shared engine never runs two calls at once');
  assert.equal(h.runtime.calls.loads, 1, 'The unwound engine is reused');
  h.worker.terminate();
});
