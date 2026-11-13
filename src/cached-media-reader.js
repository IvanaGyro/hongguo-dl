// SPDX-License-Identifier: GPL-3.0-only
import { createHttpStreamReader } from './http-stream.js';
import { createMediaByteCache } from './media-byte-cache.js';
const canceled = () => Object.assign(new Error('Canceled'), { code: 'CANCELED' });
export function abortable(task, signal) {
  if (signal?.aborted) return Promise.reject(canceled());
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(canceled());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([task, interrupted]).finally(() => signal?.removeEventListener('abort', onAbort));
}
export function createCachedMediaReader({ fileSize, budget = 32 * 1024 * 1024,
  initialRanges = [], durationSeconds = 0, onStage = () => {}, ...options }) {
  const cache = createMediaByteCache({ fileSize, budget });
  for (const { offset, data } of initialRanges) cache.write(offset, data, true);
  let closed = false, enabled = false, focus = 0, pumping = false, demand = 0;
  let queue = Promise.resolve(), downloadedBytes = 0, requests = 0, lastLog = 0, reportedComplete = false;
  const notify = force => {
    const complete = cache.firstMissing(0, fileSize) === null;
    if (force || complete !== reportedComplete || performance.now() - lastLog > 2000) {
      reportedComplete = complete;
      lastLog = performance.now();
      onStage('media.cache', { ...cache.stats, downloadedBytes, requests });
    }
  };
  const network = createHttpStreamReader({ ...options, fileSize, externalCache: cache,
    maxPacketBytes: fileSize <= budget ? budget : Math.max(4 * 1024 * 1024, budget / 2),
    onChunk: (offset, data) => { cache.write(offset, data); downloadedBytes += data.length; },
    onResponse: fields => { requests = fields.requests; options.onResponse?.(fields); }
  });
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  async function acquire(start, size) {
    let bytes = cache.read(start, size);
    while (!bytes) {
      const missing = cache.firstMissing(start, start + size);
      await network.read(missing, Math.min(65536, fileSize - missing));
      bytes = cache.read(start, size);
    }
    notify(false); return bytes;
  }
  const pump = async () => {
    if (pumping || !enabled || closed) return;
    pumping = true;
    const before = downloadedBytes;
    try {
      // Short episodes can finish downloading without remuxing them all.
      // Long files use an independent, bounded byte lookahead, not MSE size.
      const ahead = durationSeconds > 0 ? fileSize / durationSeconds * 120 : 8 * 1024 * 1024;
      while (enabled && !closed) {
        if (demand) break;
        const end = fileSize <= budget ? fileSize : Math.min(fileSize,
          focus + Math.min(budget / 2, Math.max(4 * 1024 * 1024, ahead)));
        const missing = cache.firstMissing(fileSize <= budget ? 0 : focus, end);
        if (missing === null) break;
        await serial(() => acquire(missing, Math.min(65536, end - missing)));
        // Yield to queued seeks/ACKs instead of monopolizing a cached stream.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      notify(downloadedBytes !== before);
    } catch (error) {
      // Speculation must not fail playback. A demanded read retains the
      // existing status-aware recovery/error path and can retry later.
      if (!closed) onStage('media.prefetch.stopped', { code:
        /^CENC_[A-Z_]+$/.test(error?.code || '') ? error.code : 'CENC_RANGE_HTTP' });
    } finally { pumping = false; }
  };
  const close = () => { closed = true; enabled = false; network.close(); };
  options.signal?.addEventListener('abort', close, { once: true });
  return {
    async read(start, wanted, readSignal) {
      if (closed || readSignal?.aborted) throw canceled();
      const size = Math.min(wanted, fileSize - start);
      if (!Number.isSafeInteger(start) || start < 0 || size < 1 || wanted > 1024 * 1024)
        throw new TypeError('Invalid AVIO read');
      focus = start;
      const hit = cache.read(start, size);
      if (hit) { if (enabled) void pump(); return hit; }
      demand++;
      try { return await abortable(serial(() => acquire(start, size)), readSignal); }
      finally { demand--; if (enabled) void pump(); }
    },
    prefetch(active) {
      const next = active && !closed;
      if (enabled !== next) onStage('media.prefetch', { active: next });
      enabled = next; if (enabled) void pump();
    },
    get networkStats() { return { requests, downloadedBytes }; },
    snapshot(force = false) { notify(force); return { ...cache.stats, downloadedBytes, requests }; },
    close
  };
}
