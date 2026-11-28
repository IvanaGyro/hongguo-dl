// SPDX-License-Identifier: GPL-3.0-only
// Whole-file conversion and lossless concat on the unified Librempeg media
// core. Each job owns a dedicated Worker (and its pthreads), so canceling
// stops the encoder immediately. Replaces FFmpeg.wasm and the BVC2 bridge.
import { errorWith } from './logic.js';
import { runMediaWorkerJob } from './media-job.js';
import { encoderSettings, isEncodingMode } from './encoder-tradeoff.js';
import { mediaCorePublished, mediaCoreVariant, mediaThreads } from './media-core.js';
import { retryableAvailability } from './retryable-availability.js';

export const MAX_CONVERT_INPUT = 320 * 1024 * 1024;
export const MAX_CONCAT_INPUT = 160 * 1024 * 1024;
const createWorker = () => new Worker(new URL('./media-convert-worker.js', import.meta.url),
  { type: 'module' });

export const MEDIA_CORE_MISSING = '尚未部署 Librempeg 媒體處理 WASM（media-core），無法解密或轉碼此影片';
const checkPublished = retryableAvailability(() => mediaCorePublished());
/** A transient 404 during a Pages deploy must not persist until reload. */
export async function mediaCoreAvailable() {
  if (typeof Worker !== 'function') return false;
  return checkPublished();
}

// A Worker that started loading the core while the source was downloading.
// Only stream-copy jobs (no encoder pool) take it over.
let warm = null;
export function prepareMediaCore(signal) {
  if (signal?.aborted) return Promise.resolve();
  if (!warm && typeof Worker === 'function') {
    try {
      const worker = createWorker();
      worker.postMessage({ op: 'prepare', mode: 'copy', threads: 1 });
      warm = worker;
      // Switching episodes before the job starts must not leak the Worker.
      signal?.addEventListener('abort', () => {
        if (warm === worker) { warm = null; worker.terminate(); }
      }, { once: true });
    } catch { warm = null; }
  }
  return Promise.resolve();
}
function takeWorker(mode) {
  if (warm && !isEncodingMode(mode)) {
    const worker = warm;
    warm = null;
    return worker;
  }
  return createWorker();
}

/**
 * mode: original/copy (stream copy, CENC decryption), h264, hevc, av1, vvc.
 * tradeoffIndex selects the download speed/size stop; null keeps each
 * encoder's fast defaults (used by playback's ByteVC2 fallback).
 */
export function convertBytes(bytes, { mode = 'copy', contentKey = null, signal, progress, onProgress,
  tradeoffIndex = null, h264TradeoffIndex, onResult } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length)
    return Promise.reject(errorWith('EMPTY_MEDIA', '沒有收到影片資料'));
  if (bytes.length > MAX_CONVERT_INPUT)
    return Promise.reject(errorWith('FFMPEG_LIMIT', '影片超過瀏覽器處理上限 320 MiB'));
  if (contentKey && !/^[0-9a-f]{32}$/i.test(contentKey))
    return Promise.reject(errorWith('INVALID_KEY', '影片來源的解密金鑰格式錯誤'));
  if (signal?.aborted) return Promise.reject(errorWith('CANCELED', '已取消影片處理'));
  const threads = mediaThreads(mediaCoreVariant());
  return runMediaWorkerJob(bytes, {
    request: { mode, key: contentKey || '',
      ...encoderSettings(mode, tradeoffIndex ?? h264TradeoffIndex ?? null), threads },
    progress, onProgress, signal, onResult, createWorker: () => takeWorker(mode)
  });
}

// Lossless concat demuxer with stream copy, never a re-encode or subtitle
// input. Inputs and output share WASM memory: large series should use ZIP.
export function concatLosslessly(inputs, { signal, progress } = {}) {
  if (!Array.isArray(inputs) || inputs.length < 2)
    return Promise.reject(errorWith('FFMPEG_ERROR', '至少選擇兩集才能無損合併'));
  const total = inputs.reduce((n, item) => n + item.length, 0);
  if (total > MAX_CONCAT_INPUT) return Promise.reject(errorWith('FFMPEG_LIMIT',
    '無損合併須在瀏覽器記憶體內同時保存輸入與輸出，總輸入限 160 MiB；大量集數請使用 ZIP'));
  return runMediaWorkerJob(inputs, { progress, signal, createWorker });
}
