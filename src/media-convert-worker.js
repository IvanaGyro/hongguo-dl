// SPDX-License-Identifier: GPL-3.0-only
// Single-job Worker for whole-file conversion and lossless concat through the
// unified media core. Canceling terminates this Worker and every pthread.
import { normalizeBvc2Config } from './bvc2-config.js';
import { loadMediaCore, mediaPoolSize, mediaCoreVariant } from './media-core.js';

export const CONVERT_MODES = Object.freeze({ original: 0, copy: 0, h264: 4, av1: 2, vvc: 3, hevc: 5 });
let prepared = null;
const progress = message => self.postMessage({ type: 'progress', ...message });

let loading = null;
function core(mode, threads) {
  loading ??= load(mode, threads).catch(failure => { loading = null; throw failure; });
  return loading;
}
async function load(mode, threads) {
  const variant = mediaCoreVariant(self);
  progress({ phase: 'wasm-loading', variant });
  prepared = await loadMediaCore({ baseHref: self.location.href, variant,
    poolSize: mediaPoolSize(mode, threads, variant),
    hooks: { onProgress: value => progress({ progress: value }), printErr: () => {} } });
  console.info('[media-core] ' + (variant === 'mt' ? 'multi-thread' : 'single-thread') +
    ' core, encoder threads ' + threads + ', pthread pool ' + mediaPoolSize(mode, threads, variant));
  progress({ phase: 'wasm-ready', variant });
  return prepared;
}
const error = (wasm, code) => wasm.UTF8ToString(wasm._media_last_error()) || '轉碼結束碼 ' + code;
const tidy = (wasm, paths) => { for (const path of paths) try { wasm.FS.unlink(path); } catch { /* absent */ } };

async function convert(data) {
  if (!Object.hasOwn(CONVERT_MODES, data.mode)) throw new Error('不支援的輸出編碼');
  const threads = Number.isInteger(data.threads) ? data.threads : 1;
  const wasm = await core(data.mode, threads);
  const input = '/input.mp4', output = '/output.mp4';
  const normalized = normalizeBvc2Config(new Uint8Array(data.bytes), { inPlace: true });
  if (normalized.changed) progress({ phase: 'config-normalized' });
  wasm.FS.writeFile(input, normalized.bytes);
  progress({ phase: 'transcoding' });
  try {
    const code = await wasm.ccall('media_convert', 'number',
      ['string', 'string', 'string', 'number', 'string', 'number', 'number'],
      [input, output, data.key || '', CONVERT_MODES[data.mode], data.preset || '',
        Number(data.quality) | 0, threads], { async: true });
    if (code !== 0) throw new Error(error(wasm, code));
    progress({ phase: 'finalizing' });
    return { bytes: wasm.FS.readFile(output), remuxed: wasm._media_last_remuxed() === 1 };
  } finally { tidy(wasm, [input, output]); }
}

async function concat(data) {
  const wasm = await core('copy', 1);
  const id = crypto.randomUUID().replace(/-/g, '');
  const names = data.inputs.map((_, i) => id + '_' + String(i).padStart(4, '0') + '.mp4');
  const list = '/' + id + '.ffconcat', output = '/' + id + '_joined.mp4';
  try {
    data.inputs.forEach((bytes, i) => wasm.FS.writeFile('/' + names[i], new Uint8Array(bytes)));
    // Relative names only: the concat demuxer runs with safe=1.
    wasm.FS.writeFile(list, 'ffconcat version 1.0\n' + names.map(name => "file '" + name + "'\n").join(''));
    progress({ phase: 'transcoding' });
    const code = await wasm.ccall('media_concat', 'number', ['string', 'string'], [list, output],
      { async: true });
    if (code !== 0) throw new Error(error(wasm, code));
    progress({ phase: 'finalizing' });
    return { bytes: wasm.FS.readFile(output), remuxed: false };
  } finally { tidy(wasm, [list, output, ...names.map(name => '/' + name)]); }
}

self.onmessage = async ({ data }) => {
  try {
    // A failed warm-up is retried by the job itself; never report it as one.
    if (data?.op === 'prepare') { await core(data.mode || 'copy', data.threads || 1).catch(() => {}); return; }
    const result = data?.op === 'concat' ? await concat(data) : await convert(data);
    if (!result.bytes.length) throw new Error('轉碼產生空白 MP4');
    // FS.readFile copies out of (possibly shared) WASM memory: transferable.
    const bytes = result.bytes.buffer;
    self.postMessage({ ok: true, bytes, remuxed: result.remuxed, variant: prepared?.mediaVariant,
      threads: data.threads || 1 }, [bytes]);
  } catch (failure) {
    // No input URLs or decryption keys are included in messages or logs.
    self.postMessage({ ok: false, error: String(failure?.message || failure) });
  }
};
