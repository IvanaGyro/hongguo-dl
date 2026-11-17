// SPDX-License-Identifier: GPL-3.0-only
// Dedicated media Worker entry. Download (layer 1) and processing (layer 2)
// share this Worker; the main thread declares demands and ACKs output only.
import { createMediaWorkerCore } from './media-worker-core.js';
import { loadMediaRuntime } from './media-engine.js';

const core = createMediaWorkerCore({
  post: (message, transfer = []) => self.postMessage(message, transfer),
  fetchImpl: (...args) => fetch(...args),
  origin: self.location.origin,
  loadRuntime: (bridge, signal, onStage, hooks) =>
    loadMediaRuntime({ bridge, signal, onStage, hooks, baseHref: self.location.href })
});
self.onmessage = ({ data }) => core.handle(data);
