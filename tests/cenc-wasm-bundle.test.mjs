import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeManifest, verifyManifest } from '../scripts/cenc-wasm-bundle.mjs';

test('CENC bundle manifest rejects stale wasm and swapped JS files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-cenc-version-'));
  try {
    mkdirSync(join(dir, 'cenc'));
    writeFileSync(join(dir, 'cenc', 'cenc-core.mjs'), 'module v1');
    writeFileSync(join(dir, 'cenc', 'cenc-core.wasm'), 'wasm v1');
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify(makeManifest(join(dir, 'cenc'))));
    assert.doesNotThrow(() => verifyManifest(join(dir, 'cenc'), manifest));
    writeFileSync(join(dir, 'cenc', 'cenc-core.wasm'), 'wasm v2');
    assert.throws(() => verifyManifest(join(dir, 'cenc'), manifest), /cenc-core.wasm/);
    writeFileSync(join(dir, 'cenc', 'cenc-core.wasm'), 'wasm v1');
    writeFileSync(join(dir, 'cenc', 'cenc-core.mjs'), 'module v2');
    assert.throws(() => verifyManifest(join(dir, 'cenc'), manifest), /cenc-core.mjs/);
    writeFileSync(join(dir, 'cenc', 'cenc-core.mjs'), 'module v1');
    const bad = JSON.parse(readFileSync(manifest, 'utf8'));
    bad.inputs['scripts/cenc-stream-remux.c'] = '0'.repeat(64);
    writeFileSync(manifest, JSON.stringify(bad));
    assert.throws(() => verifyManifest(join(dir, 'cenc'), manifest), /cenc-stream-remux.c/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
