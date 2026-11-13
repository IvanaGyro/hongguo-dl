// Same-origin service worker for one-click streamed ZIP downloads. It never
// caches video, never intercepts normal API requests, and never stores media.
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
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith('/__bulk_download__')) return;
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
