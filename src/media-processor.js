// Layer 2: Worker/WASM execution and bounded speculative media output.
// The MSE consumer acknowledges units when it has room for more data.
import { createStreamPreload } from './stream-preload.js';

// Retain at most one completed engine, for a short interval between episodes.
// Interrupted or failed jobs are terminated rather than reusing uncertain state.
let idle = null;
let epoch = 0;
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
function acquire(bridge) {
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

export function createMediaProcessor({ bridge, preload = false, onStage = () => {} }) {
  const worker = acquire(bridge);
  let generation = 0;
  let closed = false, completed = false, failed = false, cacheInfo = {}, pendingRead = { pending: 0 };
  const post = message => {
    if (closed) return;
    if (message.type === 'seek') { generation = message.generation; completed = false; }
    worker.postMessage(message);
  };
  const staging = createStreamPreload({ enabled: preload, post, onStage });
  const processor = {
    onunit: () => {}, onerror: () => {}, post,
    get preloading() { return staging.active; },
    finished: () => completed,
    startProcessing: () => staging.startProcessing(),
    pauseProcessing: () => staging.pauseProcessing(),
    activate() {
      const pending = staging.activate();
      onStage('preload.handoff', { units: pending.length });
      if (pendingRead.pending > 0) onStage('media.wait', pendingRead);
      for (const unit of pending) processor.onunit(unit);
    },
    snapshot: () => cacheInfo,
    close({ discard = false } = {}) {
      if (closed) return;
      closed = true; staging.close();
      if (completed && !failed && !discard) release(worker, bridge);
      else worker.terminate();
    }
  };
  worker.onerror = event => {
    event.preventDefault?.(); failed = true;
    processor.onerror();
  };
  worker.onmessage = ({ data }) => {
    if (closed || !data) return;
    if (data.type === 'stage') {
      const { type, stage, ...fields } = data;
      if (stage === 'media.cache') cacheInfo = fields;
      if (stage === 'media.wait') pendingRead = fields;
      onStage(stage, fields);
      return;
    }
    if (data.generation !== undefined && data.generation !== generation) return;
    if (data.type === 'error') failed = true;
    if (data.type === 'done') completed = true;
    if (!staging.capture(data)) processor.onunit(data);
  };
  return processor;
}
