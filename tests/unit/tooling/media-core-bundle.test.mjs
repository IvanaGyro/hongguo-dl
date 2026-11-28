import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_CORE_FILES, makeMediaCoreManifest, verifyMediaCoreManifest }
  from '../../../scripts/media-core-bundle.mjs';

test('media core bundle pins both variants and rejects stale binaries or changed sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-media-core-'));
  try {
    const out = join(dir, 'out');
    mkdirSync(out);
    for (const name of MEDIA_CORE_FILES) writeFileSync(join(out, name), 'synthetic ' + name);
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeMediaCoreManifest(out)));
    assert.doesNotThrow(() => verifyMediaCoreManifest(out, manifestPath));
    writeFileSync(join(out, 'media-core-st.wasm'), 'different');
    assert.throws(() => verifyMediaCoreManifest(out, manifestPath), /media-core-st.wasm/);
    writeFileSync(join(out, 'media-core-st.wasm'), 'synthetic media-core-st.wasm');
    const modified = JSON.parse(readFileSync(manifestPath, 'utf8'));
    modified.inputs['scripts/patches/svt-av1/0001-wasm-wiener-kernel-pointers.patch'] = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(modified));
    assert.throws(() => verifyMediaCoreManifest(out, manifestPath), /wiener/);
    writeFileSync(manifestPath, JSON.stringify({ ...makeMediaCoreManifest(out), api: 3 }));
    assert.throws(() => verifyMediaCoreManifest(out, manifestPath), /provenance mismatch: api/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
