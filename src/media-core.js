// SPDX-License-Identifier: GPL-3.0-only
// The single Librempeg media runtime (CENC remux, ByteVC2, H.264/HEVC/AV1/VVC
// encoding). One manifest pins two builds of identical sources: `mt` uses
// pthreads and needs a cross-origin isolated page (SharedArrayBuffer); `st`
// is the same API without threads for browsers that cannot be isolated.
const HASH = /^[0-9a-f]{64}$/;
export const MEDIA_CORE_API = 4;
export const MEDIA_CORE_DIR = 'media-core/';
export const MEDIA_CORE_VARIANTS = Object.freeze({
  mt: Object.freeze({ module: 'media-core.mjs', wasm: 'media-core.wasm' }),
  st: Object.freeze({ module: 'media-core-st.mjs', wasm: 'media-core-st.wasm' })
});
const MAX_MODULE = 1024 * 1024;
const MAX_WASM = 40 * 1024 * 1024;
export const MAX_ENCODER_THREADS = 8;

/** `mt` only where shared WebAssembly memory can actually be created. */
export function mediaCoreVariant(scope = globalThis) {
  return scope?.crossOriginIsolated === true && typeof scope.SharedArrayBuffer === 'function'
    ? 'mt' : 'st';
}

/** Encoder/decoder threads for one job; 1 for the single-thread build. */
export function mediaThreads(variant = mediaCoreVariant(), scope = globalThis, concurrentJobs = 1) {
  if (variant !== 'mt') return 1;
  const cores = Number(scope?.navigator?.hardwareConcurrency) || 4;
  const share = Math.floor(cores / Math.max(1, concurrentJobs));
  return Math.max(1, Math.min(MAX_ENCODER_THREADS, share));
}

/**
 * Web Workers to pre-start for a job. Emscripten threads must exist before
 * the engine blocks on them, so the pool covers what each library starts:
 * measured for SVT-AV1 4.3 (lp 2 -> 37, lp 4 -> 59, lp 8 -> 82 threads;
 * lp 1 runs inline), and threads plus helpers for x264/x265/VVenC/decoder.
 * Pthreads beyond the pool are still created on demand.
 */
export function mediaPoolSize(mode, threads, variant = mediaCoreVariant()) {
  if (variant !== 'mt' || threads <= 1) return 0;
  const decoder = threads;
  if (mode === 'av1') return decoder + (threads >= 8 ? 84 : threads >= 4 ? 60 : 38);
  if (mode === 'hevc') return decoder + threads + 6;
  if (mode === 'vvc') return decoder + threads + 4;
  if (mode === 'h264' || mode === 'bvc2-stream') return decoder + threads + 3;
  return 0; // copy, concat and CENC remux never start threads
}

export async function readLimitedAsset(response, maxBytes) {
  if (!response.ok || !response.body ||
      Number(response.headers.get('content-length') || 0) > maxBytes)
    throw new Error('Media core asset unavailable');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || size + value.byteLength > maxBytes)
        throw new Error('Media core asset exceeds memory limit');
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

const digestHex = async bytes => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  b => b.toString(16).padStart(2, '0')).join('');

export function validMediaCoreManifest(manifest) {
  return manifest?.schema === 2 && manifest.api === MEDIA_CORE_API &&
    Object.values(MEDIA_CORE_VARIANTS).every(({ module, wasm }) =>
      HASH.test(manifest.files?.[module] || '') && HASH.test(manifest.files?.[wasm] || ''));
}

/** A browser must never combine a cached JS glue file with another WASM. */
export async function verifyMediaCoreBundle(manifest, variant, moduleBytes, wasmBytes) {
  const names = MEDIA_CORE_VARIANTS[variant];
  if (!names || !validMediaCoreManifest(manifest))
    throw new Error('Invalid media core release manifest');
  const [moduleHash, wasmHash] = await Promise.all([digestHex(moduleBytes), digestHex(wasmBytes)]);
  if (moduleHash !== manifest.files[names.module] || wasmHash !== manifest.files[names.wasm])
    throw new Error('Media core JS/WASM hash mismatch');
}

const canceled = () => Object.assign(new Error('Canceled'), { code: 'CANCELED' });

/**
 * Download, verify and instantiate the media core. `hooks` become Module
 * properties (readRange, writeChunk, writeFrame, onProgress, printErr).
 */
export async function loadMediaCore({ signal, onStage = () => {}, hooks = {}, baseHref,
  baseUrl, variant = mediaCoreVariant(), poolSize = 0, fetchImpl = fetch } = {}) {
  const base = new URL((baseUrl ?? import.meta.env?.BASE_URL ?? '/') + MEDIA_CORE_DIR,
    baseHref ?? globalThis.location?.href);
  const names = MEDIA_CORE_VARIANTS[variant];
  if (!names) throw new Error('Unknown media core variant');
  onStage('wasm-download', { variant });
  const manifestResponse = await fetchImpl(new URL('manifest.json', base), { signal, cache: 'no-store' });
  const manifest = JSON.parse(new TextDecoder().decode(await readLimitedAsset(manifestResponse, 8192)));
  if (!validMediaCoreManifest(manifest)) throw new Error('Invalid media core release manifest');
  // Content-addressed URLs: an old HTTP cache entry cannot be combined with
  // a new deployment. Pthread workers re-import this same module URL.
  const moduleUrl = new URL(names.module, base), wasmUrl = new URL(names.wasm, base);
  moduleUrl.searchParams.set('v', manifest.files[names.module]);
  wasmUrl.searchParams.set('v', manifest.files[names.wasm]);
  const [moduleResponse, wasmResponse] = await Promise.all([
    fetchImpl(moduleUrl, { signal, cache: 'force-cache' }),
    fetchImpl(wasmUrl, { signal, cache: 'force-cache' })
  ]);
  const [moduleBytes, wasmBytes] = await Promise.all([
    readLimitedAsset(moduleResponse, MAX_MODULE), readLimitedAsset(wasmResponse, MAX_WASM)]);
  onStage('wasm-verify', { variant });
  await verifyMediaCoreBundle(manifest, variant, moduleBytes, wasmBytes);
  if (signal?.aborted) throw canceled();
  const { default: createModule } = await import(/* @vite-ignore */ moduleUrl.href);
  onStage('wasm-start', { variant, poolSize });
  const core = await createModule({ wasmBinary: wasmBytes, pthreadPoolSize: poolSize, ...hooks });
  const info = core.UTF8ToString(core._media_core_info());
  if (!info.startsWith('api=' + MEDIA_CORE_API + ';')) throw new Error('Media core ABI mismatch');
  core.mediaVariant = variant;
  return core;
}

/** HEAD probe: a 200 SPA fallback is not evidence of a published runtime. */
export async function mediaCorePublished({ baseUrl, baseHref, variant = mediaCoreVariant(),
  fetchImpl = fetch } = {}) {
  const base = new URL((baseUrl ?? import.meta.env?.BASE_URL ?? '/') + MEDIA_CORE_DIR,
    baseHref ?? globalThis.location?.href);
  const [wasm, manifest] = await Promise.all([
    fetchImpl(new URL(MEDIA_CORE_VARIANTS[variant].wasm, base), { method: 'HEAD' }),
    fetchImpl(new URL('manifest.json', base), { method: 'HEAD', cache: 'no-store' })
  ]);
  const wasmMime = wasm.headers.get('content-type') || '';
  const manifestMime = manifest.headers.get('content-type') || '';
  return wasm.ok && manifest.ok &&
    /^(application\/wasm|application\/octet-stream)\b/i.test(wasmMime) &&
    /^(application\/json|application\/octet-stream)\b/i.test(manifestMime) &&
    Number(wasm.headers.get('content-length') || 0) < MAX_WASM &&
    Number(manifest.headers.get('content-length') || 0) < 8192;
}
