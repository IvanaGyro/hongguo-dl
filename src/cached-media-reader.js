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
// One response-body pump per source. Decoder requests wait on the byte cache;
// enabling read-ahead only allows that same pump to continue without a waiter.
export function createCachedMediaReader({ fileSize, budget,
  initialRanges = [], durationSeconds = 0, onStage = () => {}, ...options }) {
  const environment = typeof navigator === 'undefined' ? {} : navigator;
  const saveData = Boolean(environment.connection?.saveData);
  const lowMemory = environment.deviceMemory > 0 && environment.deviceMemory <= 2;
  budget ??= (saveData || lowMemory ? 16 : 32) * 1024 * 1024;
  const cache = createMediaByteCache({ fileSize, budget });
  for (const { offset, data } of initialRanges) cache.write(offset, data, true);
  let closed = false, enabled = false, focus = 0, pumping = false, packet = null;
  let speculationFailed = false, failure = null, downloadedBytes = 0, requests = 0, lastLog = 0, reportedComplete = false;
  const catchupMs = Math.min(1000, options.timeoutMs || 10000);
  const reads = new Set();
  const notify = force => {
    const complete = cache.firstMissing(0, fileSize) === null;
    if (force || complete !== reportedComplete || performance.now() - lastLog > 2000) {
      reportedComplete = complete; lastLog = performance.now();
      onStage('media.cache', { ...cache.stats, downloadedBytes, requests });
    }
  };
  const settle = error => {
    for (const read of reads) {
      const bytes = error ? null : cache.read(read.start, read.size);
      if (!error && !bytes) continue;
      reads.delete(read); read.cleanup();
      if (error) read.reject(error); else read.resolve(bytes);
    }
  };
  const network = createHttpStreamReader({ ...options, fileSize, durationSeconds, externalCache: cache,
    onSlow: fields => onStage('media.slow', fields),
    onRequest: fields => onStage('media.request', fields),
    maxPacketBytes: fileSize <= budget ? budget : Math.max(4 * 1024 * 1024, budget / 2),
    onChunk: (offset, data) => {
      cache.write(offset, data);
      // Retain authoritative metadata overlays even when the persistent body
      // overlaps a normalized ByteVC2 configuration in a moov at EOF.
      for (const range of initialRanges) {
        const start = Math.max(offset, range.offset);
        const end = Math.min(offset + data.length, range.offset + range.data.length);
        if (end > start) cache.write(start,
          range.data.subarray(start - range.offset, end - range.offset), true);
      }
      downloadedBytes += data.length;
      settle();
    },
    onResponse: fields => { requests = fields.requests; options.onResponse?.(fields); }
  });
  const aheadOffset = () => {
    if (!enabled || speculationFailed || failure) return null;
    const ahead = durationSeconds > 0 ? fileSize / durationSeconds * 120 : 8 * 1024 * 1024;
    const end = fileSize <= budget ? fileSize : Math.min(fileSize,
      focus + Math.min(budget / 2, Math.max(4 * 1024 * 1024, ahead)));
    return cache.firstMissing(fileSize <= budget ? 0 : focus, end);
  };
  const pump = async () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (!closed) {
        settle();
        const read = reads.values().next().value;
        const target = read ? cache.firstMissing(read.start, read.start + read.size) : aheadOffset();
        let offset = target;
        if (offset === null) break;
        const { position, bytesPerSecond } = network.stats;
        const remainingMs = read ? catchupMs - (performance.now() - read.requestedAt) : 0;
        // Use positions and measured speed, not a caller's operation label.
        // Keep a fast existing body when it can reach the missing bytes soon.
        if (read && position !== null && target > position && bytesPerSecond > 0 &&
            (target - position) * 1000 / bytesPerSecond < remainingMs) offset = position;
        const current = { controller: new AbortController(), offset };
        const deadline = offset !== target ? setTimeout(() => current.controller.abort(), remainingMs) : null;
        packet = current;
        try {
          // Consume the next available packet, not an arbitrary 64 KiB unit.
          // No second reader queues behind speculative retries on this body.
          await network.read(offset, 1, { signal: current.controller.signal, speculative: !read });
          if (read) speculationFailed = false;
          notify(false);
        } catch (error) {
          if (closed) break;
          if (current.controller.signal.aborted) continue; // Position change/cancel.
          if (error?.code === 'CENC_SOURCE_SLOW') failure = error;
          if (!read) {
            speculationFailed = true;
            onStage('media.prefetch.stopped', { code:
              /^CENC_[A-Z_]+$/.test(error?.code || '') ? error.code : 'CENC_RANGE_HTTP' });
          }
          // A waiter arriving during speculation gets its own required read
          // and recovery budget, rather than inheriting the background error.
          if (read || failure) settle(error);
          if (failure) break;
        } finally { clearTimeout(deadline); if (packet === current) packet = null; }
        if (!read) await new Promise(resolve => setTimeout(resolve, 0));
      }
      notify(false);
    } finally {
      pumping = false;
      if (!closed && reads.size) void pump();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true; enabled = false; packet?.controller.abort(); network.close();
    settle(canceled()); options.signal?.removeEventListener('abort', close);
  };
  options.signal?.addEventListener('abort', close, { once: true });
  if (options.signal?.aborted) close();
  return {
    async read(start, wanted, readSignal) {
      if (closed || readSignal?.aborted) throw canceled();
      const size = Math.min(wanted, fileSize - start);
      if (!Number.isSafeInteger(start) || start < 0 || size < 1 || wanted > 1024 * 1024)
        throw new TypeError('Invalid AVIO read');
      focus = start;
      const hit = cache.read(start, size);
      if (hit) { if (enabled) void pump(); return hit; }
      if (failure) throw failure;
      return new Promise((resolve, reject) => {
        const entry = { start, size, resolve, reject, requestedAt: performance.now(), timer: null,
          cleanup: () => { clearTimeout(entry.timer); readSignal?.removeEventListener('abort', abort);
            onStage('media.wait', { pending: reads.size, offset: reads.values().next().value?.start ?? entry.start, bytes: reads.values().next().value?.size ?? entry.size }); } };
        const abort = () => {
          reads.delete(entry); entry.cleanup(); reject(canceled());
          if (!reads.size && !enabled) packet?.controller.abort();
        };
        reads.add(entry); onStage('media.wait', { pending: reads.size, offset: reads.values().next().value?.start ?? entry.start, bytes: reads.values().next().value?.size ?? entry.size }); readSignal?.addEventListener('abort', abort, { once: true });
        if (packet && reads.values().next().value === entry) {
          const missing = cache.firstMissing(start, start + size);
          const distance = missing - packet.offset, rate = network.stats.bytesPerSecond;
          const canCatchUp = distance >= 0 && (distance < 65536 || rate > 0 && distance * 1000 / rate < catchupMs);
          if (!canCatchUp) packet.controller.abort();
          else if (distance > 0) {
            const current = packet;
            entry.timer = setTimeout(() => {
              if (packet === current && reads.has(entry)) current.controller.abort();
            }, catchupMs);
          }
        }
        void pump();
      });
    },
    prefetch(active) {
      const next = active && !closed && !saveData;
      if (enabled !== next) {
        onStage('media.prefetch', { active: next });
        if (next) speculationFailed = false;
      }
      enabled = next; if (enabled) void pump();
    },
    get networkStats() { return { requests, downloadedBytes }; },
    snapshot(force = false) { notify(force); return { ...cache.stats, downloadedBytes, requests }; },
    close
  };
}
