import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_CORE_FILES, MEDIA_CORE_DIR, MEDIA_CORE_MANIFEST, makeMediaCoreManifest,
  verifyMediaCoreManifest } from '../../../scripts/media-core-bundle.mjs';
import { MEDIA_CORE_VARIANTS, verifyMediaCoreBundle } from '../../../src/media-core.js';

async function syntheticRelease(run) {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-media-core-'));
  try {
    const out = join(dir, 'out');
    mkdirSync(out);
    for (const name of MEDIA_CORE_FILES) writeFileSync(join(out, name), 'synthetic ' + name);
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(makeMediaCoreManifest(out)));
    return await run({ out, manifestPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const edit = (path, change) => {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest));
};

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

test('tampered JS glue files fail tooling verification for both variants', () => syntheticRelease(({ out, manifestPath }) => {
  for (const name of ['media-core.mjs', 'media-core-st.mjs']) {
    writeFileSync(join(out, name), 'export default "swapped"');
    assert.throws(() => verifyMediaCoreManifest(out, manifestPath), new RegExp(name.replace('.', '\\.')));
    writeFileSync(join(out, name), 'synthetic ' + name);
  }
  assert.doesNotThrow(() => verifyMediaCoreManifest(out, manifestPath));
}));

test('altered build provenance fails tooling verification', () => syntheticRelease(({ out, manifestPath }) => {
  const original = readFileSync(manifestPath, 'utf8');
  for (const [field, change] of [
    ['emsdk', m => { m.emsdk = '3.1.73'; }],
    ['librempegCommit', m => { m.librempegCommit = '0'.repeat(40); }],
    ['encoders', m => { m.encoders['svt-av1'] = 'ad875ab772c67ff3f098c59667348d80fb5c68b6'; }],
    ['encoders', m => { m.encoders.vvenc = '1'.repeat(40); }],
    ['encoders', m => { delete m.encoders.x265; }],
    ['schema', m => { m.schema = 1; }]
  ]) {
    edit(manifestPath, change);
    assert.throws(() => verifyMediaCoreManifest(out, manifestPath),
      new RegExp('provenance mismatch: ' + field), field);
    writeFileSync(manifestPath, original);
  }
}));

test('a tooling manifest is accepted by the browser bundle verifier', () => syntheticRelease(async ({ out, manifestPath }) => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const [variant, { module, wasm }] of Object.entries(MEDIA_CORE_VARIANTS))
    await verifyMediaCoreBundle(manifest, variant, readFileSync(join(out, module)), readFileSync(join(out, wasm)));
  await assert.rejects(verifyMediaCoreBundle(manifest, 'mt', readFileSync(join(out, 'media-core-st.mjs')),
    readFileSync(join(out, 'media-core.wasm'))), /mismatch/);
}));

test('the published release passes tooling and browser verification', async () => {
  verifyMediaCoreManifest();
  const manifest = JSON.parse(readFileSync(MEDIA_CORE_MANIFEST, 'utf8'));
  for (const [variant, { module, wasm }] of Object.entries(MEDIA_CORE_VARIANTS))
    await verifyMediaCoreBundle(manifest, variant, readFileSync(join(MEDIA_CORE_DIR, module)),
      readFileSync(join(MEDIA_CORE_DIR, wasm)));
});
