import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerArchiveDownload } from '../src/archive-download.js';

async function withFakeServiceWorker(serviceWorker, task) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { serviceWorker }
  });
  Object.defineProperty(globalThis, 'isSecureContext', {
    configurable: true, value: true
  });
  try { return await task(); }
  finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (secureDescriptor) Object.defineProperty(globalThis, 'isSecureContext', secureDescriptor);
    else delete globalThis.isSecureContext;
  }
}
const emptyZip = () => new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); }
});

test('pagehide aborts archive while waiting for SW ready, without fallback', {
  timeout: 3500
}, () => withFakeServiceWorker({
  register: async () => ({}),
  ready: new Promise(() => {}),
  controller: null
}, async () => {
  const controller = new AbortController();
  let fallback = 0;
  const result = triggerArchiveDownload(emptyZip(), 'sample.zip', {
    signal: controller.signal, onFallback: () => fallback++
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(result, error => error.code === 'CANCELED');
  assert.equal(fallback, 0, 'Cancellation may not activate Blob fallback');
}));

test('pagehide aborts SW handshake, releases pending transferred stream', {
  timeout: 3500
}, () => {
  const messages = [];
  const sw = { postMessage(message) { messages.push(message); } };
  return withFakeServiceWorker({
    register: async () => ({}),
    ready: Promise.resolve({}),
    controller: sw
  }, async () => {
    const controller = new AbortController();
    let fallback = 0;
    const result = triggerArchiveDownload(emptyZip(), 'sample.zip', {
      signal: controller.signal, onFallback: () => fallback++
    });
    for (let i = 0; i < 30 && !messages.length; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(messages.length, 1, 'Archive stream must be transferred first');
    assert.equal(typeof messages[0].id, 'string');
    controller.abort();
    await assert.rejects(result, error => error.code === 'CANCELED');
    assert.equal(fallback, 0);
    assert.equal(messages[1]?.cancel, messages[0].id,
      'Cancellation must instruct the service worker to discard pending ZIP');
  });
});
