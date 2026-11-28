// SPDX-License-Identifier: GPL-3.0-only
// Link-time ABI check of one media-core variant: every exported entry point
// exists, the expected encoders are linked and invalid input is rejected.
// Usage: node scripts/verify-media-core.mjs DIST/media-core.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const path = process.argv[2];
const { default: createModule } = await import(pathToFileURL(path));
const core = await createModule({ wasmBinary: readFileSync(path.replace(/\.mjs$/, '.wasm')),
  pthreadPoolSize: 2 });
const info = core.UTF8ToString(core._media_core_info());
for (const name of ['libx264', 'libx265', 'libsvtav1', 'libvvenc', 'bvc2'])
  assert(info.includes(name), 'missing ' + name + ' in ' + info);
assert.match(info, /^api=4;threads=(1|128);/);
assert.equal(core._bvc2_decoder_available(), 1);
assert.equal(core._cenc_remux_available(), 1);
for (const name of ['media_convert', 'media_concat', 'media_set_threads', 'bvc2_stream', 'bvc2_play',
  'cenc_stream_remux', 'cenc_stream_remux_at'])
  assert.equal(typeof core['_' + name], 'function', name);
core.FS.writeFile('/bad.mp4', new Uint8Array([1, 2, 3, 4]));
const rc = await core.ccall('media_convert', 'number',
  ['string', 'string', 'string', 'number', 'string', 'number', 'number'],
  ['/bad.mp4', '/out.mp4', '', 2, '8', 30, 2], { async: true });
assert(rc < 0, 'Truncated MP4 unexpectedly succeeded');
assert(core.UTF8ToString(core._media_last_error()));
const bad = await core.ccall('media_convert', 'number',
  ['string', 'string', 'string', 'number', 'string', 'number', 'number'],
  ['/bad.mp4', '/out.mp4', '', 5, 'placebo', 30, 2], { async: true });
assert(bad < 0);
assert.match(core.UTF8ToString(core._media_last_error()), /invalid encoder preset/);
console.log('media core linked: ' + info);
process.exit(0);
