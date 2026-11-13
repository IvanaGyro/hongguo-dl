import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedMediaReader } from '../src/cached-media-reader.js';
const data = Uint8Array.from({ length: 512 * 1024 }, (_, i) => i % 251);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
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
