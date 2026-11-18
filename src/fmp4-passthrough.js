// SPDX-License-Identifier: GPL-3.0-only
// Media Worker, layer 2 for native EME: already-fragmented CENC needs no
// demuxing or decryption here. The original encrypted init segment and
// moof+mdat fragments are read from the layer-1 byte cache and delivered as
// units for MSE; the browser's CDM decrypts them. Same unit/ACK/seek protocol
// as the WASM engine (media-engine.js), so the presentation side is shared.
import { boxHeader, parseSidx, parseMfra, mfraSizeFromMfro, trackTimescales, fragmentStartOffset } from './fmp4-index.js';

const READ = 1024 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_FRAGMENT_BYTES = 64 * 1024 * 1024;
// One tail read normally covers mfro and the whole mfra.
const TAIL_WINDOW = 64 * 1024;
const canceled = () => Object.assign(new Error('Canceled'), { code: 'CANCELED' });
const failure = (code, message) => Object.assign(new Error(message), { code });

/** Read `size` bytes at `start` through the cached reader into a new buffer. */
export async function readBytes(reader, start, size, signal) {
  const out = new Uint8Array(size);
  for (let done = 0; done < size;) {
    const bytes = await reader.read(start + done, Math.min(READ, size - done), signal);
    out.set(bytes, done);
    done += bytes.length;
  }
  return out;
}

/**
 * Locate ftyp/moov and a fragment index. Header bytes normally come from the
 * metadata probe's cache; only an `mfra` costs extra tail reads.
 * Returns { init, firstFragment, index } or null without a usable index.
 */
export async function probeFragmentLayout(reader, fileSize, signal) {
  let p = 0, ftyp = null, moov = null, index = null;
  while (p + 8 <= fileSize) {
    const head = await reader.read(p, Math.min(16, fileSize - p), signal);
    const box = boxHeader(head, 0);
    if (!box) break;
    const size = box.size || fileSize - p;
    if (box.type === 'ftyp' || box.type === 'moov') {
      if (size > MAX_INDEX_BYTES * 2) return null;
      const bytes = await readBytes(reader, p, size, signal);
      if (box.type === 'ftyp') ftyp = bytes; else moov = bytes;
    } else if (box.type === 'sidx' && !index) {
      if (size > MAX_INDEX_BYTES) return null;
      index = parseSidx(await readBytes(reader, p, size, signal), p);
    } else if (box.type === 'moof' || box.type === 'mdat') break;
    p += size;
  }
  if (!ftyp || !moov) return null;
  const firstFragment = p;
  if (!index && fileSize - firstFragment >= 16) {
    const tailStart = Math.max(firstFragment, fileSize - TAIL_WINDOW);
    const tail = await readBytes(reader, tailStart, fileSize - tailStart, signal);
    const mfraSize = mfraSizeFromMfro(tail.subarray(tail.length - 16));
    if (mfraSize && mfraSize <= MAX_INDEX_BYTES && mfraSize <= fileSize - firstFragment) {
      const mfra = mfraSize <= tail.length ? tail.subarray(tail.length - mfraSize)
        : await readBytes(reader, fileSize - mfraSize, mfraSize, signal);
      index = parseMfra(mfra, trackTimescales(moov));
    }
  }
  if (!index) return null;
  const init = new Uint8Array(ftyp.length + moov.length);
  init.set(ftyp); init.set(moov, ftyp.length);
  return { init, firstFragment, index };
}

export function createPassthroughJob({ reader, fileSize, layout, position,
  generation: initialGeneration, post, onStage, onError }) {
  const controller = new AbortController();
  let pendingAck = null, seq = 0, generation = initialGeneration;
  let requestedSeek = { seconds: position, generation: initialGeneration }, latestRequested = initialGeneration;
  let wake = null, activeRun = null, completed = false, sourceFailed = false;

  const sendUnit = (type, data) => new Promise((resolve, reject) => {
    if (controller.signal.aborted || activeRun?.signal.aborted) return reject(canceled());
    const id = ++seq;
    pendingAck = { id, resolve, reject };
    // `data` is a fresh copy out of the byte cache; transfer it.
    post({ type, id, generation, bytes: data.buffer }, [data.buffer]);
  });
  function reportSourceFailure(fields) {
    if (sourceFailed) return;
    sourceFailed = true;
    onError({ code: fields.code, status: fields.status || 0,
      ...(Number.isFinite(fields.retryAfterMs) ? { retryAfterMs: fields.retryAfterMs } : {}) });
  }
  async function stream(start, signal) {
    for (let p = start; p + 8 <= fileSize;) {
      const head = await reader.read(p, Math.min(16, fileSize - p), signal);
      const box = boxHeader(head, 0);
      if (!box) break;
      const size = box.size || fileSize - p;
      if (box.type === 'mfra') break;
      if (box.type !== 'moof') { p += size; continue; }
      const next = p + size;
      const mdatHead = next + 8 <= fileSize ? await reader.read(next, Math.min(16, fileSize - next), signal) : null;
      const mdat = mdatHead && boxHeader(mdatHead, 0);
      if (!mdat || mdat.type !== 'mdat') throw failure('CENC_REMUX_FAILED', 'moof without mdat');
      const total = size + (mdat.size || fileSize - next);
      if (total > MAX_FRAGMENT_BYTES) throw failure('CENC_REMUX_FAILED', 'Fragment too large');
      await sendUnit('media', await readBytes(reader, p, total, signal));
      p += total;
    }
  }
  async function run() {
    while (!controller.signal.aborted) {
      if (!requestedSeek) await new Promise(resolve => { wake = resolve; });
      if (controller.signal.aborted) break;
      const request = requestedSeek; requestedSeek = null;
      generation = request.generation;
      activeRun = new AbortController();
      const start = request.seconds > 0 ? fragmentStartOffset(layout.index, request.seconds) : layout.firstFragment;
      onStage('seek.run', { generation, target: request.seconds, indexCached: true, route: 'eme', index: layout.index.kind });
      onStage('first-fragment');
      completed = false;
      try {
        await sendUnit('init', layout.init.slice());
        await stream(start, activeRun.signal);
      } catch (error) {
        if (activeRun.signal.aborted || controller.signal.aborted) continue;
        throw error;
      }
      reader.snapshot(true);
      completed = true;
      post({ type: 'done', generation });
    }
  }
  const finished = run().catch(error => {
    if (controller.signal.aborted) return;
    // Byte reads report the source's public failure code; anything else is a
    // malformed fragment, which belongs to the processing fallback.
    if (/^CENC_(?:SOURCE|RANGE|RATE)/.test(error?.code || '')) reportSourceFailure(error);
    else if (!sourceFailed) onError({ code: 'CENC_REMUX_FAILED', status: 0 });
  }).finally(() => {
    pendingAck = null; requestedSeek = null; activeRun = null; wake = null;
  });

  return {
    kind: 'eme',
    sourceFailure: reportSourceFailure,
    seek(seconds, nextGeneration) {
      if (controller.signal.aborted || nextGeneration <= latestRequested) return;
      latestRequested = nextGeneration;
      completed = false;
      requestedSeek = { seconds, generation: nextGeneration };
      activeRun?.abort();
      pendingAck?.reject(canceled()); pendingAck = null;
      wake?.(); wake = null;
    },
    ack(id) {
      if (pendingAck?.id !== id) return;
      const pending = pendingAck;
      pendingAck = null;
      pending.resolve();
    },
    // No CPU-bound work: speculative output is bounded by the consumer's ACKs.
    allowProcessing() {},
    get reusable() { return true; },
    get completed() { return completed; },
    stop() {
      controller.abort(); activeRun?.abort(); wake?.();
      pendingAck?.reject(canceled()); pendingAck = null;
      return finished;
    }
  };
}
