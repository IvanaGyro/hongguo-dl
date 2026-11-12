// SPDX-License-Identifier: GPL-3.0-only
// Optional BVC2-to-H.264 bridge. The heavy Librempeg/x264 work runs in a
// dedicated worker and is never allowed to block Video.js's UI thread.
import { errorWith } from './logic.js';

const CORE = new URL(import.meta.env.BASE_URL + 'bvc2/bvc2-core.wasm', location.href);
let available = null;
export async function bvc2BridgeAvailable() {
  if (typeof Worker !== 'function') return false;
  if (!available) {
    available = fetch(CORE, { method: 'HEAD' })
      .then(response => {
        // Vite/GitHub Pages may return index.html (HTTP 200) for missing
        // assets. Check MIME rather than trusting status alone.
        const mime = response.headers.get('content-type') || '';
        const length = Number(response.headers.get('content-length') || 0);
        return response.ok && /^(application\/wasm|application\/octet-stream)\b/i.test(mime) &&
          length < 32 * 1024 * 1024;
      })
      .catch(() => false);
  }
  return available;
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
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bvc2-worker.js', import.meta.url), { type: 'module' });
    let done = false;
    const finish = (error, output) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(output);
    };
    const abort = () => finish(errorWith('CANCELED', '已取消 ByteVC2 轉碼'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => {
      event.preventDefault();
      finish(errorWith('BVC2_ERROR', 'ByteVC2 WASM Worker 無法載入或執行'));
    };
    worker.onmessage = ({ data }) => {
      if (!data?.ok) finish(errorWith('BVC2_ERROR', data?.error || 'ByteVC2 轉碼失敗'));
      else finish(null, new Uint8Array(data.bytes));
    };
    // Downloaded bytes are owned by this job; transfer rather than clone them.
    // If the caller passed a view, transfer a precise copy, not unrelated data.
    const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes : bytes.slice();
    worker.postMessage({ bytes: input.buffer, key: contentKey || '' }, [input.buffer]);
  });
}
