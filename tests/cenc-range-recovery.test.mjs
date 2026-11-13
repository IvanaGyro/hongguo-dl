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

test('429, invalid Range and ordinary network failures are never retried locally', async () => {
  for (const code of ['CENC_RATE_LIMITED', 'CENC_RANGE_INVALID', 'CENC_RANGE_HTTP']) {
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
