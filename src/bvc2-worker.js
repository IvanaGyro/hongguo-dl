// SPDX-License-Identifier: GPL-3.0-only
// Single-job worker: canceling playback terminates the entire WASM instance.
import { readLimitedAsset } from './cenc-bundle.js';
import { verifyBvc2RuntimeBundle } from './bvc2-bundle.js';
self.onmessage = async ({ data }) => {
  let core = null;
  try {
    self.postMessage({ type: 'progress', phase: 'wasm-loading' });
    const base = new URL(import.meta.env.BASE_URL + 'bvc2/', self.location.href);
    const moduleUrl = new URL('bvc2-core.mjs', base);
    const wasmUrl = new URL('bvc2-core.wasm', base);
    const manifestResponse = await fetch(new URL('manifest.json', base),
      { cache: 'no-store' });
    const manifest = JSON.parse(new TextDecoder().decode(
      await readLimitedAsset(manifestResponse, 4096)));
    if (typeof manifest?.files?.['bvc2-core.mjs'] !== 'string' ||
        typeof manifest?.files?.['bvc2-core.wasm'] !== 'string')
      throw new Error('BVC2 release manifest missing core filenames');
    // Cache-busted filenames and hashes prevent JS from being loaded from
    // one Pages revision while WASM is loaded from another.
    moduleUrl.searchParams.set('v', manifest.files['bvc2-core.mjs']);
    wasmUrl.searchParams.set('v', manifest.files['bvc2-core.wasm']);
    const [moduleResponse, wasmResponse] = await Promise.all([
      fetch(moduleUrl, { cache: 'force-cache' }),
      fetch(wasmUrl, { cache: 'force-cache' })
    ]);
    const [moduleBytes, wasmBinary] = await Promise.all([
      readLimitedAsset(moduleResponse, 1024 * 1024),
      readLimitedAsset(wasmResponse, 32 * 1024 * 1024)
    ]);
    await verifyBvc2RuntimeBundle(manifest, moduleBytes, wasmBinary);
    const { default: createModule } = await import(/* @vite-ignore */ moduleUrl.href);
    core = await createModule({ wasmBinary,
      onProgress: progress => self.postMessage({ type: 'progress', progress }) });
    if (core._bvc2_decoder_available() !== 1)
      throw new Error('WASM 未包含 BVC2 解碼器與 x264 編碼器');
    self.postMessage({ type: 'progress', phase: 'wasm-ready' });
    const input = '/input.mp4', output = '/output.mp4';
    core.FS.writeFile(input, new Uint8Array(data.bytes));
    const modes = { original: 0, copy: 0, h264: 4, av1: 2, vvc: 3, hevc: 5 };
    if (!Object.hasOwn(modes, data.mode)) throw new Error('不支援的輸出編碼');
    self.postMessage({ type: 'progress', phase: 'transcoding' });
    const code = await core.ccall('bvc2_convert', 'number',
      ['string', 'string', 'string', 'number'],
      [input, output, data.key || '', modes[data.mode]], { async: true });
    if (code !== 0) {
      const message = core.UTF8ToString(core._bvc2_last_error());
      throw new Error(message || '轉碼結束碼 ' + code);
    }
    self.postMessage({ type: 'progress', phase: 'finalizing' });
    const bytes = core.FS.readFile(output);
    if (bytes.length === 0) throw new Error('ByteVC2 轉碼產生空白 MP4');
    self.postMessage({ ok: true, bytes: bytes.buffer }, [bytes.buffer]);
  } catch (error) {
    // No input URLs or decryption keys are included in messages or logs.
    self.postMessage({ ok: false, error: String(error?.message || error) });
  }
};
