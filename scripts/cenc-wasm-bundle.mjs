// SPDX-License-Identifier: GPL-3.0-only
// Produce and verify a single, provenance-pinned CENC JS/WASM release.
// Run "publish DIST_DIR" only after the synthetic decode test succeeds.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const BUNDLE_FILES = ['cenc-core.mjs', 'cenc-core.wasm'];
export const SOURCE_FILES = ['scripts/cenc-stream-remux.c', 'scripts/build-cenc-stream-wasm.sh'];
const RELEASE_DIR = resolve('public/cenc');
const MANIFEST = resolve(RELEASE_DIR, 'manifest.json');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const fileSha256 = path => sha256(readFileSync(path));
const isHash = value => /^[a-f0-9]{64}$/.test(value || '');

export function makeManifest(dir = RELEASE_DIR) {
  const hashes = Object.fromEntries(BUNDLE_FILES.map(name => [name, fileSha256(resolve(dir, name))]));
  return {
    schema: 1,
    emsdk: '3.1.74',
    librempegCommit: 'cb1f8f3eef84999e61b27e2d44664858179bc240',
    files: hashes,
    inputs: Object.fromEntries(SOURCE_FILES.map(name => [name, fileSha256(resolve(name))]))
  };
}

export function verifyManifest(dir = RELEASE_DIR, manifestPath = MANIFEST) {
  const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (expected.schema !== 1 || expected.emsdk !== '3.1.74' ||
      expected.librempegCommit !== 'cb1f8f3eef84999e61b27e2d44664858179bc240')
    throw new Error('CENC bundle manifest schema/toolchain mismatch');
  const actual = makeManifest(dir);
  for (const group of ['files', 'inputs']) {
    for (const [name, digest] of Object.entries(actual[group])) {
      if (!isHash(expected[group]?.[name]) || expected[group][name] !== digest)
        throw new Error('CENC bundle mismatch: ' + name);
    }
    if (Object.keys(expected[group] || {}).length !== Object.keys(actual[group]).length)
      throw new Error('Unexpected CENC ' + group + ' manifest entries');
  }
  return actual;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const command = process.argv[2];
  if (command === 'publish') {
    const dist = resolve(process.argv[3] || '');
    for (const name of BUNDLE_FILES) {
      if (!existsSync(resolve(dist, name))) throw new Error('Missing compiled file: ' + name);
    }
    mkdirSync(RELEASE_DIR, { recursive: true });
    for (const name of BUNDLE_FILES) copyFileSync(resolve(dist, name), resolve(RELEASE_DIR, name));
    writeFileSync(MANIFEST, JSON.stringify(makeManifest(), null, 2) + '\n');
    verifyManifest();
    console.log('Verified CENC JS/WASM bundle and source manifest published');
  } else if (command === 'verify') {
    verifyManifest();
    console.log('Verified published CENC JS/WASM pair and pinned build sources');
  } else {
    throw new Error('Usage: node scripts/cenc-wasm-bundle.mjs publish DIST_DIR | verify');
  }
}
