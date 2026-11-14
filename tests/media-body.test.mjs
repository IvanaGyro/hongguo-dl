import test from 'node:test';
import assert from 'node:assert/strict';
import { readMediaBody } from '../src/media-body.js';
const data = Uint8Array.from({ length: 150000 }, (_, i) => i % 251);
const range = (start, end = Math.min(start + 65536, data.length)) => new Response(data.slice(start, end), {
  status: 206, headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}`, 'Content-Length': String(end - start) }
});
const collect = async (response, options) => {
  const chunks = []; for await (const { bytes } of readMediaBody(response, options)) chunks.push(bytes);
  return Buffer.concat(chunks);
};
test('whole-file reads resume capped responses until Content-Range total, not first Content-Length', async () => {
  const starts = [], totals = [];
  const result = await collect(range(0), { url: 'synthetic', maxBytes: 200000,
    onTotal: n => totals.push(n), fetchImpl: async (_, opts) => {
      const start = Number(/^bytes=(\d+)-$/.exec(opts.headers.Range)[1]); starts.push(start); return range(start);
    } });
  assert.deepEqual(result, Buffer.from(data));
  assert.deepEqual(starts, [65536, 131072]);
  assert.deepEqual(totals, [150000, 150000, 150000]);
});
test('reject mismatched resumed offsets, oversized total and access refusal', async () => {
  const options = { url: 'synthetic', maxBytes: 200000 };
  await assert.rejects(collect(range(0), { ...options, fetchImpl: async () => range(0) }), { code: 'MEDIA_RANGE_INVALID' });
  await assert.rejects(collect(range(0), { ...options, maxBytes: 100 }), { code: 'MEMORY_LIMIT' });
  await assert.rejects(collect(range(0), { ...options, fetchImpl: async () => new Response('', { status: 403 }) }), { code: 'MEDIA_SOURCE_FORBIDDEN' });
});
test('ordinary 200 bodies remain supported without a declared length', async () => {
  assert.deepEqual(await collect(new Response(data), { url: 'synthetic', maxBytes: 200000 }), Buffer.from(data));
});
