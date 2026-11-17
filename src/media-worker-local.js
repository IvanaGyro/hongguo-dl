// SPDX-License-Identifier: GPL-3.0-only
// Worker-shaped host that runs the media core on the current thread. Used
// where Worker is unavailable (Node tests, restricted embeds): the same
// demand protocol, download and metadata layers apply; WASM processing is
// only offered when a runtime loader is supplied.
import { createMediaWorkerCore } from './media-worker-core.js';

export function createLocalMediaWorker({ fetchImpl, origin, loadRuntime, cacheBudget } = {}) {
  let terminated = false;
  const worker = {
    onmessage: null, onerror: null,
    postMessage(data) {
      if (terminated) throw new Error('Worker terminated');
      queueMicrotask(() => { if (!terminated) core.handle(data); });
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      core.close();
    }
  };
  const core = createMediaWorkerCore({
    post: data => queueMicrotask(() => { if (!terminated) worker.onmessage?.({ data }); }),
    fetchImpl: fetchImpl || ((...args) => fetch(...args)),
    origin: origin || globalThis.location?.origin || 'http://localhost',
    loadRuntime, cacheBudget
  });
  return worker;
}
