// Deterministic codec-config regression fixtures; no upstream media or keys.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { syntheticBvc2 } from './synthetic-bvc2.mjs';
const root = mkdtempSync(join(tmpdir(), 'bvc2-regression-'));
const output = process.argv[2] || '/tmp';
try {
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8',
    '-c:v', 'libx264', '-g', '12', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart', '-y', join(root, 'input.mp4')]);
  const { default: createModule } = await import(pathToFileURL(resolve('public/bvc2/bvc2-core.mjs')));
  const core = await createModule({ wasmBinary: readFileSync('public/bvc2/bvc2-core.wasm') });
  core.FS.writeFile('/input.mp4', readFileSync(join(root, 'input.mp4')));
  const result = await core.ccall('bvc2_convert', 'number', ['string', 'string', 'string', 'number'],
    ['/input.mp4', '/vvc.mp4', '', 3], { async: true });
  assert.equal(result, 0, core.UTF8ToString(core._bvc2_last_error()));
  writeFileSync(join(root, 'vvc.mp4'), core.FS.readFile('/vvc.mp4'));
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-stream_loop', '7', '-i', join(root, 'vvc.mp4'),
    '-c', 'copy', '-movflags', '+faststart', '-y', join(root, 'long-vvc.mp4')]);
  const short = syntheticBvc2(join(root, 'vvc.mp4'), { configurationRecord: true });
  const long = syntheticBvc2(join(root, 'long-vvc.mp4'), { configurationRecord: true });
  writeFileSync(join(output, 'bvc2-short.mp4'), short);
  writeFileSync(join(output, 'bvc2-long.mp4'), long);
  console.log('Generated bv2C version-1 fixtures', JSON.stringify({ shortBytes: short.length, longBytes: long.length }));
} finally { rmSync(root, { recursive: true, force: true }); }
