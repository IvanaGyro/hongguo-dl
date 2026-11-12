import test from 'node:test';
import assert from 'node:assert/strict';
import { retryableAvailability } from '../src/retryable-availability.js';

test('transient missing WASM can be rechecked and success stays memoized', async () => {
  let requests = 0;
  const probe = retryableAvailability(() => ++requests >= 2);
  assert.equal(await probe(), false);
  assert.equal(await probe(), true);
  assert.equal(await probe(), true);
  assert.equal(requests, 2);
});

test('HEAD failures do not permanently disable the decoder', async () => {
  let requests = 0;
  const probe = retryableAvailability(() => {
    if (++requests === 1) throw new Error('temporary CDN 503');
    return true;
  });
  assert.equal(await probe(), false);
  assert.equal(await probe(), true);
  assert.equal(requests, 2);
});

test('concurrent availability checks share a single in-flight request', async () => {
  let requests = 0, finish;
  const probe = retryableAvailability(() => {
    requests++;
    return new Promise(resolve => { finish = resolve; });
  });
  const a = probe(), b = probe(), c = probe();
  assert.equal(a, b);
  assert.equal(b, c);
  await Promise.resolve();
  assert.equal(requests, 1);
  finish(true);
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  assert.equal(await probe(), true);
  assert.equal(requests, 1);
});
