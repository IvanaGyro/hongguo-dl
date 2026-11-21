// SPDX-License-Identifier: GPL-3.0-only
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMediaWorker } from '../../../src/media-worker-local.js';
import * as fragmentedCenc from '../helpers/fragmented-cenc.mjs';
import * as wholeFileMedia from '../helpers/whole-file-media.mjs';

describe('fragmented CENC passthrough for native EME', () => {
  // Native EME for fragmented CENC: fragment index parsing, route choice and
  // the Worker's passthrough of encrypted fragments from its byte cache.
  const { H264, concat, ftyp, moov, fragments, withSidx, withMfra, noIndex, harness } = fragmentedCenc;

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
});

describe('demands and output', () => {
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
});

describe('whole-file reads', () => {
  // Whole-file reads go through the media Worker's source and byte cache:
  // request counts and ranges across metadata → streaming → whole-file.
  const { box, concat, moov, ftyp, payload, faststart, distant, harness } = wholeFileMedia;

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
});
