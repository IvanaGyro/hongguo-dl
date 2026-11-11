// SPDX-License-Identifier: GPL-3.0-only
// Single-thread FFmpeg.wasm is loaded only when a job actually needs processing.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { assertHlsManifest, selectHlsVariant, errorWith } from './logic.js';
import { planHlsMediaPlaylist, rewriteHlsMediaPlaylist } from './hls-playlist.js';

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
function argsFor(mode, contentKey, input, output, hls = false) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (contentKey) {
    if (!/^[a-f\d]{32}$/i.test(contentKey)) throw errorWith('INVALID_KEY', '影片來源的解密金鑰格式錯誤');
    args.push('-decryption_key', contentKey);
  }
  if (hls) args.push('-protocol_whitelist', 'file,crypto,data', '-allowed_extensions', 'ALL');
  args.push('-i', input, '-map', '0:v:0', '-map', '0:a?');
  if (mode === 'h264') args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
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
export async function convertBytes(bytes, { mode = 'copy', contentKey = null, signal, progress } = {}) {
  if (!bytes?.length) throw errorWith('EMPTY_MEDIA', '沒有收到影片資料');
  if (bytes.length > MAX_FFMPEG_INPUT) throw errorWith('FFMPEG_LIMIT', '影片超過 FFmpeg.wasm 安全處理上限 320 MiB');
  return exclusive(async ffmpeg => {
    const id = fileId(), source = id + '.mp4', target = id + '_out.mp4';
    const created = [];
    try {
      await ffmpeg.writeFile(source, bytes); created.push(source);
      await run(ffmpeg, argsFor(mode, contentKey, source, target), signal, progress);
      created.push(target);
      return new Uint8Array(await ffmpeg.readFile(target));
    } finally {
      for (const path of [source, target]) {
        try { await ffmpeg.deleteFile(path); } catch { /* Was not created or worker terminated. */ }
      }
    }
  }, signal);
}
async function readLimited(fetchBytes, url, signal, max = 2 * 1024 * 1024) {
  const bytes = await fetchBytes(url, signal, max);
  if (bytes.length > max) throw errorWith('HLS_MANIFEST', 'HLS 清單大小超過限制');
  return new TextDecoder().decode(bytes);
}
async function getMediaPlaylist(url, fetchBytes, signal) {
  const visited = new Set();
  for (let i = 0; i < 3; i++) {
    if (visited.has(url)) throw errorWith('HLS_MANIFEST', 'HLS 清單循環引用');
    visited.add(url);
    const text = await readLimited(fetchBytes, url, signal);
    assertHlsManifest(text);
    const variant = selectHlsVariant(text, url);
    if (!variant) return { text, url };
    url = variant;
  }
  throw errorWith('HLS_MANIFEST', 'HLS 主清單巢狀過深');
}
export async function convertHls(url, {
  mode = 'copy', contentKey = null, signal, fetchBytes, segmentProgress, progress
} = {}) {
  return exclusive(async ffmpeg => {
    const files = new Set();
    const unique = new Map();
    let size = 0;
    const id = fileId(), playlist = id + '.m3u8', output = id + '.mp4';
    try {
      const media = await getMediaPlaylist(url, fetchBytes, signal);
      const plan = planHlsMediaPlaylist(media.text);
      const total = plan.segmentCount;
      let done = 0;
      let seq = 0;
      async function stage(resource) {
        const { uri, key, kind } = resource;
        const full = new URL(uri, media.url).href;
        // A URL used both as a decryption key and as media needs distinct
        // local files and length validation, not a shared cache entry.
        const cacheKey = (key ? 'key:' : 'media:') + full;
        let name = unique.get(cacheKey);
        if (!name) {
          if (signal?.aborted) throw cancelError();
          const extension = key ? 'key' : (/\.(m4s|mp4|aac|m4a|ts)(?:$|\?)/i.exec(uri)?.[1] || 'ts');
          name = id + '_part_' + (seq++) + '.' + extension;
          const data = await fetchBytes(full, signal, Math.min(64 * 1024 * 1024, MAX_FFMPEG_INPUT - size));
          if (!data.length) throw errorWith('EMPTY_MEDIA', 'HLS 分片沒有資料');
          if (key && data.length !== 16) throw errorWith('HLS_MANIFEST', 'AES-128 HLS 金鑰必須是 16 位元組');
          size += data.length;
          if (size > MAX_FFMPEG_INPUT) throw errorWith('FFMPEG_LIMIT', 'HLS 分片合計超過 FFmpeg.wasm 安全上限');
          await ffmpeg.writeFile(name, data);
          files.add(name);
          unique.set(cacheKey, name);
        }
        // Count logical segments rather than unique URLs or URI attributes.
        // HLS playlists may repeat the same segment URI many times.
        if (kind === 'segment') {
          done++;
          segmentProgress?.({ current: done, total, bytes: size });
        }
        return name;
      }
      const localNames = [];
      for (const resource of plan.resources) {
        if (signal?.aborted) throw cancelError();
        localNames.push(await stage(resource));
      }
      const rewritten = rewriteHlsMediaPlaylist(plan, localNames);
      await ffmpeg.writeFile(playlist, new TextEncoder().encode(rewritten)); files.add(playlist);
      await run(ffmpeg, argsFor(mode, contentKey, playlist, output, true), signal, progress);
      files.add(output);
      return new Uint8Array(await ffmpeg.readFile(output));
    } finally {
      for (const path of files) { try { await ffmpeg.deleteFile(path); } catch { /* ignore */ } }
      try { await ffmpeg.deleteFile(output); } catch { /* ignore */ }
    }
  }, signal);
}
