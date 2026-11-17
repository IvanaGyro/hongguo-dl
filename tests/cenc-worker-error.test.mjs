import test from 'node:test';
import assert from 'node:assert/strict';

test('CENC Worker reports an invalid demand without crashing its error handler', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  let timer;
  try {
    let finish;
    const done = new Promise((resolve, reject) => {
      finish = resolve;
      timer = setTimeout(() => reject(new Error('Worker did not report error')), 1000);
    });
    globalThis.self = { postMessage: finish, location: { origin: 'https://app.example', href: 'https://app.example/w.js' } };
    await import('../src/cenc-remux-worker.js');
    self.onmessage({ data: { type: 'need', demand: { id: 'a', revision: 1, output: 'playable-media',
      source: { url: 'https://app.example/api/media?x=1', bridge: 'cenc', key: 'not-a-key' } } } });
    assert.deepEqual(await done, { type: 'error', demand: 'a', code: 'CENC_REMUX_FAILED', status: 0 });
  } finally {
    clearTimeout(timer);
    if (previous) Object.defineProperty(globalThis, 'self', previous);
    else delete globalThis.self;
  }
});
