import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
const require = createRequire(import.meta.url);
const from = dirname(require.resolve('@ffmpeg/core'));
const destination = 'public/ffmpeg';
mkdirSync(destination, { recursive: true });
copyFileSync(join(from, 'ffmpeg-core.js'), join(destination, 'ffmpeg-core.js'));
const raw = join(destination, 'ffmpeg-core.wasm');
rmSync(raw, { force: true }); // Never deploy the 30+ MiB uncompressed asset (Cloudflare 25 MiB cap).
const compressed = gzipSync(readFileSync(join(from, 'ffmpeg-core.wasm')), { level: 9 });
if (compressed.byteLength >= 24 * 1024 * 1024) {
  throw new Error('Compressed FFmpeg core is too large for Cloudflare static assets');
}
writeFileSync(join(destination, 'ffmpeg-core.wasm.gz'), compressed);
console.log('Prepared compressed FFmpeg.wasm core: ' + (compressed.byteLength / 1048576).toFixed(1) + ' MiB');
