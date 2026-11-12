import test from 'node:test';
import assert from 'node:assert/strict';
import { readVerifiedRange } from '../src/http-range.js';

const okResponse = (body, headers = {}) => new Response(body, { status: 206, headers: {
  'Content-Range': 'bytes 10-13/100',
  ...headers
} });

test('bounded Range reads exact bytes without requiring Content-Length', async () => {
  let requested = null;
  const result = await readVerifiedRange(async (_url, options) => {
    requested = options.headers.Range;
    return okResponse(new Uint8Array([1, 2, 3, 4]));
  }, '/api/media', 10, 13, 100);
  assert.equal(requested, 'bytes=10-13');
  assert.deepEqual([...result], [1, 2, 3, 4]);
});

test('rejects 200 or incorrect 206 headers', async () => {
  const read = res => readVerifiedRange(async () => res, '/api/media', 10, 13, 100);
  await assert.rejects(read(new Response(new Uint8Array([1]), { status: 200 })),
    /status 200/);
  await assert.rejects(read(okResponse(new Uint8Array(4), {
    'Content-Range': 'bytes 10-14/100'
  })), /Content-Range/);
  await assert.rejects(read(okResponse(new Uint8Array(4), {
    'Content-Length': '6'
  })), /Content-Length/);
});

test('rejects truncated and oversized bodies even without length headers', async () => {
  const read = data => readVerifiedRange(async () => okResponse(data),
    '/api/media', 10, 13, 100);
  await assert.rejects(read(new Uint8Array([1, 2, 3])), /Truncated/);
  await assert.rejects(read(new Uint8Array([1, 2, 3, 4, 5])), /Oversized/);
});

test('rejects invalid, unbounded AVIO requests before fetching', async () => {
  let calls = 0;
  await assert.rejects(readVerifiedRange(async () => { calls++; },
    '/api/media', 0, 1024 * 1024, 2 * 1024 * 1024), /Invalid bounded/);
  assert.equal(calls, 0);
});
