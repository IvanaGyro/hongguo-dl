import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpStreamReader } from '../src/http-stream.js';
import { createCencRangeRecovery } from '../src/cenc-range-recovery.js';
import { createMediaTransport } from '../src/media-transport.js';
const data = Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, i) => i % 251);
function response(start, end = data.length, options = {}) {
  let pos = start;
  return new Response(new ReadableStream({
    pull(c) {
      if (options.breakAt && pos >= options.breakAt) return c.error(new Error('PRIVATE_URL'));
      if (pos >= end) return c.close();
      const next = Math.min(pos + 32768, end);
      c.enqueue(data.slice(pos, next)); pos = next;
    }
  }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}`,
    'Content-Length': String(end - start) } });
}
const offset = opts => Number(/^bytes=(\d+)-$/.exec(opts.headers.Range)[1]);
test('many sequential AVIO reads share one direct CDN HTTP response and bounded cache', async () => {
  const calls = [];
  const direct = 'https://cdn.fqnovelvod.com/a', proxy = 'https://worker.example/api/media';
  const transport = createMediaTransport({ directUrl: direct, proxyUrl: proxy,
    fetchImpl: async (url, opts) => { calls.push(url); return response(offset(opts)); } });
  const stream = createHttpStreamReader({ fetchImpl: transport.fetch, url: direct, fileSize: data.length });
  try {
    for (let pos = 0; pos < data.length; pos += 32768)
      assert.deepEqual(await stream.read(pos, 32768), data.slice(pos, pos + 32768));
    assert.deepEqual(calls, [direct]);
    assert(stream.stats.cachedBytes <= 2 * 1024 * 1024);
  } finally { stream.close(); }
});
test('disconnect resumes at the first missing byte and keeps partially received data', async () => {
  const starts = [];
  const recovery = createCencRangeRecovery({ retryInitial: true, wait: async () => {} });
  const stream = createHttpStreamReader({ url: 'private', fileSize: data.length, recovery,
    fetchImpl: async (_, opts) => {
      const start = offset(opts); starts.push(start);
      return response(start, data.length, starts.length === 1 ? { breakAt: 65536 } : {});
    } });
  try {
    assert.deepEqual(await stream.read(0, 131072), data.slice(0, 131072));
    assert.deepEqual(starts, [0, 65536]);
  } finally { stream.close(); }
});
test('rewind within cache reuses response; remote seek opens at requested offset', async () => {
  const starts = [];
  const stream = createHttpStreamReader({ url: 'private', fileSize: data.length,
    fetchImpl: async (_, opts) => { starts.push(offset(opts)); return response(offset(opts)); } });
  try {
    await stream.read(0, 65536); await stream.read(100, 500);
    assert.deepEqual(await stream.read(3000000, 100), data.slice(3000000, 3000100));
    assert.deepEqual(starts, [0, 3000000]);
  } finally { stream.close(); }
});
test('idle backpressure does not expire a healthy persistent response', async () => {
  let calls = 0;
  const stream = createHttpStreamReader({ url: 'private', fileSize: data.length, timeoutMs: 10,
    fetchImpl: async () => { calls++; return response(0); } });
  try {
    await stream.read(0, 32768);
    await new Promise(resolve => setTimeout(resolve, 30));
    await stream.read(32768, 32768);
    assert.equal(calls, 1);
  } finally { stream.close(); }
});
test('active body timeout cancels reader; episode abort interrupts pending headers', async () => {
  let canceled = false;
  const stream = createHttpStreamReader({ url: 'private', fileSize: data.length, timeoutMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), {
      status: 206, headers: { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` } }) });
  await assert.rejects(stream.read(0, 100), { code: 'CENC_RANGE_TIMEOUT' });
  assert(canceled); stream.close();
  const controller = new AbortController();
  const pending = createHttpStreamReader({ url: 'private', fileSize: data.length, signal: controller.signal,
    fetchImpl: () => new Promise(() => {}) });
  const read = pending.read(0, 100); controller.abort();
  await assert.rejects(read, { code: 'CANCELED' });
});
test('wrong range and HTTP 429 are terminal; no signed response text escapes', async () => {
  for (const status of [206, 429]) {
    const stream = createHttpStreamReader({ url: 'PRIVATE', fileSize: data.length,
      fetchImpl: async () => new Response('PRIVATE', { status, headers: { 'Content-Range': 'bytes 1-9/10' } }) });
    await assert.rejects(stream.read(0, 100), { code: status === 429 ? 'CENC_RATE_LIMITED' : 'CENC_RANGE_INVALID' });
    stream.close();
  }
});

test('CDN-capped responses reconnect at their validated boundary', async () => {
  const starts = [];
  const stream = createHttpStreamReader({ url: 'private', fileSize: data.length,
    fetchImpl: async (_, opts) => {
      const start = offset(opts); starts.push(start);
      return response(start, Math.min(start + 65536, data.length));
    } });
  try {
    assert.deepEqual(await stream.read(0, 160000), data.slice(0, 160000));
    assert.deepEqual(starts, [0, 65536, 131072]);
  } finally { stream.close(); }
});
test('changed ETag prevents stitching different media versions', async () => {
  let calls = 0;
  const stream = createHttpStreamReader({ url: 'private', fileSize: data.length,
    fetchImpl: async (_, opts) => {
      const start = offset(opts), res = response(start, start + 65536);
      res.headers.set('etag', 'version-' + ++calls); return res;
    } });
  try { await assert.rejects(stream.read(0, 100000), { code: 'CENC_RANGE_INVALID' }); }
  finally { stream.close(); }
});
