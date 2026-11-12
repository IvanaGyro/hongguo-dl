import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBvc2Manifest, verifyBvc2Manifest } from '../scripts/bvc2-wasm-bundle.mjs';
import { verifyBvc2RuntimeBundle } from '../src/bvc2-bundle.js';

test('BVC2 bundle pins WASM/JS and rejects stale binaries and changed source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-bvc2-release-'));
  try {
    const out = join(dir, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'bvc2-core.mjs'), 'export default class Decoder {}');
    writeFileSync(join(out, 'bvc2-core.wasm'), 'synthetic wasm bytes');
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeBvc2Manifest(out)));
    assert.doesNotThrow(() => verifyBvc2Manifest(out, manifestPath));
    writeFileSync(join(out, 'bvc2-core.wasm'), 'different wasm bytes');
    assert.throws(() => verifyBvc2Manifest(out, manifestPath), /bvc2-core.wasm/);
    writeFileSync(join(out, 'bvc2-core.wasm'), 'synthetic wasm bytes');
    const modified = JSON.parse(readFileSync(manifestPath, 'utf8'));
    modified.inputs['scripts/bvc2-transcoder.c'] = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(modified));
    assert.throws(() => verifyBvc2Manifest(out, manifestPath), /bvc2-transcoder.c/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

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
