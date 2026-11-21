import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBvc2Manifest, verifyBvc2Manifest } from '../../../scripts/bvc2-wasm-bundle.mjs';

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
