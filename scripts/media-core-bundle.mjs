// SPDX-License-Identifier: GPL-3.0-only
// Publish and verify the single provenance-pinned media core release: both
// thread variants of one Librempeg build plus the hashes of every build
// input. Run "publish DIST" only after verify-video-outputs.mjs passed for
// both variants.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MEDIA_CORE_FILES = ['media-core.mjs', 'media-core.wasm', 'media-core-st.mjs', 'media-core-st.wasm'];
export const MEDIA_CORE_INPUTS = [
  'scripts/build-media-core.sh',
  'scripts/media-core/avio.c',
  'scripts/media-core/avio.h',
  'scripts/media-core/cenc-remux.c',
  'scripts/media-core/transcoder.c',
  'scripts/patch-bvc2-mov.py',
  'scripts/patch-x265-single-thread.py',
  'scripts/patches/svt-av1/0001-wasm-wiener-kernel-pointers.patch',
  'scripts/patches/svt-av1/0002-avx2-mi-map-pointer-width.patch',
  'scripts/vendor/libvvenc.c'
];
export const MEDIA_CORE_PROVENANCE = Object.freeze({
  schema: 2,
  api: 4,
  emsdk: '3.1.74',
  librempegCommit: 'cb1f8f3eef84999e61b27e2d44664858179bc240',
  encoders: Object.freeze({
    x264: '33cac6b77d5b9259c552156013a817ab23119612',
    x265: '2bb5520e9596f361bf0ed81b3b8da0d7fd999069',
    'svt-av1': 'ad875ab772c67ff3f098c59667348d80fb5c68b6+IvanaGyro/SVT-AV1#1+#2',
    vvenc: 'ca1af4a2bcfcf9cd9fea1bacb1f73037af253bda'
  }),
  variants: Object.freeze({ mt: 'pthreads', st: 'single-thread' })
});
export const MEDIA_CORE_DIR = resolve('public/media-core');
export const MEDIA_CORE_MANIFEST = resolve(MEDIA_CORE_DIR, 'manifest.json');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const valid = value => /^[0-9a-f]{64}$/.test(value || '');

export function makeMediaCoreManifest(directory = MEDIA_CORE_DIR) {
  return {
    ...MEDIA_CORE_PROVENANCE,
    files: Object.fromEntries(MEDIA_CORE_FILES.map(name => [name, sha256(resolve(directory, name))])),
    inputs: Object.fromEntries(MEDIA_CORE_INPUTS.map(name => [name, sha256(resolve(name))]))
  };
}

export function verifyMediaCoreManifest(directory = MEDIA_CORE_DIR, path = MEDIA_CORE_MANIFEST) {
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  const actual = makeMediaCoreManifest(directory);
  for (const name of Object.keys(MEDIA_CORE_PROVENANCE))
    if (JSON.stringify(stored[name]) !== JSON.stringify(actual[name]))
      throw new Error('Media core manifest provenance mismatch: ' + name);
  for (const group of ['files', 'inputs']) {
    if (Object.keys(stored[group] || {}).length !== Object.keys(actual[group]).length)
      throw new Error('Unexpected media core ' + group + ' entries');
    for (const [name, digest] of Object.entries(actual[group]))
      if (!valid(stored[group]?.[name]) || stored[group][name] !== digest)
        throw new Error('Media core release mismatch: ' + name);
  }
  return actual;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const command = process.argv[2];
  if (command === 'publish') {
    const dist = resolve(process.argv[3] || '');
    for (const name of MEDIA_CORE_FILES)
      if (!existsSync(resolve(dist, name))) throw new Error('Missing media core artifact: ' + name);
    mkdirSync(MEDIA_CORE_DIR, { recursive: true });
    for (const name of MEDIA_CORE_FILES) copyFileSync(resolve(dist, name), resolve(MEDIA_CORE_DIR, name));
    writeFileSync(MEDIA_CORE_MANIFEST, JSON.stringify(makeMediaCoreManifest(), null, 2) + '\n');
    verifyMediaCoreManifest();
    console.log('Published verified media core (mt + st) and manifest');
  } else if (command === 'verify') {
    verifyMediaCoreManifest();
    console.log('Verified media core JS/WASM fingerprints and build provenance');
  } else {
    throw new Error('Usage: node scripts/media-core-bundle.mjs publish DIST | verify');
  }
}
