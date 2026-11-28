import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrossOriginIsolation } from '../../../src/cross-origin-isolation.js';

function scope({ controller = null, isolated = false, stored = null, webdriver = false } = {}) {
  const listeners = {}, session = new Map(stored ? [['hongguo-dl-isolation-reload-v1', stored]] : []);
  const sw = {
    controller, registered: [],
    register(url, options) { this.registered.push([url, options]); return Promise.resolve(); },
    ready: Promise.resolve(),
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  const s = {
    isSecureContext: true, crossOriginIsolated: isolated, reloads: 0,
    navigator: { serviceWorker: sw, webdriver },
    sessionStorage: { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
    location: { reload() { s.reloads++; } },
    addEventListener() {}, listeners, session
  };
  return s;
}

test('an uncontrolled first visit reloads once after the worker takes control', async () => {
  const s = scope();
  const done = startCrossOriginIsolation({ scope: s, base: '/hongguo-dl/', now: () => 100 });
  await new Promise(r => setTimeout(r));
  assert.deepEqual(s.navigator.serviceWorker.registered, [['/hongguo-dl/bulk-download-sw.js', { scope: '/hongguo-dl/' }]]);
  s.listeners.controllerchange();
  assert.equal(await done, true);
  assert.equal(s.reloads, 1);
  assert.equal(s.session.get('hongguo-dl-isolation-reload-v1'), '1');
});

test('never reloads twice, when isolated, late, or under automation', async () => {
  for (const [options, now] of [[{ controller: {}, stored: '1' }, 100], [{ isolated: true }, 100],
    [{ controller: {} }, 9000], [{ controller: {}, webdriver: true }, 100]]) {
    const s = scope(options);
    assert.equal(await startCrossOriginIsolation({ scope: s, now: () => now }), false);
    assert.equal(s.reloads, 0);
  }
});
