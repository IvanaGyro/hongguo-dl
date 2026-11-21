import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBvc2Manifest } from '../../../scripts/bvc2-wasm-bundle.mjs';
import { verifyBvc2RuntimeBundle } from '../../../src/bvc2-bundle.js';

test('BVC2 browser runtime rejects mismatched module/wasm hashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-bvc2-runtime-'));
  try {
    writeFileSync(join(dir, 'bvc2-core.mjs'), 'module v1');
    writeFileSync(join(dir, 'bvc2-core.wasm'), 'binary v1');
    const manifest = makeBvc2Manifest(dir);
    await assert.doesNotReject(verifyBvc2RuntimeBundle(manifest,
      readFileSync(join(dir, 'bvc2-core.mjs')),
      readFileSync(join(dir, 'bvc2-core.wasm'))));
    await assert.rejects(verifyBvc2RuntimeBundle(manifest,
      new TextEncoder().encode('module v2'),
      readFileSync(join(dir, 'bvc2-core.wasm'))), /hash mismatch/);
    await assert.rejects(verifyBvc2RuntimeBundle(
      {...manifest, x264Commit: 'unknown'},
      readFileSync(join(dir, 'bvc2-core.mjs')),
      readFileSync(join(dir, 'bvc2-core.wasm'))), /Invalid experimental/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
