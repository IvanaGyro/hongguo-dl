import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyMediaCoreBundle, readLimitedAsset, mediaCoreVariant, mediaThreads,
  mediaPoolSize, loadMediaCore, svtParallelLevel } from '../../../src/media-core.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestFor = (js, wasm) => ({ schema: 2, api: 4, files: {
  'media-core.mjs': hash(js), 'media-core.wasm': hash(wasm),
  'media-core-st.mjs': hash(js), 'media-core-st.wasm': hash(wasm) } });

test('runtime bundle digest detects swapped JS or WASM after deployment', async () => {
  const js = new Uint8Array([1, 2, 3]), wasm = new Uint8Array([4, 5, 6]);
  const manifest = manifestFor(js, wasm);
  await verifyMediaCoreBundle(manifest, 'mt', js, wasm);
  await verifyMediaCoreBundle(manifest, 'st', js, wasm);
  await assert.rejects(verifyMediaCoreBundle(manifest, 'mt', js, new Uint8Array([5])), /mismatch/);
  // A tampered or swapped JS glue file is rejected like a WASM one.
  await assert.rejects(verifyMediaCoreBundle(manifest, 'mt', new Uint8Array([1, 2, 4]), wasm), /mismatch/);
  await assert.rejects(verifyMediaCoreBundle(manifest, 'st', wasm, js), /mismatch/);
  await assert.rejects(verifyMediaCoreBundle({ ...manifest, api: 3 }, 'mt', js, wasm), /Invalid/);
  for (const schema of [1, 3, '2', undefined])
    await assert.rejects(verifyMediaCoreBundle({ ...manifest, schema }, 'mt', js, wasm), /Invalid/, String(schema));
  await assert.rejects(verifyMediaCoreBundle(manifest, 'gpu', js, wasm), /Invalid/);
});

test('asset reader enforces an actual byte limit, not only Content-Length', async () => {
  const bytes = await readLimitedAsset(new Response(new Uint8Array([1, 2, 3])), 3);
  assert.deepEqual([...bytes], [1, 2, 3]);
  await assert.rejects(readLimitedAsset(new Response(new Uint8Array(4)), 3), /memory limit/);
});

test('multi-thread variant only where shared memory exists', () => {
  assert.equal(mediaCoreVariant({ crossOriginIsolated: true, SharedArrayBuffer: function () {} }), 'mt');
  assert.equal(mediaCoreVariant({ crossOriginIsolated: false, SharedArrayBuffer: function () {} }), 'st');
  assert.equal(mediaCoreVariant({ crossOriginIsolated: true }), 'st');
});

test('every logical core is used, without an arbitrary cap', () => {
  assert.equal(mediaThreads('st', { navigator: { hardwareConcurrency: 12 } }), 1);
  assert.equal(mediaThreads('mt', { navigator: { hardwareConcurrency: 12 } }), 12);
  assert.equal(mediaThreads('mt', { navigator: { hardwareConcurrency: 32 } }), 32);
  assert.equal(mediaThreads('mt', { navigator: {} }), 4);
});

test('SVT-AV1 parallelism level follows its own core-count mapping', () => {
  assert.deepEqual([1, 2, 3, 5, 6, 11, 12, 23, 24, 64].map(svtParallelLevel), [1, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
});

test('pthread pool covers the threads each encoder starts', () => {
  assert.equal(mediaPoolSize('av1', 4, 'st'), 0);
  assert.equal(mediaPoolSize('copy', 8, 'mt'), 0);
  assert.equal(mediaPoolSize('av1', 1, 'mt'), 0);
  assert(mediaPoolSize('av1', 2, 'mt') >= 37 + 2);   // level 2
  assert(mediaPoolSize('av1', 4, 'mt') >= 46 + 4);   // level 3
  assert(mediaPoolSize('av1', 8, 'mt') >= 59 + 8);   // level 4
  assert(mediaPoolSize('av1', 32, 'mt') >= 82 + 16); // level 6, decoder capped at 16
  assert(mediaPoolSize('hevc', 32, 'mt') >= 32 + 16);
});

test('loader rejects a swapped JS glue file before importing it', async () => {
  const js = new TextEncoder().encode('export default 1'), wasm = new Uint8Array([0, 97, 115, 109]);
  const manifest = manifestFor(js, wasm);
  const fetchImpl = async url => {
    if (String(url).endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
    return new Response(String(url).includes('.mjs')
      ? new TextEncoder().encode('globalThis.imported = true; export default 1') : wasm);
  };
  await assert.rejects(loadMediaCore({ baseUrl: '/', baseHref: 'https://example.test/', variant: 'mt',
    fetchImpl }), /hash mismatch/);
  assert.equal(globalThis.imported, undefined, 'the swapped module was never imported');
});

test('loader verifies hashes before importing and picks the variant files', async () => {
  const js = new TextEncoder().encode('export default 1'), wasm = new Uint8Array([0, 97, 115, 109]);
  const manifest = manifestFor(js, wasm);
  const requested = [];
  const fetchImpl = async url => {
    requested.push(String(url));
    if (String(url).endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
    return new Response(String(url).includes('.mjs') ? js : new Uint8Array([9]));
  };
  await assert.rejects(loadMediaCore({ baseUrl: '/', baseHref: 'https://example.test/', variant: 'st',
    fetchImpl }), /hash mismatch/);
  assert(requested.some(url => url.includes('/media-core/media-core-st.mjs?v=')));
  assert(requested.some(url => url.includes('/media-core/media-core-st.wasm?v=')));
});
