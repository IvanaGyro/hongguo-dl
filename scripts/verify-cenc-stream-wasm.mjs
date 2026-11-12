// Standalone Node acceptance for async Librempeg AVIO -> clear fragmented MP4.
// Use only the synthetic fixture generated inside CI. No real CDN traffic.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [modulePath, wasmPath, fixturePath, outputPath] = process.argv.slice(2);
assert(modulePath && wasmPath && fixturePath, 'Usage: verify-cenc-stream-wasm.mjs core.mjs core.wasm fixture.mp4 [out.mp4]');
const { default: createCore } = await import(pathToFileURL(modulePath).href);
const encrypted = readFileSync(fixturePath);
const chunks = [];
const key = '00112233445566778899aabbccddeeff';
let highestRequested = 0, firstMoofAt = null, calls = 0, outputLength = 0;
const core = await createCore({
  wasmBinary: readFileSync(wasmPath),
  readRange: async (offset, length) => {
    assert(offset >= 0 && offset < encrypted.byteLength);
    assert(length > 0 && length <= 1024 * 1024);
    highestRequested = Math.max(highestRequested, offset + length);
    calls++;
    // Asynchronous to exercise C AVIO callbacks + Asyncify unwinding.
    await Promise.resolve();
    return new Uint8Array(encrypted.subarray(offset, Math.min(encrypted.length, offset + length)));
  },
  writeChunk: async data => {
    chunks.push(data);
    outputLength += data.length;
    if (firstMoofAt == null && chunks.some(c => Buffer.from(c).includes('moof')))
      firstMoofAt = highestRequested;
    await Promise.resolve();
  }
});
assert.equal(core._cenc_remux_available(), 1, 'MOV demuxer or MP4 muxer missing');
const result = await core.ccall('cenc_stream_remux', 'number',
  ['number', 'string'], [encrypted.byteLength, key], { async: true });
const error = core.UTF8ToString(core._cenc_remux_error());
assert.equal(result, 0, 'CENC streaming failed: ' + error);
const output = Buffer.concat(chunks.map(c => Buffer.from(c)));
assert(firstMoofAt != null, 'no output fragment observed');
assert(firstMoofAt < encrypted.byteLength,
  'first moof arrived only after complete input was read');
for (const tag of ['ftyp', 'moov', 'mvex', 'moof', 'mdat'])
  assert(output.includes(tag), 'missing ' + tag);
assert(!output.includes('tenc'), 'output still contains encrypted sample entry');
assert(!output.includes('senc'), 'output still contains sample encryption info');
if (outputPath) writeFileSync(outputPath, output);
console.log('PASS progressive CENC -> streaming clear fMP4 WASM:', JSON.stringify({
  inputBytes: encrypted.byteLength, outputBytes: output.length,
  firstFragmentReadBytes: firstMoofAt, sourceEofAtFirstFragment: false,
  calls, moofCount: output.toString('latin1').match(/moof/g)?.length || 0
}));
