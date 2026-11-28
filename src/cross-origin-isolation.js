// SPDX-License-Identifier: GPL-3.0-only
// The multi-thread media core needs SharedArrayBuffer, i.e. a cross-origin
// isolated page. The site's own service worker (bulk-download-sw.js) adds
// COOP/COEP to same-origin responses; a page loaded before it took control
// is reloaded once, early, so a first visit also gets the threaded build.
// Browsers without COEP `credentialless` (e.g. Safari) stay non-isolated
// and use the single-thread build of the same core.
const RELOAD_KEY = 'hongguo-dl-isolation-reload-v1';
const RELOAD_WINDOW_MS = 4000;

export function startCrossOriginIsolation({ scope = globalThis, base = '/', now = () => performance.now() } = {}) {
  const sw = scope.navigator?.serviceWorker;
  if (!sw || !scope.isSecureContext || scope.crossOriginIsolated) return Promise.resolve(false);
  let interacted = false;
  const mark = () => { interacted = true; };
  for (const type of ['pointerdown', 'keydown']) scope.addEventListener?.(type, mark, { once: true, capture: true });
  return sw.register(base + 'bulk-download-sw.js', { scope: base }).then(() => sw.ready).then(() => {
    let reloaded = false;
    try { reloaded = scope.sessionStorage.getItem(RELOAD_KEY) === '1'; } catch { reloaded = true; }
    // Only a page nobody has touched yet; never loop where isolation is
    // unsupported, and never under automation (tests drive the page at once).
    if (reloaded || interacted || scope.navigator.webdriver || now() > RELOAD_WINDOW_MS) return false;
    const reload = () => {
      try { scope.sessionStorage.setItem(RELOAD_KEY, '1'); } catch { return false; }
      scope.location.reload();
      return true;
    };
    if (sw.controller) return reload();
    return new Promise(resolve => {
      sw.addEventListener('controllerchange', () => resolve(!interacted && now() <= RELOAD_WINDOW_MS * 2
        ? reload() : false), { once: true });
    });
  }).catch(() => false);
}
