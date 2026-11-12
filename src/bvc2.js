// SPDX-License-Identifier: GPL-3.0-only
// Optional BVC2-to-H.264 bridge. The heavy Librempeg/x264 work runs in a
// dedicated worker and is never allowed to block Video.js's UI thread.
import { errorWith } from './logic.js';
import { runBvc2WorkerJob } from './bvc2-job.js';
import { retryableAvailability } from './retryable-availability.js';

const CORE = new URL(import.meta.env.BASE_URL + 'bvc2/bvc2-core.wasm', location.href);
const MANIFEST = new URL(import.meta.env.BASE_URL + 'bvc2/manifest.json', location.href);
const checkBvc2Assets = retryableAvailability(async () => {
  const [wasm, manifest] = await Promise.all([
    fetch(CORE, { method: 'HEAD' }),
    fetch(MANIFEST, { method: 'HEAD', cache: 'no-store' })
  ]);
  // A 200 SPA fallback is not evidence of a published decoder.
  // Only advertise ByteVC2 when the versioned manifest is deployed too.
  const wasmMime = wasm.headers.get('content-type') || '';
  const manifestMime = manifest.headers.get('content-type') || '';
  const length = Number(wasm.headers.get('content-length') || 0);
  const manifestLength = Number(manifest.headers.get('content-length') || 0);
  return wasm.ok && manifest.ok &&
    /^(application\/wasm|application\/octet-stream)\b/i.test(wasmMime) &&
    /^(application\/json|application\/octet-stream)\b/i.test(manifestMime) &&
    length < 32 * 1024 * 1024 && manifestLength < 4096;
});
export async function bvc2BridgeAvailable() {
  if (typeof Worker !== 'function') return false;
  // A transient 404 during Pages deploy must not persist until page reload.
  return checkBvc2Assets();
}

export function transcodeBvc2(bytes, { contentKey = null, signal } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length)
    return Promise.reject(errorWith('EMPTY_MEDIA', '沒有 ByteVC2 媒體資料'));
  if (contentKey && !/^[0-9a-f]{32}$/i.test(contentKey))
    return Promise.reject(errorWith('INVALID_KEY', 'ByteVC2 解密金鑰不是 128-bit 十六進位'));
  if (bytes.length > 260 * 1024 * 1024)
    return Promise.reject(errorWith('MEMORY_LIMIT', 'ByteVC2 影片超過轉碼上限'));
  if (signal?.aborted)
    return Promise.reject(errorWith('CANCELED', '已取消 ByteVC2 轉碼'));
  return runBvc2WorkerJob(bytes, {
    contentKey, signal,
    createWorker: () => new Worker(new URL('./bvc2-worker.js', import.meta.url),
      { type: 'module' })
  });
}
