// SPDX-License-Identifier: GPL-3.0-only
// Ensures that a browser cannot silently combine a cached old JS glue module
// with a new WASM binary (or vice versa) after a GitHub Pages release.
const HEX = /^[0-9a-f]{64}$/;
const digestHex = async bytes => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  b => b.toString(16).padStart(2, '0')).join('');

export async function verifyCencRuntimeBundle(manifest, moduleBytes, wasmBytes) {
  if (manifest?.schema !== 1 || !HEX.test(manifest?.files?.['cenc-core.mjs']) ||
      !HEX.test(manifest?.files?.['cenc-core.wasm']))
    throw new Error('Invalid CENC WASM release manifest');
  const [moduleHash, wasmHash] = await Promise.all([
    digestHex(moduleBytes), digestHex(wasmBytes)
  ]);
  if (moduleHash !== manifest.files['cenc-core.mjs'] ||
      wasmHash !== manifest.files['cenc-core.wasm'])
    throw new Error('CENC JS/WASM release mismatch');
}

export async function readLimitedAsset(response, maxBytes) {
  if (!response.ok || !response.body ||
      Number(response.headers.get('content-length') || 0) > maxBytes)
    throw new Error('CENC release asset unavailable');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || size + value.byteLength > maxBytes)
        throw new Error('CENC release asset exceeds memory limit');
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let pos = 0;
  for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length; }
  return bytes;
}
