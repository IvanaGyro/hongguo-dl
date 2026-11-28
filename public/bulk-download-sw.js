// Same-origin service worker: (1) one-click streamed ZIP downloads and
// (2) cross-origin isolation for the multi-thread media core. GitHub Pages
// cannot send COOP/COEP headers, so same-origin page, script and WASM
// responses get them here; `credentialless` keeps cross-origin images and
// CDN media (no-cors, no cookies) loading. It never caches anything, never
// touches cross-origin requests (API, CDN) and never stores media.
const pending = new Map();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  // Pagehide/export cancellation can happen after the stream was transferred
  // but before the browser asked for the download URL.
  const canceledId = event.data?.cancel;
  if (canceledId) {
    const stale = pending.get(canceledId);
    if (stale) {
      pending.delete(canceledId);
      void stale.stream.cancel().catch(() => {});
    }
    return;
  }
  const { id, filename, stream } = event.data || {};
  if (!/^[a-f0-9-]{20,}$/.test(String(id)) || !stream || typeof stream.getReader !== 'function')
    return;
  pending.set(id, { filename: String(filename || 'videos.zip'), stream });
  event.ports[0]?.postMessage({ ok: true });
});
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless'
};
async function isolated(request) {
  const response = await fetch(request);
  // Opaque or error responses cannot be re-labelled; pass them through.
  if (!response.status || response.type === 'opaque' || response.type === 'opaqueredirect') return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith('/__bulk_download__')) {
    const request = event.request;
    if (url.origin !== self.location.origin || request.method !== 'GET' ||
        url.pathname.includes('/api/') || request.headers.has('range') ||
        (request.cache === 'only-if-cached' && request.mode !== 'same-origin')) return;
    event.respondWith(isolated(request));
    return;
  }
  const archive = pending.get(url.searchParams.get('id'));
  if (!archive) {
    event.respondWith(new Response('Archive expired', { status: 404 }));
    return;
  }
  pending.delete(url.searchParams.get('id'));
  const safe = archive.filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const encoded = encodeURIComponent(archive.filename);
  event.respondWith(new Response(archive.stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + safe + '"; filename*=UTF-8\'\'' + encoded,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  }));
});
