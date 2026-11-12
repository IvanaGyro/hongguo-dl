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

test('403, 416 and 429 CDN responses fail immediately without reading a media body', async () => {
  for (const status of [403, 416, 429]) {
    let canceled = false, calls = 0;
    const failure = {
      status, headers: new Headers(),
      body: { cancel: async () => { canceled = true; } }
    };
    await assert.rejects(readVerifiedRange(async () => {
      calls++;
      return failure;
    }, '/api/media', 10, 13, 100), new RegExp('status ' + status));
    assert.equal(calls, 1, 'HTTP error should not be silently retried');
    assert.equal(canceled, true, 'Rejected HTTP response must be canceled');
  }
});

test('requesting a Range after AbortSignal cancellation does not consume media', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(readVerifiedRange(async () => {
    calls++;
    return okResponse(new Uint8Array(4));
  }, '/api/media', 10, 13, 100, controller.signal), /Canceled/);
  assert.equal(calls, 0, 'A canceled Range must never call the transport');
});

test('canceling during an outstanding Range body read releases the stream promptly', async () => {
  const controller = new AbortController();
  let canceled = 0;
  let opened;
  const stream = new ReadableStream({
    start() { opened = true; },
    cancel() { canceled++; }
  });
  const pending = readVerifiedRange(async () => {
    assert.equal(opened, true);
    return okResponse(stream);
  }, '/api/media', 10, 13, 100, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /Canceled/);
  assert.equal(canceled, 1);
});

test('fetch and body reader failures cannot expose a signed media URL', async () => {
  const secret = 'https://worker.example/api/media?token=private-and-key=secret';
  let canceled = 0, released = 0;
  for (const phase of ['fetch', 'body']) {
    const transport = async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=10-13');
      if (phase === 'fetch') throw new Error(secret);
      return {
        status: 206,
        headers: new Headers({ 'Content-Range': 'bytes 10-13/100' }),
        body: { getReader: () => ({
          read: async () => { throw new Error(secret); },
          cancel: async () => { canceled++; },
          releaseLock: () => { released++; }
        }) }
      };
    };
    await assert.rejects(readVerifiedRange(transport,
      secret, 10, 13, 100), error => {
      assert.match(error.message, new RegExp('HTTP Range (?:connection|body read) failed'));
      assert.doesNotMatch(error.message, /private|secret|token=|key=|https?:/);
      return true;
    });
  }
  assert.equal(canceled, 1, 'Failed reader must be canceled');
  assert.equal(released, 1, 'Failed reader lock must be released');
});

test('a transport that rejects after abort remains cancellation, not a network error', async () => {
  const controller = new AbortController();
  let signalSeen;
  const pending = readVerifiedRange(async (_url, { signal }) => {
    signalSeen = signal;
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () =>
        reject(new Error('secret signed URL inside aborted fetch')), { once: true });
    });
  }, '/api/media', 10, 13, 100, controller.signal);
  assert.equal(signalSeen, controller.signal);
  controller.abort();
  await assert.rejects(pending, { message: 'Canceled' });
});
