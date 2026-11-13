import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptQueueOnPageHide } from '../src/queue-lifecycle.js';

test('pagehide aborts active downloads, retry timers and bulk export', () => {
  const activeA = new AbortController();
  const activeB = new AbortController();
  const bulk = new AbortController();
  const active = new Map([['a', activeA], ['b', activeB]]);
  const retryTimers = new Map([['r1', 101], ['r2', 102]]);
  const cleared = [];
  const jobs = ['queued', 'resolving', 'downloading', 'processing',
    'retrying', 'failed', 'completed', 'canceled'].map((status, i) =>
    ({ id: String(i), status }));
  const changed = [];
  const count = interruptQueueOnPageHide({
    active, retryTimers, jobs, bulkController: bulk,
    clearTimer: id => cleared.push(id),
    onInterrupted: job => { changed.push(job.id); job.status = 'failed'; }
  });
  assert.equal(count, 5);
  assert.deepEqual(changed, ['0', '1', '2', '3', '4']);
  assert.deepEqual(cleared, [101, 102]);
  assert.equal(retryTimers.size, 0);
  assert(activeA.signal.aborted && activeB.signal.aborted && bulk.signal.aborted);
  assert.deepEqual(jobs.map(job => job.status), [
    'failed', 'failed', 'failed', 'failed', 'failed',
    'failed', 'completed', 'canceled'
  ]);
});

test('pagehide cleanup is idempotent and does not restart pending work', () => {
  const active = new Map();
  const retryTimers = new Map();
  const jobs = [{ status: 'failed' }, { status: 'completed' }];
  let calls = 0;
  const args = {
    active, retryTimers, jobs, bulkController: null,
    onInterrupted: () => calls++
  };
  assert.equal(interruptQueueOnPageHide(args), 0);
  assert.equal(interruptQueueOnPageHide(args), 0);
  assert.equal(calls, 0);
});
