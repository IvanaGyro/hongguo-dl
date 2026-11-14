// SPDX-License-Identifier: GPL-3.0-only
// Share transport, bounded raw cache, cancellation and error classification
// with CENC playback; only the verified codec runtime/entry point differ.
import './cenc-remux-worker.js';
const handle = self.onmessage;
self.onmessage = event => {
  if (event.data?.type === 'start') event.data.bridge = 'bvc2';
  handle(event);
};
