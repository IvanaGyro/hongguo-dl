import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyCencRuntimeBundle, readLimitedAsset } from '../src/cenc-bundle.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('runtime bundle digest detects swapped JS or WASM after deployment', async () => {
  const js = new Uint8Array([1,2,3]), wasm = new Uint8Array([4,5,6]);
  const manifest = { schema: 1, files: {
    'cenc-core.mjs': hash(js), 'cenc-core.wasm': hash(wasm)
  } };
  await verifyCencRuntimeBundle(manifest, js, wasm);
  await assert.rejects(verifyCencRuntimeBundle(manifest, js, new Uint8Array([5])),
    /mismatch/);
  await assert.rejects(verifyCencRuntimeBundle({ schema: 2 }, js, wasm),
    /Invalid/);
});

test('asset reader enforces an actual byte limit, not only Content-Length', async () => {
  const bytes = await readLimitedAsset(new Response(new Uint8Array([1,2,3])),
    3);
  assert.deepEqual([...bytes], [1,2,3]);
  await assert.rejects(readLimitedAsset(new Response(new Uint8Array(4)), 3),
    /memory limit/);
});
