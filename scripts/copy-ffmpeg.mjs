import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
const require = createRequire(import.meta.url);
const pkg = require.resolve('@ffmpeg/core/package.json');
const from = join(dirname(pkg), 'dist', 'umd');
const destination = 'public/ffmpeg';
mkdirSync(destination, { recursive: true });
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(join(from, file), join(destination, file));
}
console.log('Copied single-thread FFmpeg.wasm core into static assets');
