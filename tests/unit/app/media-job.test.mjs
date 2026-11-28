import test from 'node:test';
import assert from 'node:assert/strict';
import { runMediaWorkerJob } from '../../../src/media-job.js';

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
  const job = runMediaWorkerJob(input, { createWorker });
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
  const job = runMediaWorkerJob(source.subarray(1, 3), { createWorker });
  assert.deepEqual([...new Uint8Array(worker.posted[0].data.bytes)], [9, 10]);
  assert.notEqual(worker.posted[0].data.bytes, source.buffer);
  worker.onmessage({ data: { ok: true, bytes: new Uint8Array([5]).buffer } });
  await job;
});

test('abort during Worker construction never sends data or leaves Worker active', async () => {
  const controller = new AbortController();
  const worker = new StubWorker();
  const task = runMediaWorkerJob(Uint8Array.of(1), {
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
  const task = runMediaWorkerJob(Uint8Array.of(1), {
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
  await assert.rejects(runMediaWorkerJob(Uint8Array.of(1), { createWorker }),
    /無法傳送輸入資料/);
  assert.equal(worker.terminated, true);
});

test('invalid empty output is reported rather than treated as successful video', async () => {
  const { worker, createWorker } = create();
  const task = runMediaWorkerJob(Uint8Array.of(1), { createWorker });
  worker.onmessage({ data: { ok: true, bytes: new ArrayBuffer(0) } });
  await assert.rejects(task, /無效影片資料/);
  assert.equal(worker.terminated, true);
});

test('failure to construct Worker is converted to a stable error', async () => {
  await assert.rejects(runMediaWorkerJob(Uint8Array.of(1), {
    createWorker: () => { throw new Error('secret implementation details'); }
  }), /無法建立/);
});

test('progress events keep the worker alive and preserve requested download encoding', async () => {
  const { worker, createWorker } = create();
  const progress = [];
  const job = runMediaWorkerJob(Uint8Array.of(1), {
    createWorker, request: { mode: 'vvc' }, progress: value => progress.push(value)
  });
  assert.equal(worker.posted[0].data.mode, 'vvc');
  worker.onmessage({ data: { type: 'progress', progress: 0.25 } });
  worker.onmessage({ data: { type: 'progress', progress: NaN } });
  assert.deepEqual(progress, [0.25]);
  assert.equal(worker.terminated, false);
  worker.onmessage({ data: { ok: true, bytes: Uint8Array.of(5).buffer } });
  await job;
  assert.equal(worker.terminated, true);
});

test('ByteVC2 progress phases do not finish a job before valid media arrives', async () => {
  const { worker, createWorker } = create();
  const phases = [];
  const task = runMediaWorkerJob(Uint8Array.of(1), {
    createWorker, onProgress: phase => phases.push(phase)
  });
  worker.onmessage({ data: { type: 'progress', phase: 'wasm-loading' } });
  worker.onmessage({ data: { type: 'progress', phase: 'wasm-ready' } });
  worker.onmessage({ data: { type: 'progress', phase: 'transcoding' } });
  worker.onmessage({ data: { type: 'progress', phase: 'secret-unknown' } });
  worker.onmessage({ data: { type: 'progress', phase: 'finalizing' } });
  assert.deepEqual(phases, ['wasm-loading', 'wasm-ready', 'transcoding', 'finalizing']);
  assert.equal(worker.terminated, false);
  worker.onmessage({ data: { ok: true, bytes: Uint8Array.of(1, 2, 3).buffer } });
  assert.deepEqual([...await task], [1, 2, 3]);
  assert.equal(worker.terminated, true);
});

test('ByteVC2 late progress from a canceled Worker cannot update the UI', async () => {
  const { worker, createWorker } = create();
  const controller = new AbortController();
  const phases = [];
  const task = runMediaWorkerJob(Uint8Array.of(1), {
    signal: controller.signal, createWorker, onProgress: phase => phases.push(phase)
  });
  controller.abort();
  worker.onmessage({ data: { type: 'progress', phase: 'transcoding' } });
  await assert.rejects(task, /已取消/);
  assert.deepEqual(phases, []);
  assert.equal(worker.terminated, true);
});

test('encoder profile is snapshotted in a transferable Worker message', async () => {
  const { worker, createWorker } = create();
  const task = runMediaWorkerJob(Uint8Array.of(1), {
    request: { mode: 'hevc', preset: 'fast', quality: 22, threads: 4 }, createWorker
  });
  assert.equal(worker.posted[0].data.op, 'convert');
  assert.equal(worker.posted[0].data.mode, 'hevc');
  assert.equal(worker.posted[0].data.preset, 'fast');
  assert.equal(worker.posted[0].data.quality, 22);
  assert.equal(worker.posted[0].data.threads, 4);
  worker.onmessage({ data: { ok: true, bytes: Uint8Array.of(9).buffer } });
  await task;
});

test('concat transfers every input buffer in order', async () => {
  const { worker, createWorker } = create();
  const a = Uint8Array.of(1), b = Uint8Array.of(2, 3);
  const task = runMediaWorkerJob([a, b], { createWorker });
  const { data, transfer } = worker.posted[0];
  assert.equal(data.op, 'concat');
  assert.deepEqual(data.inputs.map(x => [...new Uint8Array(x)]), [[1], [2, 3]]);
  assert.deepEqual(transfer, data.inputs);
  worker.onmessage({ data: { ok: true, bytes: Uint8Array.of(7).buffer } });
  assert.deepEqual([...await task], [7]);
});
