// SPDX-License-Identifier: GPL-3.0-only
// Whole-file reads through the media Worker. The Worker assembles the file
// from the same source, HTTP response and byte cache used by metadata probing
// and incremental streaming, so a fallback never re-downloads cached ranges.
// The assembled buffer is transferred, not copied, to this thread.
import { createMediaProcessor } from './media-processor.js';
import { errorWith } from './logic.js';

const MESSAGES = {
  MEMORY_LIMIT: '影片超過瀏覽器整檔處理的記憶體上限',
  CENC_SOURCE_FORBIDDEN: '媒體來源拒絕存取（HTTP 403）',
  CENC_RATE_LIMITED: '媒體來源限制請求頻率（HTTP 429）',
  CENC_RANGE_UNSUPPORTED: '媒體來源不支援 HTTP Range',
  MEDIA_SOURCE_INVALID: '媒體網址不在允許清單內'
};

function readError(fields) {
  const code = typeof fields?.code === 'string' && /^[A-Z0-9_]{2,48}$/.test(fields.code)
    ? fields.code : 'CENC_RANGE_HTTP';
  const status = Number.isInteger(fields?.status) ? fields.status : 0;
  return Object.assign(errorWith(code, MESSAGES[code] ||
    (status ? '媒體來源讀取失敗（HTTP ' + status + '）' : '媒體來源讀取失敗')),
  { status, ...(Number.isFinite(fields?.retryAfterMs) ? { retryAfterMs: fields.retryAfterMs } : {}) });
}

/**
 * Read a complete source. `input` is `{ url, proxyUrl }` from the download
 * layer. Pass `processor` to continue on a Worker that already holds this
 * source (for example after an incremental stream failed); the call then
 * owns and closes it.
 */
export function readWholeFile({ input, bridge = 'cenc', key = '', maxBytes, signal,
  onProgress = () => {}, onStage = () => {}, processor = null, fetchImpl } = {}) {
  // A retained Worker continues with the exact source (URL, proxy, bridge)
  // its cache belongs to; a different URL would open a new source.
  const source = processor?.demand?.source || (input?.url
    ? { url: input.url, proxyUrl: input.proxyUrl || null, bridge, key: key || '' } : null);
  if (signal?.aborted || !source) {
    processor?.close({ discard: true });
    return Promise.reject(signal?.aborted ? errorWith('CANCELED', '已取消')
      : errorWith('SOURCE_UNAVAILABLE', '沒有可讀取的媒體來源'));
  }
  const worker = processor || createMediaProcessor({ bridge, onStage, fetchImpl });
  if (processor) worker.setStageObserver?.(onStage);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.close({ discard: Boolean(error) });
      if (error) reject(error); else resolve(bytes);
    };
    const abort = () => finish(errorWith('CANCELED', '已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmetadata = () => {};
    worker.onroute = () => {};
    worker.onstageerror = error => finish(error);
    worker.onerror = fields => finish(fields?.workerError
      ? errorWith('CENC_UNAVAILABLE', '媒體 Worker 無法執行') : readError(fields));
    worker.consume(data => {
      if (data?.type === 'whole-file.progress') onProgress(data.received, data.total);
      else if (data?.type === 'whole-file') finish(null, new Uint8Array(data.bytes));
    });
    try {
      worker.need({
        source, output: 'whole-file', maxBytes, priority: 'active', processing: false,
        playback: { paused: true, bufferedAheadSeconds: 0, bufferTargetSeconds: 0 }
      });
    } catch {
      finish(errorWith('CENC_UNAVAILABLE', '媒體 Worker 無法啟動'));
    }
  });
}

/**
 * Holds media Workers whose streaming route failed or was unavailable, keyed
 * by source URL, so the episode's whole-file fallback reuses their cache.
 * At most one Worker is retained; anything not taken is terminated.
 */
export function createRetainedSources() {
  let retained = null;
  const drop = () => {
    const previous = retained;
    retained = null;
    previous?.processor.close({ discard: true });
  };
  return {
    keep(url, processor) {
      if (!url || !processor) return false;
      if (retained?.processor !== processor) drop();
      retained = { url, processor };
      return true;
    },
    take(url) {
      if (!retained || retained.url !== url) return null;
      const { processor } = retained;
      retained = null;
      return processor;
    },
    get size() { return retained ? 1 : 0; },
    clear: drop
  };
}
