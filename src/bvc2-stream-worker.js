// SPDX-License-Identifier: GPL-3.0-only
// Separate Worker URL for ByteVC2 demands, so a pooled engine is never lent
// across bridges. The demand itself names the bridge and its WASM runtime.
import './cenc-remux-worker.js';
