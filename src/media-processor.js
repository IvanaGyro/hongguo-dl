// Main-thread client for the media Worker. It only declares demands
// (need/dontNeed), reports browser capabilities, and acknowledges consumed
// output; the Worker decides how to open, probe, cache and process.
import { createStreamPreload } from './stream-preload.js';
import { createLocalMediaWorker } from './media-worker-local.js';

// Retain at most one completed engine, for a short interval between episodes.
// Interrupted or failed jobs are terminated rather than reusing uncertain state.
let idle = null;
let epoch = 0;
let demandSequence = 0;
const epochs = new WeakMap();
const retiring = new Map();
export function clearMediaProcessors() {
  epoch++;
  discardIdle();
  for (const [worker, timer] of retiring) {
    clearTimeout(timer); worker.terminate();
  }
  retiring.clear();
}
function discardIdle() {
  if (!idle) return;
  clearTimeout(idle.timer);
  idle.worker.terminate();
  idle = null;
}
function acquire(bridge, fetchImpl) {
  // Without MSE no application-owned processing route exists: only bounded
  // metadata for a browser-native route is needed, so a dedicated Worker
  // would add startup cost without moving any processing off this thread.
  if (typeof Worker !== 'function' || typeof MediaSource === 'undefined')
    return createLocalMediaWorker({ fetchImpl });
  if (idle?.bridge === bridge) {
    const { worker, timer } = idle;
    clearTimeout(timer); idle = null;
    return worker;
  }
  discardIdle();
  const worker = bridge === 'bvc2'
    ? new Worker(new URL('./bvc2-stream-worker.js', import.meta.url), { type: 'module' })
    : new Worker(new URL('./cenc-remux-worker.js', import.meta.url), { type: 'module' });
  epochs.set(worker, epoch);
  return worker;
}
function release(worker, bridge) {
  if (epochs.get(worker) !== epoch) { worker.terminate(); return; }
  // Wait for the per-episode read loop to unwind before lending this engine.
  const stop = () => {
    clearTimeout(retiring.get(worker)); retiring.delete(worker); worker.terminate();
  };
  const timeout = setTimeout(stop, 1000);
  retiring.set(worker, timeout);
  worker.onerror = stop;
  worker.onmessage = ({ data }) => {
    if (data?.type !== 'idle') return;
    clearTimeout(timeout);
    retiring.delete(worker);
    if (!data.reusable || epochs.get(worker) !== epoch) { worker.terminate(); return; }
    discardIdle();
    const entry = { worker, bridge, timer: null };
    entry.timer = setTimeout(() => { if (idle === entry) discardIdle(); }, 30000);
    worker.onerror = () => { if (idle === entry) discardIdle(); };
    worker.onmessage = null;
    idle = entry;
  };
  try { worker.postMessage({ type: 'release' }); } catch { stop(); }
}

/**
 * One consumer of one media Worker. `need(changes)` upserts this consumer's
 * desired state with a new revision; the returned generation identifies the
 * requested position, so output produced for an older position is ignored.
 */
export function createMediaProcessor({ bridge, preload = false, onStage = () => {},
  supportsType = () => false, fetchImpl }) {
  const worker = acquire(bridge, fetchImpl);
  const id = 'demand-' + (++demandSequence);
  let demand = null, revision = 0, generation = 0, closed = false, consumer = null;
  let completed = false, failed = false, cacheInfo = {}, pendingRead = { pending: 0 };
  const waiting = [];
  const send = (message, transfer = []) => {
    if (closed) return;
    worker.postMessage(message, transfer);
  };
  const deliver = data => {
    if (consumer) consumer(data); else waiting.push(data);
  };
  const need = changes => {
    if (closed) return generation;
    const next = { ...demand, ...changes, playback: { ...demand?.playback, ...changes.playback },
      id, revision: ++revision };
    if (!demand || next.positionSeconds !== demand.positionSeconds) {
      generation = revision; completed = false;
    }
    demand = next;
    send({ type: 'need', demand });
    return generation;
  };
  const staging = createStreamPreload({ enabled: preload, onStage,
    post: message => message.type === 'process' ? need({ processing: true }) : send(message) });
  const processor = {
    onmetadata: () => {}, onroute: () => {}, onerror: () => {},
    onstageerror: error => { throw error; },
    need, post: send,
    reportCapabilities(capabilities) { send({ type: 'capabilities', capabilities }); },
    dontNeed() { send({ type: 'dont-need', id }); },
    consume(handler) {
      consumer = handler;
      for (const data of waiting.splice(0)) handler(data);
    },
    get generation() { return generation; },
    get demand() { return demand; },
    get preloading() { return staging.active; },
    finished: () => completed,
    startProcessing: () => staging.startProcessing(),
    pauseProcessing: () => staging.pauseProcessing(),
    activate() {
      const pending = staging.activate();
      need({ priority: 'active' });
      onStage('preload.handoff', { units: pending.length });
      if (pendingRead.pending > 0) onStage('media.wait', pendingRead);
      for (const unit of pending) deliver(unit);
    },
    snapshot: () => cacheInfo,
    close({ discard = false } = {}) {
      if (closed) return;
      closed = true; staging.close(); waiting.length = 0;
      if (completed && !failed && !discard) release(worker, bridge);
      else worker.terminate();
    }
  };
  worker.onerror = event => {
    event?.preventDefault?.(); failed = true;
    processor.onerror({ code: null, workerError: true });
  };
  worker.onmessage = ({ data }) => {
    if (closed || !data) return;
    if (data.type === 'stage') {
      const { type, stage, ...fields } = data;
      if (stage === 'media.cache') cacheInfo = fields;
      if (stage === 'media.wait') pendingRead = fields;
      // Stage observers enforce the caller's step budgets by throwing; such
      // a refusal belongs to this consumer, not to the Worker message loop.
      try { onStage(stage, fields); }
      catch (error) { processor.onstageerror(error); }
      return;
    }
    if (data.type === 'capability-request') {
      const types = {};
      for (const type of Array.isArray(data.types) ? data.types.slice(0, 8) : []) {
        if (typeof type !== 'string') continue;
        try { types[type] = Boolean(supportsType(type)); } catch { types[type] = false; }
      }
      send({ type: 'capabilities', capabilities: { types } });
      return;
    }
    if (data.demand != null && data.demand !== id) return;
    if (data.type === 'metadata') return processor.onmetadata(data.metadata);
    if (data.type === 'route') return processor.onroute(data.route);
    if (data.generation !== undefined && data.generation !== generation) return;
    if (data.type === 'error') {
      failed = true;
      processor.onerror(data);
      return;
    }
    if (data.type === 'done') completed = true;
    if (!staging.capture(data)) deliver(data);
  };
  return processor;
}
