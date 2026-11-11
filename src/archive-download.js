// Streams archives through a same-origin service-worker download response,
// avoiding an O(total-series-size) Blob on browsers without File System Access.
// If transferable streams are unavailable, a strictly capped Blob fallback is
// provided; it is not practical for 60 large episodes on Android Firefox.
import { errorWith } from './logic.js';
const FALLBACK_MAX = 240 * 1024 * 1024;

function downloadBlob(blob, filename) {
  const address = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = address; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(address), 120000);
}

async function controllerForArchive() {
  const base = import.meta.env.BASE_URL || '/';
  const registration = await navigator.serviceWorker.register(base + 'bulk-download-sw.js', { scope: base });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  // An initially uncontrolled document may be claimed by the newly installed
  // service worker without navigation. Do not silently assume a controller.
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', onChange); };
    const onChange = () => {
      if (navigator.serviceWorker.controller) { cleanup(); resolve(navigator.serviceWorker.controller); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Service Worker 尚未取得此頁面的控制權')); }, 10000);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    onChange();
  });
}
export async function triggerArchiveDownload(stream, filename, { onFallback } = {}) {
  if ('serviceWorker' in navigator && isSecureContext) {
    let transferred = false;
    try {
      const sw = await controllerForArchive();
      const id = crypto.randomUUID();
      const channel = new MessageChannel();
      // The transferable-stream check happens before ownership changes.
      const ack = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Service Worker 沒有回應')), 10000);
        channel.port1.onmessage = event => {
          clearTimeout(timer);
          event.data?.ok ? resolve() : reject(new Error('Service Worker 拒絕 ZIP 串流'));
        };
      });
      sw.postMessage({ id, filename, stream }, [stream, channel.port2]);
      transferred = true;
      await ack;
      const base = import.meta.env.BASE_URL || '/';
      const anchor = document.createElement('a');
      anchor.href = base + '__bulk_download__?id=' + encodeURIComponent(id);
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click(); anchor.remove();
      return { streaming: true };
    } catch (e) {
      if (transferred) throw errorWith('ARCHIVE_STREAM', '串流已交給瀏覽器，但啟動下載失敗：' + e.message);
      // Some browser builds cannot transfer ReadableStream to a service worker.
      onFallback?.(e);
    }
  }
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > FALLBACK_MAX) throw errorWith('MEMORY_LIMIT',
        '此瀏覽器不支援串流 ZIP，記憶體備援限 240 MiB，請改用支援串流下載的瀏覽器');
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  downloadBlob(new Blob(parts, { type: 'application/zip' }), filename);
  return { streaming: false };
}
