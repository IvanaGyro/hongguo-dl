// SPDX-License-Identifier: GPL-3.0-only
// LOCAL, permissioned positive ByteVC2 acceptance harness. Never commits or
// downloads a real media URL, key or output into GitHub Actions artifacts.
// Usage: BVC2_CENC_KEY=<32-hex> node scripts/verify-bvc2-fixture.mjs INPUT.mp4
// Leave BVC2_CENC_KEY unset for unencrypted local fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkAvTimeline } from './bvc2-fixture-timing.mjs';

const fixturePath = process.argv[2];
assert(fixturePath, 'Usage: node scripts/verify-bvc2-fixture.mjs LOCAL_BVC2.mp4');
const size = statSync(fixturePath).size;
assert(size > 8 && size <= 260 * 1024 * 1024, 'BVC2 fixture outside bounded memory limit');
const key = process.env.BVC2_CENC_KEY || '';
assert(!key || /^[a-fA-F0-9]{32}$/.test(key), 'Invalid local CENC key format');
const coreModule = process.env.BVC2_CORE_MODULE || 'public/bvc2/bvc2-core.mjs';
const coreWasm = process.env.BVC2_CORE_WASM || 'public/bvc2/bvc2-core.wasm';
const { default: createModule } = await import(pathToFileURL(
  await import('node:path').then(p => p.resolve(coreModule))).href);
const started = performance.now();
const core = await createModule({ wasmBinary: readFileSync(coreWasm) });
assert.equal(core._bvc2_decoder_available(), 1, 'BVC2/x264 pipeline not linked');
const dir = mkdtempSync(join(tmpdir(), 'bvc2-positive-local-'));
try {
  const input = '/sample.mp4', output = '/output.mp4';
  core.FS.writeFile(input, readFileSync(fixturePath));
  const code = core.cwrap('bvc2_transcode', 'number',
    ['string', 'string', 'string'])(input, output, key);
  if (code !== 0) {
    // Only log the fixed decoder error stage, never input path/URL or key.
    throw new Error('BVC2 remux/transcode failed: ' +
      core.UTF8ToString(core._bvc2_last_error()));
  }
  const result = core.FS.readFile(output);
  assert(result.byteLength > 8, 'BVC2 produced empty MP4');
  const localOutput = join(dir, 'clear.mp4');
  writeFileSync(localOutput, result);
  const info = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,start_time,duration',
    '-of', 'json', localOutput
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 }));
  const video = info.streams?.find(track => track.codec_type === 'video');
  assert.equal(video?.codec_name, 'h264', 'Output video must be H.264');
  assert(Number(video.nb_read_frames) > 0, 'ByteVC2 decoder produced no decodable pictures');
  execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', localOutput, '-f', 'null', '-'
  ], { maxBuffer: 1024 * 1024 });
  const audio = info.streams?.find(track => track.codec_type === 'audio');
  // A container-level start/end check catches large AAC drift or truncation.
  // It does not prove frame-level lip synchronization or visual correctness.
  const avTimeline = checkAvTimeline(video, audio);
  console.log('PASS locally authorized ByteVC2 decode → H.264', JSON.stringify({
    decodedFrames: Number(video.nb_read_frames),
    width: video.width, height: video.height,
    audioCodec: audio?.codec_name || 'none',
    avTimeline,
    outputBytes: result.byteLength,
    transcodeSeconds: +((performance.now() - started) / 1000).toFixed(2),
    // process memory is an observation, not a guarantee for Android Firefox.
    nodeRssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1)
  }));
} finally {
  // Do not retain or publish decrypted third-party media.
  rmSync(dir, { recursive: true, force: true });
}
