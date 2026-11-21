// SPDX-License-Identifier: GPL-3.0-only
// Global setup: generate the synthetic sample videos once and cache them.
// Nothing here contacts the real service; Shaka Packager is a pinned,
// checksum-verified download used only to package fragmented CENC.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MEDIA_DIR = resolve('node_modules/.cache/hongguo-media');
export const KEY = '00112233445566778899aabbccddeeff';
export const KID = '11223344556677889900aabbccddeeff';
const SHAKA = {
  url: 'https://github.com/shaka-project/shaka-packager/releases/download/v3.9.3/packager-linux-x64',
  sha256: '7a3cf35ad146fd7810b4ededab363c8a3e6121d1b2c8391f53863126186f9ee6'
};
// Bump when a recipe changes, so cached files are rebuilt.
const VERSION = '1';

const video = seconds => ['-f', 'lavfi', '-i', `testsrc2=size=480x270:rate=12:duration=${seconds}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '12', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '64k', '-shortest'];
const encrypt = ['-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', KEY, '-encryption_kid', KID];
const ffmpeg = (args, out) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
  ...args, '-movflags', '+faststart', '-y', out], { stdio: 'inherit' });

const RECIPES = {
  'clear-short.mp4': out => ffmpeg(video(4), out),
  'clear.mp4': out => ffmpeg(video(180), out),
  'cenc-short.mp4': out => ffmpeg([...video(4), ...encrypt], out),
  'cenc-medium.mp4': out => ffmpeg([...video(20), ...encrypt], out),
  'clear-portrait.mp4': out => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=270x480:rate=12:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], out),
  'cenc.mp4': out => ffmpeg([...video(180), ...encrypt], out),
  'cenc-fmp4-sidx.mp4': out => {
    const clear = join(MEDIA_DIR, 'clear.mp4');
    const packager = shakaPackager();
    const tmp = join(MEDIA_DIR, 'packaging');
    mkdirSync(tmp, { recursive: true });
    for (const stream of ['video', 'audio'])
      execFileSync(packager, [`in=${clear},stream=${stream},output=${join(tmp, stream + '.mp4')}`,
        '--enable_raw_key_encryption', '--keys', `label=:key_id=${KID}:key=${KEY}`,
        '--protection_scheme', 'cenc', '--clear_lead', '0'], { stdio: 'pipe' });
    // The app plays one muxed file; keep the video track (Clear Key, sidx).
    renameSync(join(tmp, 'video.mp4'), out);
  },
  // One run of the derive script writes both index layouts.
  'cenc-fmp4-mfra.mp4': () => deriveIndexes(),
  'cenc-fmp4-none.mp4': () => {}
};

function deriveIndexes() {
  execFileSync(process.execPath, ['scripts/derive-fmp4-index-fixtures.mjs',
    join(MEDIA_DIR, 'cenc-fmp4-sidx.mp4'), MEDIA_DIR], { stdio: 'inherit' });
  renameSync(join(MEDIA_DIR, 'fmp4-mfra.mp4'), join(MEDIA_DIR, 'cenc-fmp4-mfra.mp4'));
  renameSync(join(MEDIA_DIR, 'fmp4-none.mp4'), join(MEDIA_DIR, 'cenc-fmp4-none.mp4'));
}

function shakaPackager() {
  const path = join(MEDIA_DIR, 'shaka-packager');
  if (!existsSync(path)) {
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2',
      SHAKA.url, '-o', path + '.download']);
    const digest = createHash('sha256').update(readFileSync(path + '.download')).digest('hex');
    if (digest !== SHAKA.sha256) throw new Error('Shaka Packager checksum mismatch');
    renameSync(path + '.download', path);
    chmodSync(path, 0o755);
  }
  return path;
}

// Long episodes for the @slow specs only (HONGGUO_SLOW=1).
const SLOW_RECIPES = {
  'cenc-300s.mp4': out => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=12:duration=300',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=300',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-g', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '48k', '-shortest', ...encrypt], out),
  'cenc-1800s.mp4': out => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=6:duration=1800',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050:duration=1800',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-g', '12', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '32k', '-shortest', ...encrypt], out)
};

export function mediaPath(name) {
  return join(MEDIA_DIR, name);
}

export default function globalSetup() {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const stamp = join(MEDIA_DIR, 'version');
  const fresh = existsSync(stamp) && readFileSync(stamp, 'utf8') === VERSION;
  const recipes = { ...RECIPES, ...(process.env.HONGGUO_SLOW ? SLOW_RECIPES : {}) };
  for (const [name, make] of Object.entries(recipes))
    if (!fresh || !existsSync(join(MEDIA_DIR, name))) make(join(MEDIA_DIR, name));
  writeFileSync(stamp, VERSION);
}
