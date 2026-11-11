import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Vite bundles @ffmpeg/ffmpeg as an ES module Web Worker. That worker falls
// back from importScripts() to dynamic import(), which REQUIRES the ESM core.
// require.resolve('@ffmpeg/core') takes the CommonJS "require" export (UMD)
// and causes "failed to import ffmpeg-core.js" in module workers on Firefox.
const esmCore = fileURLToPath(import.meta.resolve('@ffmpeg/core'));
const esmWasm = fileURLToPath(import.meta.resolve('@ffmpeg/core/wasm'));
const js = readFileSync(esmCore, 'utf8');
if (!js.includes('export default createFFmpegCore')) {
  throw new Error('Unexpected @ffmpeg/core resolution: expected ESM default export, got ' + esmCore);
}
const destination = 'public/ffmpeg';
mkdirSync(destination, { recursive: true });
copyFileSync(esmCore, destination + '/ffmpeg-core.js');
rmSync(destination + '/ffmpeg-core.wasm', { force: true }); // Avoid deploying 30+ MiB uncompressed asset.
const compressed = gzipSync(readFileSync(esmWasm), { level: 9 });
if (compressed.byteLength >= 24 * 1024 * 1024) {
  throw new Error('Compressed FFmpeg core is too large for Cloudflare static assets');
}
writeFileSync(destination + '/ffmpeg-core.wasm.gz', compressed);
console.log('Prepared ESM FFmpeg.wasm core: ' + (compressed.byteLength / 1048576).toFixed(1) + ' MiB gzip');
