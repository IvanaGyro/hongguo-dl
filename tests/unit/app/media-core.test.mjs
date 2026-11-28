import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyMediaCoreBundle, readLimitedAsset, mediaCoreVariant, mediaThreads,
  mediaPoolSize, loadMediaCore } from '../../../src/media-core.js';

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
  await assert.rejects(verifyMediaCoreBundle({ ...manifest, api: 3 }, 'mt', js, wasm), /Invalid/);
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

test('thread budget is shared by concurrent jobs and capped', () => {
  const scope = { navigator: { hardwareConcurrency: 12 } };
  assert.equal(mediaThreads('st', scope), 1);
  assert.equal(mediaThreads('mt', scope), 8);
  assert.equal(mediaThreads('mt', scope, 3), 4);
  assert.equal(mediaThreads('mt', { navigator: { hardwareConcurrency: 2 } }, 3), 1);
});

test('pthread pool covers the threads each encoder starts', () => {
  assert.equal(mediaPoolSize('av1', 4, 'st'), 0);
  assert.equal(mediaPoolSize('copy', 8, 'mt'), 0);
  assert.equal(mediaPoolSize('av1', 1, 'mt'), 0);
  assert(mediaPoolSize('av1', 4, 'mt') >= 59 + 4);
  assert(mediaPoolSize('av1', 2, 'mt') >= 37 + 2);
  assert(mediaPoolSize('hevc', 4, 'mt') > 8);
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
