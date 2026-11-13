// SPDX-License-Identifier: GPL-3.0-only
// Offline acceptance: actual encoded MP4s, CENC decrypt, AAC timing/PCM,
// bit-identical original video packets, and async Range/fMP4 output.
// Uses only a synthetic testsrc2+sine generated here; never contacts upstream.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syntheticBvc2 } from './synthetic-bvc2.mjs';
import { createFmp4Assembler } from '../src/fmp4-assembler.js';

const dir = mkdtempSync(join(tmpdir(), 'hongguo-output-check-'));
const coreDir = resolve(process.argv[2] || 'public/bvc2');
const { default: createModule } = await import(pathToFileURL(join(coreDir, 'bvc2-core.mjs')));
const wasmBinary = readFileSync(join(coreDir, 'bvc2-core.wasm'));
const key = '00112233445566778899aabbccddeeff'; // public synthetic test constant
const ffmpeg = args => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', ...args], { maxBuffer: 32 * 1024 * 1024 });
const probe = (path, vvc = false) => JSON.parse(execFileSync(vvc ? (process.env.VVC_FFPROBE || 'ffprobe') : 'ffprobe', ['-v', 'error', '-count_frames',
  '-show_streams', '-of', 'json', path]));
try {
  const input = join(dir, 'input.mp4'), encrypted = join(dir, 'encrypted.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=12', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-g', '12',
    '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', input]);
  ffmpeg(['-i', input, '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', key,
    '-encryption_kid', '11223344556677889900aabbccddeeff', '-movflags', '+faststart', '-y', encrypted]);
  const raw = readFileSync(encrypted);
  for (const [mode, name] of [[0, 'h264'], [4, 'h264'], [5, 'hevc'], [2, 'av1'], [3, 'vvc']]) {
    const progress = [];
    const core = await createModule({ wasmBinary, onProgress: p => progress.push(p) });
    core.FS.writeFile('/in.mp4', raw);
    const start = performance.now();
    const code = await core.ccall('bvc2_convert', 'number',
      ['string', 'string', 'string', 'number'], ['/in.mp4', '/out.mp4', key, mode], { async: true });
    assert.equal(code, 0, core.UTF8ToString(core._bvc2_last_error()));
    const path = join(dir, name + mode + '.mp4');
    writeFileSync(path, core.FS.readFile('/out.mp4'));
    const info = probe(path, name === 'vvc'), video = info.streams.find(s => s.codec_type === 'video'),
      audio = info.streams.find(s => s.codec_type === 'audio');
    assert.equal(video.codec_name, name);
    assert.equal(Number(video.nb_read_frames), 96);
    assert.equal(audio.codec_name, 'aac');
    assert(Math.abs(Number(video.duration) - Number(audio.duration)) < 0.2);
    if (name === 'vvc' && process.env.VVC_FFMPEG) {
      execFileSync(process.env.VVC_FFMPEG, ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-map', '0:v', '-an', '-f', 'null', '-']);
      ffmpeg(['-xerror', '-i', path, '-map', '0:a', '-f', 'null', '-']);
    } else ffmpeg(['-xerror', '-i', path, '-f', 'null', '-']);
    assert.equal(progress.at(-1), 1);
    if (mode !== 0) assert(progress.some(p => p > 0 && p < 1), 'Measured intermediate progress');
    if (mode === 0) {
      const hash = path => ffmpeg(['-i', path, '-map', '0:v', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
      assert.deepEqual(hash(path), hash(input), 'Original compressed video packets must stay identical');
    }
    console.log(JSON.stringify({ mode, codec: name, frames: video.nb_read_frames,
      milliseconds: Math.round(performance.now() - start), progressEvents: progress.length }));
  }
  const bvc = syntheticBvc2(join(dir, 'vvc3.mp4'));
  if (process.env.SYNTHETIC_BVC2_PATH) writeFileSync(process.env.SYNTHETIC_BVC2_PATH, bvc);
  // The pinned native VVC verifier is decoder-only (no MP4 muxer).
  // Instead repeat ordinary H.264 MP4 with system FFmpeg, then encode VVC
  // using our actual WASM binary. This tests a longer genuine encoded VVC
  // packet sequence, not a padded file with fictitious source length.
  const longInput = join(dir, 'input-long.mp4');
  ffmpeg(['-stream_loop', '7', '-i', input, '-c', 'copy',
    '-movflags', '+faststart', '-y', longInput]);
  const longCore = await createModule({ wasmBinary });
  longCore.FS.writeFile('/long-in.mp4', readFileSync(longInput));
  const longCode = await longCore.ccall('bvc2_convert', 'number',
    ['string', 'string', 'string', 'number'],
    ['/long-in.mp4', '/long-vvc.mp4', '', 3], { async: true });
  assert.equal(longCode, 0, longCore.UTF8ToString(longCore._bvc2_last_error()));
  const longVvc = join(dir, 'vvc-long.mp4');
  writeFileSync(longVvc, longCore.FS.readFile('/long-vvc.mp4'));
  const longBvc = syntheticBvc2(longVvc);
  assert(longBvc.length > 512 * 1024,
    'Long BVC2 fixture must exceed two 256 KiB media prefetch windows');
  if (process.env.SYNTHETIC_BVC2_LONG_PATH)
    writeFileSync(process.env.SYNTHETIC_BVC2_LONG_PATH, longBvc);
  // Test the dedicated BVC2 decoder and lossless original-codec muxer using
  // synthetic bvc2/bv2C framing, with no proprietary media or upstream keys.
  for (const mode of [0, 4]) {
    const core = await createModule({ wasmBinary });
    core.FS.writeFile('/bvc.mp4', bvc);
    const rc = await core.ccall('bvc2_convert', 'number',
      ['string', 'string', 'string', 'number'], ['/bvc.mp4', '/out.mp4', '', mode], { async: true });
    assert.equal(rc, 0, core.UTF8ToString(core._bvc2_last_error()));
    const out = core.FS.readFile('/out.mp4');
    if (mode === 0) {
      assert(Buffer.from(out).includes(Buffer.from('bv2C')));
      assert(Buffer.from(out).includes(Buffer.from('bvc2')));
      // Read the copied BVC2 configuration back through our own decoder.
      core.FS.writeFile('/roundtrip.mp4', out);
      const decode = await core.ccall('bvc2_transcode', 'number', ['string', 'string', 'string'],
        ['/roundtrip.mp4', '/decoded.mp4', ''], { async: true });
      assert.equal(decode, 0, core.UTF8ToString(core._bvc2_last_error()));
      writeFileSync(join(dir, 'bvc-roundtrip.mp4'), core.FS.readFile('/decoded.mp4'));
    } else writeFileSync(join(dir, 'bvc-roundtrip.mp4'), out);
    ffmpeg(['-xerror', '-i', join(dir, 'bvc-roundtrip.mp4'), '-f', 'null', '-']);
    console.log(JSON.stringify({ syntheticBvc2Framing: true, mode }));
  }
  // Same async input/output ABI as BVC2 playback, tested with a decodable
  // synthetic H.264 input. This validates transport, not BVC2 conformance.
  for (const [streamBytes, streamKey, framing] of [[raw, key, 'h264-cenc'], [longBvc, '', 'long-synthetic-bvc2']]) {
  for (const start of [0, 5.4]) {
    const units = [], reads = [];
    let highWater = 0, firstMediaReadEnd = null;
    let deliveredBytes = 0, deliveredAtFirstMedia = null;
    const assembler = createFmp4Assembler({ onInit: b => units.push(b), onMedia: b => {
      firstMediaReadEnd ??= highWater;
      deliveredAtFirstMedia ??= deliveredBytes;
      units.push(b);
    } });
    const core = await createModule({ wasmBinary,
      readRange: async (offset, count) => {
        reads.push({ offset, count });
        deliveredBytes += Math.min(count, Math.max(0, streamBytes.length - offset));
        highWater = Math.max(highWater, Math.min(streamBytes.length, offset + count));
        assert(count <= 32768);
        return streamBytes.subarray(offset, offset + count);
      },
      writeChunk: async bytes => { await assembler.push(bytes); }
    });
    const ret = await core.ccall('bvc2_stream', 'number', ['number', 'string', 'number'],
      [streamBytes.length, streamKey, start], { async: true });
    assert.equal(ret, 0, core.UTF8ToString(core._bvc2_last_error()));
    assembler.finish();
    assert(units.length >= 2);
    if (start === 0) {
      assert(deliveredAtFirstMedia < streamBytes.length,
        framing + ': first complete fMP4 fragment must precede full body delivery');
      if (framing === 'h264-cenc')
        assert(firstMediaReadEnd < streamBytes.length);
    }
    const path = join(dir, 'stream-' + start + '.mp4');
    writeFileSync(path, Buffer.concat(units));
    ffmpeg(['-xerror', '-i', path, '-f', 'null', '-']);
    console.log(JSON.stringify({ streaming: true, start, units: units.length, reads: reads.length, firstMediaReadEnd, deliveredAtFirstMedia, sourceBytes: streamBytes.length, framing }));
  }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
