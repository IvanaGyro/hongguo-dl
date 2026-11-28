// SPDX-License-Identifier: GPL-3.0-only
// One-shot media-core Worker lifecycle (conversion or concat). Canceling
// terminates the whole WASM instance and its pthread Workers. Kept free of
// Vite/browser globals so cancellation, transfer and startup failures can be
// regression tested.
import { errorWith } from './logic.js';

export const MEDIA_PHASES = Object.freeze(['wasm-loading', 'wasm-ready', 'config-normalized',
  'transcoding', 'finalizing']);

// Callers pass newly fetched, job-owned Uint8Arrays. For a view or a
// SharedArrayBuffer, copy exactly its bytes instead of transferring
// unrelated memory or throwing DataCloneError.
const owned = bytes => bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength &&
  bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice();

/**
 * `input` is one Uint8Array (op 'convert') or an array of them (op 'concat').
 * `request` holds the transferable job snapshot: op, mode, key, preset,
 * quality, threads. Resolves with the output bytes.
 */
export function runMediaWorkerJob(input, { request = {}, progress, onProgress, signal, createWorker,
  onResult }) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = createWorker();
    } catch {
      reject(errorWith('FFMPEG_ERROR', '媒體處理 WASM Worker 無法建立'));
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
    const abort = () => finish(errorWith('CANCELED', '已取消影片處理'));
    signal?.addEventListener('abort', abort, { once: true });
    // An AbortSignal can flip while a Worker is being constructed, after the
    // caller's preflight check but before the listener above was installed.
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.onerror = event => {
      event.preventDefault?.();
      finish(errorWith('FFMPEG_ERROR', '媒體處理 WASM Worker 無法載入或執行'));
    };
    worker.onmessage = ({ data }) => {
      if (done) return;
      if (data?.type === 'progress') {
        if (MEDIA_PHASES.includes(data.phase)) onProgress?.(data.phase, data);
        if (Number.isFinite(data.progress)) progress?.(Math.max(0, Math.min(1, data.progress)));
        return;
      }
      if (!data?.ok) {
        finish(errorWith('FFMPEG_ERROR', data?.error || '影片處理失敗'));
      } else if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength === 0) {
        finish(errorWith('FFMPEG_ERROR', '媒體處理 Worker 回傳無效影片資料'));
      } else {
        onResult?.({ remuxed: Boolean(data.remuxed), variant: data.variant, threads: data.threads });
        finish(null, new Uint8Array(data.bytes));
      }
    };
    const list = Array.isArray(input) ? input.map(owned) : [owned(input)];
    const message = Array.isArray(input)
      ? { op: 'concat', ...request, inputs: list.map(bytes => bytes.buffer) }
      : { op: 'convert', ...request, bytes: list[0].buffer };
    try {
      worker.postMessage(message, list.map(bytes => bytes.buffer));
    } catch {
      // postMessage can throw synchronously (e.g. structured-clone failure).
      // Always terminate the Worker and detach the abort listener on failure.
      finish(errorWith('FFMPEG_ERROR', '媒體處理 Worker 無法傳送輸入資料'));
    }
  });
}
