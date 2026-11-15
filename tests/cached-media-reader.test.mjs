import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedMediaReader } from '../src/cached-media-reader.js';
import { createCencRangeRecovery } from '../src/cenc-range-recovery.js';
const data = Uint8Array.from({ length: 512 * 1024 }, (_, i) => i % 251);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('a failed source is unavailable to every consumer without reopening it for a late waiter', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const reader = createCachedMediaReader({ url: 'fixture', fileSize: data.length,
    fetchImpl: async () => { calls++; await gate; return new Response('', { status: 520 }); } });
  try {
    reader.prefetch(true);
    while (!calls) await tick();
    const pending = assert.rejects(reader.read(0, 100), { code: 'CENC_RANGE_HTTP', status: 520 });
    release(); await pending;
    await assert.rejects(reader.read(0, 100), { code: 'CENC_RANGE_HTTP' });
    assert.equal(calls, 1);
  } finally { release(); reader.close(); }
});
function fixture(options = {}) {
  const starts = [];
  const reader = createCachedMediaReader({ url: 'synthetic', fileSize: data.length,
    budget: 1024 * 1024, ...options,
    fetchImpl: async (_, opts) => {
      const start = Number(/^bytes=(\d+)-$/.exec(opts.headers.Range)[1]); starts.push(start);
      let position = start;
      return new Response(new ReadableStream({ pull(c) {
        if (position === data.length) return c.close();
        const end = Math.min(position + 32768, data.length);
        c.enqueue(data.slice(position, end)); position = end;
      } }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } });
    }
  });
  return { reader, starts };
}
test('separate raw prefetch completes while remux is idle; forward/back seeks need zero HTTP', async () => {
  const { reader, starts } = fixture();
  try {
    await reader.read(0, 32768); reader.prefetch(true);
    for (let i = 0; i < 100 && !reader.snapshot().complete; i++) await tick();
    assert(reader.snapshot().complete);
    const before = starts.length;
    assert.deepEqual(await reader.read(400000, 1000), data.slice(400000, 401000));
    assert.deepEqual(await reader.read(120000, 1000), data.slice(120000, 121000));
    assert.equal(starts.length, before);
    assert.equal(before, 1);
  } finally { reader.close(); }
});
test('metadata seed is reused and only missing bytes are fetched', async () => {
  const { reader, starts } = fixture({ initialRanges: [{ offset: 0, data: data.slice(0, 65536) }] });
  try {
    assert.deepEqual(await reader.read(0, 32768), data.slice(0, 32768));
    assert.equal(starts.length, 0);
    await reader.read(65536, 32768);
    assert.deepEqual(starts, [65536]);
  } finally { reader.close(); }
});
test('canceling a demux generation leaves downloaded bytes reusable by its successor', async () => {
  const { reader, starts } = fixture();
  try {
    await reader.read(0, 32768);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(reader.read(200000, 100, controller.signal), { code: 'CANCELED' });
    assert.deepEqual(await reader.read(0, 100), data.slice(0, 100));
    assert.equal(starts.length, 1);
  } finally { reader.close(); }
});
test('pause disables raw prefetch without discarding its byte cache', async () => {
  const { reader, starts } = fixture();
  try {
    await reader.read(0, 32768);
    reader.prefetch(true); reader.prefetch(false);
    await tick(); const bytes = reader.snapshot().downloadedBytes;
    await tick(); await tick();
    assert.equal(reader.snapshot().downloadedBytes, bytes);
    assert.deepEqual(await reader.read(0, 100), data.slice(0, 100));
    assert.equal(starts.length, 1);
  } finally { reader.close(); }
});

test('a whole short-episode packet enters sparse cache directly and survives backward seek', async () => {
  const size = 10 * 1024 * 1024;
  const bytes = new Uint8Array(size).fill(43);
  let calls = 0;
  const reader = createCachedMediaReader({ url: 'synthetic', fileSize: size,
    budget: 16 * 1024 * 1024, fetchImpl: async () => {
      calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), { status: 206,
        headers: { 'Content-Range': `bytes 0-${size - 1}/${size}` } });
    } });
  try {
    assert.equal((await reader.read(0, 100))[0], 43);
    assert(reader.snapshot().complete);
    assert.equal((await reader.read(size - 100, 100))[0], 43);
    assert.equal((await reader.read(100000, 100))[0], 43);
    assert.equal(calls, 1);
    assert(reader.snapshot().allocatedBytes <= 16 * 1024 * 1024);
  } finally { reader.close(); }
});

test('capped CDN responses reconnect at exact gaps without consuming retry budget', async () => {
  const starts = [];
  const reader = createCachedMediaReader({ url: 'synthetic', fileSize: data.length,
    fetchImpl: async (_, options) => {
      const start = Number(/^bytes=(\d+)-$/.exec(options.headers.Range)[1]);
      const end = Math.min(start + 65536, data.length); starts.push(start);
      return new Response(data.slice(start, end), { status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` } });
    } });
  try {
    assert.deepEqual(await reader.read(0, 160000), data.slice(0, 160000));
    assert.deepEqual(starts, [0, 65536, 131072]);
  } finally { reader.close(); }
});

test('background HTTP packets preserve normalized metadata overlays at EOF', async () => {
  const offset = data.length - 600;
  const normalized = new Uint8Array(400).fill(253);
  const { reader, starts } = fixture({ initialRanges: [{ offset, data: normalized }] });
  try {
    reader.prefetch(true);
    for (let i = 0; i < 100 && !reader.snapshot().complete; i++) await tick();
    assert(reader.snapshot().complete);
    assert.deepEqual(await reader.read(offset, normalized.length), normalized,
      'Downloading original moov bytes must not undo codec normalization');
    assert.deepEqual(await reader.read(offset - 100, 100), data.slice(offset - 100, offset));
    assert.deepEqual(await reader.read(offset + 400, 100), data.slice(offset + 400, offset + 500));
    assert.equal(starts.length, 1, 'A single overlapping HTTP response is sufficient');
  } finally { reader.close(); }
});

test('a demanded seek interrupts stalled speculative headers without losing cached metadata', async () => {
  const starts = [];
  let canceled = false;
  const reader = createCachedMediaReader({ url: 'synthetic', fileSize: data.length,
    timeoutMs: 2000, initialRanges: [{ offset: 0, data: data.slice(0, 100) }],
    fetchImpl: async (_, options) => {
      const start = Number(/^bytes=(\d+)-$/.exec(options.headers.Range)[1]); starts.push(start);
      if (starts.length === 1) {
        options.signal.addEventListener('abort', () => { canceled = true; });
        return new Promise(() => {}); // An adapter need not honor AbortSignal.
      }
      return new Response(data.slice(start), { status: 206,
        headers: { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } });
    }
  });
  let deadline;
  try {
    reader.prefetch(true);
    for (let i = 0; i < 100 && !starts.length; i++) await tick();
    const result = await Promise.race([reader.read(400000, 1000), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Speculation blocked the demanded seek')), 500);
    })]);
    assert.deepEqual(result, data.slice(400000, 401000));
    assert(canceled);
    assert.deepEqual(await reader.read(0, 100), data.slice(0, 100));
  } finally { clearTimeout(deadline); reader.close(); }
});

test('a source timeout fails subsequent missing-byte reads without spending retry budget', async () => {
  let calls = 0, stopped = false;
  const recovery = createCencRangeRecovery({ maxRetries: 1, wait: async () => {} });
  const reader = createCachedMediaReader({ url: 'synthetic', fileSize: data.length,
    timeoutMs: 20, recovery,
    onStage: stage => { if (stage === 'media.prefetch.stopped') stopped = true; },
    fetchImpl: async (_, options) => {
      const start = Number(/^bytes=(\d+)-$/.exec(options.headers.Range)[1]);
      calls++;
      if (calls === 2) return new Response('', { status: 503 });
      if (calls === 1) return new Response(new ReadableStream({
        start(c) { c.enqueue(data.slice(0, 32768)); }
      }), { status: 206, headers: { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` } });
      return new Response(data.slice(start), { status: 206,
        headers: { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } });
    }
  });
  try {
    await reader.read(0, 100);
    reader.prefetch(true);
    for (let i = 0; i < 100 && !stopped; i++) await tick();
    assert(stopped);
    assert.equal(recovery.totalRetries, 0);
    await assert.rejects(reader.read(32768, 100), { code: 'CENC_RANGE_TIMEOUT' });
    assert.equal(recovery.totalRetries, 0);
    assert.equal(calls, 1);
    assert.deepEqual(await reader.read(0, 100), data.slice(0, 100), 'Existing cached bytes remain readable');
  } finally { reader.close(); }
});

test('a fast persistent body can reach a later requested offset without another HTTP request', async () => {
  const { reader, starts } = fixture();
  try {
    await reader.read(0, 100);
    assert.deepEqual(await reader.read(400000, 1000), data.slice(400000, 401000));
    assert.equal(starts.length, 1);
  } finally { reader.close(); }
});

test('a late missing-byte request sees the same failed source without a second HTTP attempt', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const recovery = createCencRangeRecovery({ maxRetries: 1, retryInitial: true, wait: async () => {} });
  const reader = createCachedMediaReader({ url: 'synthetic', fileSize: data.length, recovery,
    fetchImpl: async (_, options) => {
      const start = Number(/^bytes=(\d+)-$/.exec(options.headers.Range)[1]);
      calls++;
      if (calls === 1) { await gate; return new Response('', { status: 520 }); }
      if (calls === 2) return new Response('', { status: 503 });
      return new Response(data.slice(start), { status: 206,
        headers: { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } });
    }
  });
  try {
    reader.prefetch(true);
    for (let i = 0; i < 100 && !calls; i++) await tick();
    const pending = assert.rejects(reader.read(0, 100), { code: 'CENC_RANGE_HTTP', status: 520 });
    release();
    await pending;
    assert.equal(calls, 1);
    assert.equal(recovery.totalRetries, 0);
  } finally { release(); reader.close(); }
});

test('one episode stalled in headers does not queue or cancel another episode download', async () => {
  let blockedCalls = 0;
  const blocked = createCachedMediaReader({ url: 'episode-a', fileSize: data.length,
    fetchImpl: () => { blockedCalls++; return new Promise(() => {}); } });
  const { reader, starts } = fixture();
  try {
    blocked.prefetch(true);
    reader.prefetch(true);
    for (let i = 0; i < 100 && !reader.snapshot().complete; i++) await tick();
    assert.equal(blockedCalls, 1);
    assert(reader.snapshot().complete, 'Independent episodes must download concurrently');
    blocked.close();
    assert.deepEqual(await reader.read(400000, 1000), data.slice(400000, 401000));
    assert.equal(starts.length, 1);
  } finally { blocked.close(); reader.close(); }
});

test('a partly cached request waits at its missing byte without reopening the current body', async () => {
  let calls = 0, release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const reader = createCachedMediaReader({ url: 'synthetic', fileSize: data.length,
    fetchImpl: async (_, options) => {
      calls++;
      const start = Number(/^bytes=(\d+)-$/.exec(options.headers.Range)[1]);
      let position = start;
      return new Response(new ReadableStream({ async pull(c) {
        reads++;
        if (position >= 20) await gate;
        if (position === data.length) return c.close();
        const end = position < 20 ? 20 : data.length;
        c.enqueue(data.slice(position, end)); position = end;
      } }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } });
    }
  });
  try {
    reader.prefetch(true);
    for (let i = 0; i < 100 && reads < 2; i++) await tick();
    const pending = reader.read(16, 16);
    await tick(); release();
    assert.deepEqual(await pending, data.slice(16, 32));
    assert.equal(calls, 1, 'Use the first missing position, not the already cached prefix');
  } finally { release(); reader.close(); }
});
