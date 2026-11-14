// SPDX-License-Identifier: GPL-3.0-only
// One-shot ByteVC2 Worker lifecycle; kept independent of Vite/browser globals
// so cancellation, transfer and startup failures can be regression tested.
import { errorWith } from './logic.js';

export function runBvc2WorkerJob(bytes, { contentKey = '', mode = 'h264', progress, onProgress, signal, createWorker }) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = createWorker();
    } catch {
      reject(errorWith('BVC2_ERROR', 'ByteVC2 WASM Worker 無法建立'));
      return;
    }
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
    // An AbortSignal can flip while a Worker is being constructed, after the
    // caller's preflight check but before the listener above was installed.
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.onerror = event => {
      event.preventDefault?.();
      finish(errorWith('BVC2_ERROR', 'ByteVC2 WASM Worker 無法載入或執行'));
    };
    worker.onmessage = ({ data }) => {
      if (done) return;
      if (data?.type === 'progress') {
        if (['wasm-loading', 'wasm-ready', 'config-normalized', 'transcoding', 'finalizing'].includes(data.phase))
          onProgress?.(data.phase);
        if (Number.isFinite(data.progress)) progress?.(Math.max(0, Math.min(1, data.progress)));
        return;
      }
      if (!data?.ok) {
        finish(errorWith('BVC2_ERROR', data?.error || 'ByteVC2 轉碼失敗'));
      } else if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength === 0) {
        finish(errorWith('BVC2_ERROR', 'ByteVC2 Worker 回傳無效影片資料'));
      } else {
        finish(null, new Uint8Array(data.bytes));
      }
    };
    // The current playback/download callers pass newly fetched, job-owned
    // Uint8Arrays. For a view or SharedArrayBuffer, copy exactly its bytes
    // instead of transferring unrelated memory or throwing DataCloneError.
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice();
    try {
      worker.postMessage({ bytes: owned.buffer, key: contentKey, mode }, [owned.buffer]);
    } catch {
      // postMessage can throw synchronously (e.g. structured-clone failure).
      // Always terminate the Worker and detach the abort listener on failure.
      finish(errorWith('BVC2_ERROR', 'ByteVC2 Worker 無法傳送輸入資料'));
    }
  });
}
