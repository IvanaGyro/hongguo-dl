// SPDX-License-Identifier: GPL-3.0-only
// Whole-file reads go through the media Worker's source and byte cache:
// request counts and ranges across metadata → streaming → whole-file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMediaWorker } from '../src/media-worker-local.js';
import { createMediaProcessor } from '../src/media-processor.js';
import { readWholeFile, createRetainedSources } from '../src/whole-file-read.js';
import { allowsWholeFileFallback, isProcessingFailure } from '../src/fallback-policy.js';

const KEY = '00112233445566778899aabbccddeeff';
const URL_A = 'https://worker.example/api/media?episode=a';
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
const payload = size => Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251);
const faststart = concat(ftyp, moov, box('mdat', payload(300 * 1024)));
const distant = concat(ftyp, box('mdat', payload(600 * 1024)), moov);

function cdn(bytes, { status = 206, chunk = 16384, delayMs = 0 } = {}) {
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
function fakeRuntime({ fail = false } = {}) {
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

function harness({ bytes = faststart, status, delayMs, failEngine = false, cacheBudget } = {}) {
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

test('a whole-file read continues on the metadata probe response: one request', async () => {
  const h = harness();
  h.need({ id: 'file', revision: 1, output: 'whole-file' });
  await h.until(() => h.wholeFile(), 'whole-file');
  assert.deepEqual(h.network.ranges, ['bytes=0-']);
  assert.deepEqual(new Uint8Array(h.wholeFile().bytes), faststart);
  const progress = h.events.filter(e => e.type === 'whole-file.progress');
  assert.equal(progress.at(-1).received, faststart.length);
  assert.equal(progress.at(-1).total, faststart.length);
  h.worker.terminate();
});

test('a distant moov is not downloaded twice by the whole-file read', async () => {
  const h = harness({ bytes: distant });
  h.need({ id: 'file', revision: 1, output: 'whole-file' });
  await h.until(() => h.wholeFile(), 'whole-file');
  const moovOffset = distant.length - moov.length;
  assert.deepEqual(h.network.ranges, ['bytes=0-', `bytes=${moovOffset}-${distant.length - 1}`]);
  assert.deepEqual(new Uint8Array(h.wholeFile().bytes), distant);
  h.worker.terminate();
});

test('a streaming demand that switches to whole-file reuses its cache: no new request', async () => {
  const h = harness();
  h.need({ id: 'play', revision: 1, output: 'playable-media', codec: 'h264' });
  await h.until(() => h.events.some(e => e.type === 'done'), 'done');
  // The same demand now asks for the complete file, e.g. after a processing failure.
  h.need({ id: 'play', revision: 2, output: 'whole-file' });
  await h.until(() => h.wholeFile(), 'whole-file');
  assert.deepEqual(h.network.ranges, ['bytes=0-'], 'Cached ranges are never requested again');
  assert.deepEqual(new Uint8Array(h.wholeFile().bytes), faststart);
  h.worker.terminate();
});

test('a failed remux keeps the source: the fallback continues where streaming stopped', async () => {
  // A slow CDN keeps the stream mid-file when the engine fails.
  const h = harness({ failEngine: true, delayMs: 2 });
  h.need({ id: 'play', revision: 1, output: 'playable-media', codec: 'h264' });
  await h.until(() => h.events.some(e => e.type === 'error'), 'engine failure');
  assert.equal(h.events.find(e => e.type === 'error').code, 'CENC_REMUX_FAILED');
  h.need({ id: 'play', revision: 2, output: 'whole-file' });
  await h.until(() => h.wholeFile(), 'whole-file');
  assert.deepEqual(new Uint8Array(h.wholeFile().bytes), faststart);
  assert.equal(h.network.ranges[0], 'bytes=0-');
  assert(h.network.ranges.slice(1).every(range => range !== 'bytes=0-'),
    'The fallback never restarts the download from byte 0: ' + h.network.ranges.join(', '));
  h.worker.terminate();
});

test('a whole-file read larger than its limit fails before downloading the body', async () => {
  const h = harness();
  h.need({ id: 'file', revision: 1, output: 'whole-file', maxBytes: 1024 });
  await h.until(() => h.events.some(e => e.type === 'error'), 'error');
  assert.equal(h.events.find(e => e.type === 'error').code, 'MEMORY_LIMIT');
  assert.equal(h.wholeFile(), undefined);
  h.worker.terminate();
});

test('a refused source reports a public error to the whole-file consumer', async () => {
  const h = harness({ status: 403 });
  h.need({ id: 'file', revision: 1, output: 'whole-file' });
  await h.until(() => h.events.some(e => e.type === 'error'), 'error');
  const error = h.events.find(e => e.type === 'error');
  assert.equal(error.code, 'CENC_SOURCE_FORBIDDEN');
  assert.equal(error.status, 403);
  assert.equal(h.network.ranges.length, 1);
  assert(!JSON.stringify(h.events).includes('worker.example'));
  h.worker.terminate();
});

test('withdrawing a whole-file demand stops the read and releases the source', async () => {
  const large = concat(ftyp, moov, box('mdat', payload(3 * 1024 * 1024)));
  const h = harness({ bytes: large, delayMs: 5 });
  h.need({ id: 'file', revision: 1, output: 'whole-file' });
  await h.until(() => h.events.some(e => e.type === 'whole-file.progress'), 'progress');
  h.worker.postMessage({ type: 'dont-need', id: 'file' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const requests = h.network.ranges.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(h.wholeFile(), undefined, 'A withdrawn read never transfers its bytes');
  assert.equal(h.network.ranges.length, requests, 'No new request after the demand was withdrawn');
  assert.equal(h.events.some(e => e.type === 'error'), false);
  h.worker.terminate();
});

test('readWholeFile on a retained Worker continues its source without re-reading the prefix', async () => {
  const network = cdn(faststart);
  const processor = createMediaProcessor({ bridge: 'cenc', fetchImpl: network.fetchImpl });
  processor.onmetadata = () => {};
  processor.need({ source: { url: URL_A, bridge: 'cenc', key: KEY }, output: 'metadata' });
  await new Promise(resolve => { processor.onmetadata = resolve; });
  const progress = [];
  const bytes = await readWholeFile({ processor, maxBytes: 1024 * 1024,
    onProgress: (received, total) => progress.push([received, total]) });
  assert.deepEqual(bytes, faststart);
  assert.equal(network.ranges[0], 'bytes=0-');
  assert(network.ranges.slice(1).every(range => range !== 'bytes=0-'));
  assert.deepEqual(progress.at(-1), [faststart.length, faststart.length]);
});

test('readWholeFile rejects with a cancel error and closes its Worker on abort', async () => {
  const network = cdn(faststart, { delayMs: 10 });
  const controller = new AbortController();
  const pending = readWholeFile({ input: { url: URL_A }, maxBytes: 1024 * 1024,
    signal: controller.signal, fetchImpl: network.fetchImpl });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { code: 'CANCELED' });
});

test('the fallback order moves down only for processing failures', () => {
  for (const code of ['CENC_REMUX_FAILED', 'BVC2_TRANSCODE_FAILED', 'CENC_UNAVAILABLE',
    'HEVC_INIT_UNSUPPORTED', 'EME_UNAVAILABLE', 'FMP4_INDEX_UNAVAILABLE'])
    assert.equal(allowsWholeFileFallback({ code }), true, code);
  for (const code of ['CENC_SOURCE_FORBIDDEN', 'CENC_RATE_LIMITED', 'CENC_RANGE_HTTP',
    'CENC_RANGE_TIMEOUT', 'CENC_RANGE_UNSUPPORTED', 'CENC_SOURCE_SLOW', 'MEDIA_SOURCE_FORBIDDEN',
    'CANCELED', 'PLAYBACK_STEP_LIMIT', 'CENC_METADATA_LIMIT', 'MEMORY_LIMIT'])
    assert.equal(allowsWholeFileFallback({ code }), false, code);
  assert.equal(allowsWholeFileFallback(null), true, 'An unavailable route without an error falls back');
  assert.equal(isProcessingFailure('CENC_SOURCE_FORBIDDEN'), false);
});

test('retained sources hold one Worker per source and close what is not taken', () => {
  const closed = [];
  const worker = name => ({ name, close: options => closed.push([name, options]) });
  const retained = createRetainedSources();
  const a = {}, b = {};
  retained.keep(a, worker('first'));
  retained.keep(b, worker('second'));
  assert.deepEqual(closed, [['first', { discard: true }]], 'Only one retained Worker at a time');
  assert.equal(retained.take(a), null, 'Another source does not take this cache');
  assert.equal(retained.take(b).name, 'second');
  assert.equal(retained.size, 0);
  retained.keep(a, worker('third'));
  retained.clear();
  assert.deepEqual(closed.at(-1), ['third', { discard: true }]);
});

test('a moov over the probe limit still allows a whole-file read; streaming gets the error', async () => {
  // moov box header announcing 9 MiB, over the 8 MiB bounded probe.
  const big = concat(ftyp, Uint8Array.of(0, 0x90, 0, 0), Uint8Array.from('moov', c => c.charCodeAt(0)),
    new Uint8Array(9 * 1024 * 1024 - 8));
  const h = harness({ bytes: big });
  h.need({ id: 'play', revision: 1, output: 'playable-media', codec: 'h264' });
  h.need({ id: 'file', revision: 1, output: 'whole-file' });
  await h.until(() => h.wholeFile() && h.events.some(e => e.type === 'error'), 'whole-file and error');
  const error = h.events.find(e => e.type === 'error');
  assert.equal(error.demand, 'play');
  assert.equal(error.code, 'CENC_METADATA_LIMIT');
  assert.equal(new Uint8Array(h.wholeFile().bytes).length, big.length);
  assert.equal(h.network.ranges[0], 'bytes=0-');
  h.worker.terminate();
});

test('a retained Worker stops processing and read-ahead until its next owner', () => {
  const processor = createMediaProcessor({ bridge: 'cenc', fetchImpl: cdn(faststart).fetchImpl });
  processor.need({ source: { url: URL_A, bridge: 'cenc', key: KEY }, output: 'playable-media',
    codec: 'h264', processing: true, playback: { paused: false, bufferedAheadSeconds: 4, bufferTargetSeconds: 30 } });
  processor.keepSourceOnly();
  assert.equal(processor.demand.output, 'playable-media', 'The demand, and so the source and cache, are kept');
  assert.equal(processor.demand.processing, false);
  assert.deepEqual(processor.demand.playback, { paused: true, bufferedAheadSeconds: 0, bufferTargetSeconds: 0 });
  processor.close({ discard: true });
});
