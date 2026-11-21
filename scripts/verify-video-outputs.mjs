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
import { normalizeBvc2Config } from '../src/bvc2-config.js';

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
  const longVvc = join(dir, 'vvc-long.mp4');
  execFileSync(process.env.VVC_FFMPEG || 'ffmpeg', ['-nostdin', '-v', 'error',
    '-stream_loop', '7', '-i', join(dir, 'vvc3.mp4'), '-c', 'copy',
    '-movflags', '+faststart', '-y', longVvc]);
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
  // ByteVC2 -> VVC must copy the H.266 NAL units into vvc1/vvcC instead of
  // re-encoding. Cover both raw and configuration-record bv2C layouts.
  const vvcAnnexB = path => execFileSync(process.env.VVC_FFMPEG || 'ffmpeg', ['-nostdin', '-v', 'error', '-i', path,
    '-map', '0:v', '-c', 'copy', '-bsf:v', 'vvc_mp4toannexb', '-f', 'vvc', '-'], { maxBuffer: 32 * 1024 * 1024 });
  const sourceVvc = vvcAnnexB(join(dir, 'vvc3.mp4'));
  for (const configurationRecord of [false, true]) {
    const progress = [];
    const core = await createModule({ wasmBinary, onProgress: p => progress.push(p) });
    const framed = syntheticBvc2(join(dir, 'vvc3.mp4'), { configurationRecord });
    core.FS.writeFile('/bvc.mp4', normalizeBvc2Config(framed).bytes);
    const start = performance.now();
    const rc = await core.ccall('bvc2_convert', 'number',
      ['string', 'string', 'string', 'number'], ['/bvc.mp4', '/out.mp4', '', 3], { async: true });
    assert.equal(rc, 0, core.UTF8ToString(core._bvc2_last_error()));
    assert.equal(core._bvc2_last_remuxed(), 1, 'ByteVC2 -> VVC must remux, not re-encode');
    const path = join(dir, 'bvc-remux-' + configurationRecord + '.mp4');
    const out = core.FS.readFile('/out.mp4');
    writeFileSync(path, out);
    for (const tag of ['vvc1', 'vvcC']) assert(Buffer.from(out).includes(Buffer.from(tag)), tag);
    for (const tag of ['bvc2', 'bv2C']) assert(!Buffer.from(out).includes(Buffer.from(tag)), tag);
    assert.deepEqual(vvcAnnexB(path), sourceVvc, 'Remuxed VVC NAL units must equal the source');
    const info = probe(path, true), video = info.streams.find(s => s.codec_type === 'video');
    assert.equal(video.codec_name, 'vvc');
    if (process.env.VVC_FFMPEG) {
      assert.equal(Number(video.nb_read_frames), 96);
      execFileSync(process.env.VVC_FFMPEG, ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-map', '0:v', '-f', 'null', '-']);
    }
    assert.equal(progress.at(-1), 1);
    console.log(JSON.stringify({ syntheticBvc2Remux: 'vvc', configurationRecord,
      milliseconds: Math.round(performance.now() - start) }));
  }
  // Non-ByteVC2 input selected as VVC still goes through VVenC.
  {
    const core = await createModule({ wasmBinary });
    core.FS.writeFile('/in.mp4', raw);
    const rc = await core.ccall('bvc2_convert', 'number',
      ['string', 'string', 'string', 'number'], ['/in.mp4', '/out.mp4', key, 3], { async: true });
    assert.equal(rc, 0, core.UTF8ToString(core._bvc2_last_error()));
    assert.equal(core._bvc2_last_remuxed(), 0);
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
  // Decode-only render ABI (direct WebGL2 playback): packed I420 pictures in
  // presentation order through writeFrame, and AAC-only fMP4 for the clock.
  for (const start of [0, 5.4]) {
    const units = [], frames = [];
    const assembler = createFmp4Assembler({ onInit: b => units.push(b), onMedia: b => units.push(b) });
    const core = await createModule({ wasmBinary,
      readRange: async (offset, count) => longBvc.subarray(offset, offset + count),
      writeChunk: async bytes => { await assembler.push(bytes); },
      writeFrame: async (bytes, info) => {
        const chroma = ((info.width + 1) >> 1) * ((info.height + 1) >> 1);
        assert.equal(bytes.length, info.width * info.height + 2 * chroma, 'Packed I420 size');
        frames.push(info);
      }
    });
    const ret = await core.ccall('bvc2_play', 'number', ['number', 'string', 'number'],
      [longBvc.length, '', start], { async: true });
    assert.equal(ret, 0, core.UTF8ToString(core._bvc2_last_error()));
    assembler.finish();
    assert(frames.length > 10, 'Render mode must deliver decoded pictures');
    assert(frames.every(f => f.width === 160 && f.height === 96));
    for (let i = 1; i < frames.length; i++)
      assert(frames[i].pts > frames[i - 1].pts, 'Pictures must arrive in presentation order');
    // Never a picture before the target. The synthetic fixture's index has no
    // usable keyframe entry before 5.4 s ("Missing key frame" from the mov
    // demuxer, also seen by the transcode check above), so decoding resumes at
    // the next random-access picture; allow up to one such interval.
    if (start > 0) assert(frames[0].pts >= start - 0.05 && frames[0].pts < start + 1.5,
      'Render seek starts near the requested picture: ' + frames[0].pts);
    else assert(frames[0].pts < 0.25, 'Render start begins at the first picture: ' + frames[0].pts);
    const path = join(dir, 'render-audio-' + start + '.mp4');
    writeFileSync(path, Buffer.concat(units));
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path])).streams;
    assert.deepEqual(streams.map(s => s.codec_type), ['audio'], 'Render output muxes AAC only');
    ffmpeg(['-xerror', '-i', path, '-f', 'null', '-']);
    console.log(JSON.stringify({ render: true, start, frames: frames.length, firstPts: frames[0].pts,
      lastPts: frames.at(-1).pts, audioUnits: units.length }));
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
