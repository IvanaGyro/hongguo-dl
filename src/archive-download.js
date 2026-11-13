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

function assertActive(signal) {
  if (signal?.aborted) throw errorWith('CANCELED', '已取消匯出');
}
// ServiceWorker.ready and registration do not natively accept AbortSignal.
// Ignore their eventual completion after leaving the page.
function awaitActive(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', cancel);
    const cancel = () => { cleanup(); reject(errorWith('CANCELED', '已取消匯出')); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) return cancel();
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); }
    );
  });
}
async function controllerForArchive(signal) {
  const base = import.meta.env?.BASE_URL || '/';
  assertActive(signal);
  await awaitActive(navigator.serviceWorker.register(
    base + 'bulk-download-sw.js', { scope: base }), signal);
  await awaitActive(navigator.serviceWorker.ready, signal);
  assertActive(signal);
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  // An initially uncontrolled document may be claimed by the newly installed
  // service worker without navigation. Do not silently assume a controller.
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      signal?.removeEventListener('abort', cancel);
    };
    const onChange = () => {
      if (navigator.serviceWorker.controller) { cleanup(); resolve(navigator.serviceWorker.controller); }
    };
    const cancel = () => { cleanup(); reject(errorWith('CANCELED', '已取消匯出')); };
    const timer = setTimeout(() => {
      cleanup(); reject(new Error('Service Worker 尚未取得此頁面的控制權'));
    }, 10000);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else onChange();
  });
}
export async function triggerArchiveDownload(stream, filename, { onFallback, signal } = {}) {
  assertActive(signal);
  if ('serviceWorker' in navigator && isSecureContext) {
    let transferred = false, sw = null, id = null;
    let dismissAck = () => {};
    try {
      sw = await controllerForArchive(signal);
      assertActive(signal);
      id = crypto.randomUUID();
      const channel = new MessageChannel();
      // Cancelable SW handshake: abort before the ACK must never click the
      // download anchor or silently switch to the memory-backed ZIP fallback.
      const ack = new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          channel.port1.onmessage = null;
          channel.port1.close();
        };
        dismissAck = cleanup;
        const cancel = () => { cleanup(); reject(errorWith('CANCELED', '已取消匯出')); };
        const timer = setTimeout(() => {
          cleanup(); reject(new Error('Service Worker 沒有回應'));
        }, 10000);
        channel.port1.onmessage = event => {
          cleanup();
          event.data?.ok ? resolve() : reject(new Error('Service Worker 拒絕 ZIP 串流'));
        };
        signal?.addEventListener('abort', cancel, { once: true });
      });
      // No asynchronous gap between the preceding check and postMessage.
      sw.postMessage({ id, filename, stream }, [stream, channel.port2]);
      transferred = true;
      await ack;
      assertActive(signal);
      const base = import.meta.env?.BASE_URL || '/';
      const anchor = document.createElement('a');
      anchor.href = base + '__bulk_download__?id=' + encodeURIComponent(id);
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click(); anchor.remove();
      return { streaming: true };
    } catch (error) {
      dismissAck();
      if (signal?.aborted) {
        // Stream ownership was transferred: discard any pending service-worker
        // entry instead of leaving it available for a stale download click.
        if (transferred && id) {
          try { sw.postMessage({ cancel: id }); } catch { /* SW already stopped */ }
        }
        throw errorWith('CANCELED', '已取消匯出');
      }
      if (transferred) throw errorWith('ARCHIVE_STREAM',
        '串流已交給瀏覽器，但啟動下載失敗：' + error.message);
      // Some browser builds cannot transfer ReadableStream to a service worker.
      onFallback?.(error);
    }
  }
  assertActive(signal);
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await awaitActive(reader.read(), signal);
      if (done) break;
      assertActive(signal);
      total += value.byteLength;
      if (total > FALLBACK_MAX) throw errorWith('MEMORY_LIMIT',
        '此瀏覽器不支援串流 ZIP，記憶體備援限 240 MiB，請改用支援串流下載的瀏覽器');
      parts.push(value);
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  assertActive(signal);
  downloadBlob(new Blob(parts, { type: 'application/zip' }), filename);
  return { streaming: false };
}
