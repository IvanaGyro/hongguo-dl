// SPDX-License-Identifier: GPL-3.0-only
// Publish a version-locked experimental BVC2 decoder/encoder pair only after
// the pinned Librempeg/x264 compile and negative-stream ABI checks succeed.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const BVC2_FILES = ['bvc2-core.mjs', 'bvc2-core.wasm'];
export const BVC2_INPUTS = [
  'scripts/bvc2-transcoder.c',
  'scripts/build-bvc2-wasm-transcode.sh'
];
export const BVC2_DIR = resolve('public/bvc2');
export const BVC2_MANIFEST = resolve(BVC2_DIR, 'manifest.json');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const valid = value => /^[0-9a-f]{64}$/.test(value || '');

export function makeBvc2Manifest(directory = BVC2_DIR) {
  return {
    schema: 1,
    kind: 'experimental-bvc2-x264',
    emsdk: '3.1.74',
    librempegCommit: 'cb1f8f3eef84999e61b27e2d44664858179bc240',
    x264Commit: '33cac6b77d5b9259c552156013a817ab23119612',
    files: Object.fromEntries(BVC2_FILES.map(name =>
      [name, sha256(resolve(directory, name))])),
    inputs: Object.fromEntries(BVC2_INPUTS.map(name =>
      [name, sha256(resolve(name))]))
  };
}

export function verifyBvc2Manifest(directory = BVC2_DIR,
  path = BVC2_MANIFEST) {
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  const actual = makeBvc2Manifest(directory);
  for (const name of ['schema', 'kind', 'emsdk', 'librempegCommit', 'x264Commit'])
    if (stored[name] !== actual[name])
      throw new Error('BVC2 manifest provenance mismatch: ' + name);
  for (const group of ['files', 'inputs']) {
    if (Object.keys(stored[group] || {}).length !== Object.keys(actual[group]).length)
      throw new Error('Unexpected BVC2 ' + group + ' entries');
    for (const [name, digest] of Object.entries(actual[group])) {
      if (!valid(stored[group]?.[name]) || stored[group][name] !== digest)
        throw new Error('BVC2 release mismatch: ' + name);
    }
  }
  return actual;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const command = process.argv[2];
  if (command === 'publish') {
    const dist = resolve(process.argv[3] || '');
    for (const filename of BVC2_FILES) {
      if (!existsSync(resolve(dist, filename)))
        throw new Error('Missing experimental BVC2 build artifact: ' + filename);
    }
    mkdirSync(BVC2_DIR, {recursive: true});
    for (const filename of BVC2_FILES)
      copyFileSync(resolve(dist, filename), resolve(BVC2_DIR, filename));
    writeFileSync(BVC2_MANIFEST,
      JSON.stringify(makeBvc2Manifest(), null, 2) + '\n');
    verifyBvc2Manifest();
    console.log('Published verified experimental BVC2 JS/WASM pair and manifest');
  } else if (command === 'verify') {
    verifyBvc2Manifest();
    console.log('Verified BVC2 WASM/JS fingerprints and build provenance');
  } else {
    throw new Error('Usage: node scripts/bvc2-wasm-bundle.mjs publish DIST | verify');
  }
}
