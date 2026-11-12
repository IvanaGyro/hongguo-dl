// SPDX-License-Identifier: GPL-3.0-only
// The experimental BVC2 source/codec is intentionally distinct from VVC.
// A JS/WASM pair compiled from different Librempeg revisions may break ABI.
const HASH = /^[0-9a-f]{64}$/;

export async function verifyBvc2RuntimeBundle(manifest, moduleBytes, wasmBytes) {
  if (manifest?.schema !== 1 || manifest.kind !== 'experimental-bvc2-x264' ||
      manifest.emsdk !== '3.1.74' ||
      manifest.librempegCommit !== 'cb1f8f3eef84999e61b27e2d44664858179bc240' ||
      manifest.x264Commit !== '33cac6b77d5b9259c552156013a817ab23119612' ||
      !HASH.test(manifest.files?.['bvc2-core.mjs']) ||
      !HASH.test(manifest.files?.['bvc2-core.wasm']))
    throw new Error('Invalid experimental BVC2 WASM release manifest');
  const hash = async bytes => Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const [moduleHash, wasmHash] = await Promise.all([
    hash(moduleBytes), hash(wasmBytes)
  ]);
  if (moduleHash !== manifest.files['bvc2-core.mjs'] ||
      wasmHash !== manifest.files['bvc2-core.wasm'])
    throw new Error('Experimental BVC2 release JS/WASM hash mismatch');
}
