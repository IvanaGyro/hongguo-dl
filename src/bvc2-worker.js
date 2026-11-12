// SPDX-License-Identifier: GPL-3.0-only
// Single-job worker: canceling playback terminates the entire WASM instance.
import { readLimitedAsset } from './cenc-bundle.js';
self.onmessage = async ({ data }) => {
  let core = null;
  try {
    const base = new URL(import.meta.env.BASE_URL + 'bvc2/', self.location.href);
    const moduleUrl = new URL('bvc2-core.mjs', base);
    const wasmUrl = new URL('bvc2-core.wasm', base);
    const [{ default: createModule }, response] = await Promise.all([
      import(/* @vite-ignore */ moduleUrl.href),
      fetch(wasmUrl, { cache: 'force-cache' })
    ]);
    // CDN/Pages can omit or lie about Content-Length. Never allocate an
    // unbounded WASM body from response.arrayBuffer() in an experiment.
    const wasmBinary = await readLimitedAsset(response, 32 * 1024 * 1024);
    core = await createModule({ wasmBinary });
    if (core._bvc2_decoder_available() !== 1)
      throw new Error('WASM 未包含 BVC2 解碼器與 x264 編碼器');
    const input = '/input.mp4', output = '/output.mp4';
    core.FS.writeFile(input, new Uint8Array(data.bytes));
    const run = core.cwrap('bvc2_transcode', 'number', ['string', 'string', 'string']);
    const code = run(input, output, data.key || '');
    if (code !== 0) {
      const message = core.UTF8ToString(core._bvc2_last_error());
      throw new Error(message || '轉碼結束碼 ' + code);
    }
    const bytes = core.FS.readFile(output);
    if (bytes.length === 0) throw new Error('ByteVC2 轉碼產生空白 MP4');
    self.postMessage({ ok: true, bytes: bytes.buffer }, [bytes.buffer]);
  } catch (error) {
    // No input URLs or decryption keys are included in messages or logs.
    self.postMessage({ ok: false, error: String(error?.message || error) });
  }
};
