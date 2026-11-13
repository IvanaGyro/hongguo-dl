// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCencRangeRecovery, waitForRangeRetry } from '../src/cenc-range-recovery.js';

const httpError = code => Object.assign(new Error('fixed status'), { code });

test('an initial 403 does not retry a forbidden source', async () => {
  let count = 0;
  const recovery = createCencRangeRecovery({
    wait: async () => assert.fail('must not wait')
  });
  await assert.rejects(recovery.read(async () => {
    count++;
    throw httpError('CENC_SOURCE_FORBIDDEN');
  }), { code: 'CENC_SOURCE_FORBIDDEN' });
  assert.equal(count, 1);
  assert.equal(recovery.totalRetries, 0);
});

test('an intermittent 403 after a verified Range recovers within a bounded budget', async () => {
  const stages = [];
  let calls = 0;
  const recovery = createCencRangeRecovery({
    maxRetries: 2, wait: async ms => { assert.equal(ms, 900); },
    onRetry: stage => stages.push(stage)
  });
  const read = async () => {
    calls++;
    if ([2, 4, 6].includes(calls)) throw httpError('CENC_SOURCE_FORBIDDEN');
    return new Uint8Array([1, 2]);
  };
  await recovery.read(read);
  await recovery.read(read); // 403 -> 206
  await recovery.read(read); // 403 -> 206
  await assert.rejects(recovery.read(read), { code: 'CENC_SOURCE_FORBIDDEN' });
  assert.equal(calls, 6);
  assert.equal(recovery.totalRetries, 2);
  assert.deepEqual(stages.map(s => s.remaining), [1, 0]);
});

test('429 and invalid ranges are never retried locally', async () => {
  for (const code of ['CENC_RATE_LIMITED', 'CENC_RANGE_INVALID', 'CENC_RANGE_UNSUPPORTED']) {
    const recovery = createCencRangeRecovery({ wait: async () => assert.fail('must not wait') });
    await recovery.read(async () => new Uint8Array([1]));
    await assert.rejects(recovery.read(async () => { throw httpError(code); }), { code });
    assert.equal(recovery.totalRetries, 0);
  }
});

test('waiting for the retry is canceled promptly', async () => {
  const controller = new AbortController();
  const pending = waitForRangeRetry(60000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELED' });
});

test('initial timeout/5xx retries once only when there is no alternate source', async () => {
  for (const error of [httpError('CENC_RANGE_TIMEOUT'),
    Object.assign(httpError('CENC_RANGE_HTTP'), { status: 520 }),
    httpError('CENC_RANGE_HTTP')]) {
    for (const retryInitial of [false, true]) {
      let calls = 0;
      const events = [];
      const recovery = createCencRangeRecovery({ retryInitial, wait: async () => {},
        onRetry: event => events.push(event) });
      await assert.rejects(recovery.read(async () => { calls++; throw error; }), { code: error.code });
      assert.equal(calls, retryInitial ? 2 : 1);
      assert.equal(events.length, retryInitial ? 1 : 0);
      if (retryInitial) assert.equal(events[0].code, error.code);
    }
  }
});

test('midstream timeout and HTTP 520 recover without restarting successful reads', async () => {
  const events = [];
  const recovery = createCencRangeRecovery({ wait: async () => {}, onRetry: e => events.push(e) });
  await recovery.read(async () => new Uint8Array([1]));
  let calls = 0;
  const bytes = await recovery.read(async () => {
    calls++;
    if (calls === 1) throw httpError('CENC_RANGE_TIMEOUT');
    if (calls === 2) throw Object.assign(httpError('CENC_RANGE_HTTP'), { status: 520 });
    return new Uint8Array([2]);
  });
  assert.deepEqual([...bytes], [2]);
  assert.equal(calls, 3);
  assert.deepEqual(events.map(e => e.status), [0, 520]);
  // A successful read does not replenish the lifetime budget.
  await assert.rejects(recovery.read(async () => { throw httpError('CENC_RANGE_TIMEOUT'); }),
    { code: 'CENC_RANGE_TIMEOUT' });
  assert.equal(recovery.totalRetries, 2);
});

test('HTTP 401/404 and rate limiting remain terminal even with initial retry enabled', async () => {
  for (const error of [
    Object.assign(httpError('CENC_RANGE_HTTP'), { status: 401 }),
    Object.assign(httpError('CENC_RANGE_HTTP'), { status: 404 }),
    httpError('CENC_RATE_LIMITED'), httpError('CENC_SOURCE_FORBIDDEN')
  ]) {
    const recovery = createCencRangeRecovery({ retryInitial: true,
      wait: async () => assert.fail('must not wait') });
    await assert.rejects(recovery.read(async () => { throw error; }), { code: error.code });
    assert.equal(recovery.totalRetries, 0);
  }
});
