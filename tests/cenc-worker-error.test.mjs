import test from 'node:test';
import assert from 'node:assert/strict';

test('CENC Worker reports a setup failure without crashing its error handler', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  let timer;
  try {
    let finish;
    const done = new Promise((resolve, reject) => {
      finish = resolve;
      timer = setTimeout(() => reject(new Error('Worker did not report error')), 1000);
    });
    globalThis.self = { postMessage: finish };
    await import('../src/cenc-remux-worker.js');
    self.onmessage({ data: { type: 'start', fileSize: 0 } });
    assert.deepEqual(await done, { type: 'error', code: 'CENC_REMUX_FAILED', status: 0 });
  } finally {
    clearTimeout(timer);
    if (previous) Object.defineProperty(globalThis, 'self', previous);
    else delete globalThis.self;
  }
});
