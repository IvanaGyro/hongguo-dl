import test from 'node:test';
import assert from 'node:assert/strict';
import { runBvc2WorkerJob } from '../src/bvc2-job.js';

class StubWorker {
  posted = [];
  terminated = false;
  postMessage(data, transfer) { this.posted.push({ data, transfer }); }
  terminate() { this.terminated = true; }
}
const create = () => {
  const worker = new StubWorker();
  return { worker, createWorker: () => worker };
};

test('ByteVC2 Worker resolves a valid result and disposes its worker', async () => {
  const { worker, createWorker } = create();
  const input = Uint8Array.from([1, 2, 3]);
  const job = runBvc2WorkerJob(input, { createWorker });
  assert.equal(worker.posted.length, 1);
  assert.deepEqual([...new Uint8Array(worker.posted[0].data.bytes)], [1, 2, 3]);
  assert.equal(worker.posted[0].transfer[0], worker.posted[0].data.bytes);
  worker.onmessage({ data: { ok: true, bytes: Uint8Array.from([5, 6]).buffer } });
  assert.deepEqual([...await job], [5, 6]);
  assert.equal(worker.terminated, true);
});

test('subarray input transfers exactly the selected bytes', async () => {
  const { worker, createWorker } = create();
  const source = Uint8Array.from([8, 9, 10, 11]);
  const job = runBvc2WorkerJob(source.subarray(1, 3), { createWorker });
  assert.deepEqual([...new Uint8Array(worker.posted[0].data.bytes)], [9, 10]);
  assert.notEqual(worker.posted[0].data.bytes, source.buffer);
  worker.onmessage({ data: { ok: true, bytes: new Uint8Array([5]).buffer } });
  await job;
});

test('abort during Worker construction never sends data or leaves Worker active', async () => {
  const controller = new AbortController();
  const worker = new StubWorker();
  const task = runBvc2WorkerJob(Uint8Array.of(1), {
    signal: controller.signal,
    createWorker: () => { controller.abort(); return worker; }
  });
  await assert.rejects(task, /已取消/);
  assert.equal(worker.posted.length, 0);
  assert.equal(worker.terminated, true);
});

test('abort after dispatch terminates Worker and ignores late completion', async () => {
  const controller = new AbortController();
  const { worker, createWorker } = create();
  const task = runBvc2WorkerJob(Uint8Array.of(1), {
    signal: controller.signal, createWorker
  });
  controller.abort();
  worker.onmessage({ data: { ok: true, bytes: Uint8Array.of(8).buffer } });
  await assert.rejects(task, /已取消/);
  assert.equal(worker.terminated, true);
});

test('synchronous postMessage exception must terminate Worker', async () => {
  const { worker, createWorker } = create();
  worker.postMessage = () => { throw new Error('DataCloneError: private buffer'); };
  await assert.rejects(runBvc2WorkerJob(Uint8Array.of(1), { createWorker }),
    /無法傳送輸入資料/);
  assert.equal(worker.terminated, true);
});

test('invalid empty output is reported rather than treated as successful video', async () => {
  const { worker, createWorker } = create();
  const task = runBvc2WorkerJob(Uint8Array.of(1), { createWorker });
  worker.onmessage({ data: { ok: true, bytes: new ArrayBuffer(0) } });
  await assert.rejects(task, /無效影片資料/);
  assert.equal(worker.terminated, true);
});

test('failure to construct Worker is converted to a stable error', async () => {
  await assert.rejects(runBvc2WorkerJob(Uint8Array.of(1), {
    createWorker: () => { throw new Error('secret implementation details'); }
  }), /無法建立/);
});
