// SPDX-License-Identifier: GPL-3.0-only
// Single-thread FFmpeg.wasm is loaded only when a job actually needs processing.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { errorWith } from './logic.js';
import { h264EncoderArgs } from './h264-download-tradeoff.js';

const MAX_FFMPEG_INPUT = 320 * 1024 * 1024;
let instance = null;
let ready = null;
let serial = Promise.resolve();
let wasmBlobUrl = null;
let wasmPromise = null;
async function compressedWasmUrl() {
  if (wasmBlobUrl) return wasmBlobUrl;
  if (!wasmPromise) wasmPromise = (async () => {
    if (typeof DecompressionStream !== 'function')
      throw errorWith('FFMPEG_ERROR', '此瀏覽器不支援 gzip DecompressionStream，無法載入 FFmpeg.wasm');
    const res = await fetch(new URL(import.meta.env.BASE_URL + 'ffmpeg/ffmpeg-core.wasm.gz', location.href));
    if (!res.ok || !res.body) throw errorWith('FFMPEG_ERROR', '無法取得 FFmpeg.wasm 壓縮核心（HTTP ' + res.status + '）');
    // The compressed artifact is smaller than Cloudflare's 25 MiB per-asset limit.
    // Unpack only on first demand, preserving an ordinary static-site deployment.
    // Some static hosts send Content-Encoding: gzip and the browser already
    // transparently decompresses the response. Sniff the actual payload so
    // Firefox never attempts to gunzip an already-decoded WebAssembly module.
    const bytes = new Uint8Array(await res.arrayBuffer());
    let wasm;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      wasm = await new Response(new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream('gzip'))).blob();
    } else if (bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
      wasm = new Blob([bytes], { type: 'application/wasm' });
    } else {
      throw errorWith('FFMPEG_ERROR', 'FFmpeg.wasm 核心資料格式錯誤（不是 gzip 或 WebAssembly）');
    }
    wasmBlobUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    return wasmBlobUrl;
  })().catch(error => { wasmPromise = null; throw error; });
  return wasmPromise;
}
async function engine() {
  if (instance && ready) { await ready; return instance; }
  const ffmpeg = new FFmpeg();
  instance = ffmpeg;
  ready = ffmpeg.load({
    coreURL: new URL(import.meta.env.BASE_URL + 'ffmpeg/ffmpeg-core.js', location.href).href,
    wasmURL: await compressedWasmUrl()
  });
  try { await ready; return ffmpeg; }
  catch (error) { instance = null; ready = null; throw errorWith('FFMPEG_ERROR', '無法載入本機 FFmpeg.wasm：' + error.message); }
}
function cancelError() { return errorWith('CANCELED', '使用者已取消'); }
async function exclusive(task, signal) {
  let release;
  const previous = serial;
  serial = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    if (signal?.aborted) throw cancelError();
    const ffmpeg = await engine();
    if (signal?.aborted) throw cancelError();
    const terminate = () => { ffmpeg.terminate(); instance = null; ready = null; };
    signal?.addEventListener('abort', terminate, { once: true });
    try { return await task(ffmpeg); }
    finally { signal?.removeEventListener('abort', terminate); }
  } finally { release(); }
}
// Start the core while the first encrypted MP4 is still downloading.
// The serialized no-op ensures the later remux uses the same initialized core.
export function prepareFfmpeg(signal) {
  return exclusive(async () => {}, signal);
}
function argsFor(mode, contentKey, input, output, h264TradeoffIndex) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (contentKey) {
    if (!/^[a-f\d]{32}$/i.test(contentKey)) throw errorWith('INVALID_KEY', '影片來源的解密金鑰格式錯誤');
    args.push('-decryption_key', contentKey);
  }
  // Never mux a separate subtitle/data stream into an output video.
  args.push('-i', input, '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn');
  if (mode === 'h264') args.push(...h264EncoderArgs(h264TradeoffIndex));
  else args.push('-c:v', 'copy');
  args.push('-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}
async function run(ffmpeg, args, signal, progress) {
  const onProgress = ({ progress: fraction }) => {
    if (Number.isFinite(fraction)) progress?.(Math.max(0, Math.min(1, fraction)));
  };
  ffmpeg.on('progress', onProgress);
  try {
    const code = await ffmpeg.exec(args);
    if (signal?.aborted) throw cancelError();
    if (code !== 0) throw errorWith('FFMPEG_ERROR', 'FFmpeg.wasm 結束碼 ' + code + '；此核心未必支援 ByteVC2/VVC、加密格式或解碼器');
  } catch (error) {
    if (signal?.aborted) throw cancelError();
    if (error?.code === 'FFMPEG_ERROR') throw error;
    throw errorWith('FFMPEG_ERROR', 'FFmpeg.wasm 處理失敗：' + (error.message || '未知錯誤'));
  } finally { ffmpeg.off('progress', onProgress); }
}
function fileId() { return crypto.randomUUID().replace(/-/g, ''); }
export async function convertBytes(bytes, { mode = 'copy', contentKey = null, signal, progress,
  h264TradeoffIndex } = {}) {
  if (!bytes?.length) throw errorWith('EMPTY_MEDIA', '沒有收到影片資料');
  if (bytes.length > MAX_FFMPEG_INPUT) throw errorWith('FFMPEG_LIMIT', '影片超過 FFmpeg.wasm 安全處理上限 320 MiB');
  return exclusive(async ffmpeg => {
    const id = fileId(), source = id + '.mp4', target = id + '_out.mp4';
    const created = [];
    try {
      await ffmpeg.writeFile(source, bytes); created.push(source);
      await run(ffmpeg, argsFor(mode, contentKey, source, target, h264TradeoffIndex), signal, progress);
      created.push(target);
      return new Uint8Array(await ffmpeg.readFile(target));
    } finally {
      for (const path of [source, target]) {
        try { await ffmpeg.deleteFile(path); } catch { /* Was not created or worker terminated. */ }
      }
    }
  }, signal);
}
// Lossless MP4 concatenation uses the concat demuxer and stream copy, never
// the concat filter or a subtitle input. The WASM virtual filesystem is
// memory-backed, so large series should use streamed ZIP rather than concat.
export async function concatLosslessly(inputs, { signal, progress } = {}) {
  if (!Array.isArray(inputs) || inputs.length < 2)
    throw errorWith('FFMPEG_ERROR', '至少選擇兩集才能無損合併');
  const total = inputs.reduce((n, item) => n + item.length, 0);
  const limit = 160 * 1024 * 1024;
  if (total > limit) throw errorWith('FFMPEG_LIMIT',
    '無損合併須在 FFmpeg.wasm 記憶體內同時保存輸入與輸出，總輸入限 160 MiB；大量集數請使用 ZIP');
  return exclusive(async ffmpeg => {
    const id = fileId();
    const created = [];
    const output = id + '_joined.mp4', playlist = id + '_concat.txt';
    try {
      const rows = [];
      for (let i = 0; i < inputs.length; i++) {
        if (signal?.aborted) throw cancelError();
        const name = id + '_' + String(i).padStart(4, '0') + '.mp4';
        await ffmpeg.writeFile(name, inputs[i]);
        created.push(name);
        rows.push("file '" + name + "'");
      }
      await ffmpeg.writeFile(playlist, new TextEncoder().encode(rows.join('\n') + '\n'));
      created.push(playlist);
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'concat', '-safe', '1', '-i', playlist,
        '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn',
        '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart',
        '-f', 'mp4', output], signal, progress);
      created.push(output);
      return new Uint8Array(await ffmpeg.readFile(output));
    } finally {
      for (const path of [...created, output]) {
        try { await ffmpeg.deleteFile(path); } catch { /* missing after abort */ }
      }
    }
  }, signal);
}
