import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCanPlayVariant, playbackRendition } from '../src/source-options.js';

const variants = [
  { url: 'https://cdn.invalid/hevc.mp4', codec: 'hevc', quality: '1080p',
    contentKey: '00112233445566778899aabbccddeeff' },
  { url: 'https://cdn.invalid/bvc2.mp4', codec: 'bytevc2', quality: '720p',
    contentKey: '00112233445566778899aabbccddeeff' }
];
const browser = mime => mime.includes('hvc1') || mime.includes('vvc1') ? 'probably' : '';

test('standard native VVC capability never implies ByteVC2 compatibility', () => {
  assert.equal(browserCanPlayVariant(variants[1], browser), false);
  assert.equal(browserCanPlayVariant({ ...variants[1], contentKey: null }, browser), false);
  assert.equal(browserCanPlayVariant(variants[1], browser, true), true);
});

test('720p with a WASM BVC2 backend uses the actual 720p source', () => {
  const selected = playbackRendition(variants, { quality: '720p', codec: 'auto' },
    browser, 0, true);
  assert.equal(selected.source.codec, 'bytevc2');
  assert.equal(selected.source.quality, '720p');
  assert.equal(selected.fallback, false);
});

test('without a WASM backend, known 720p ByteVC2 refuses cross-quality fallback', () => {
  const fallback = playbackRendition(variants, { quality: '720p', codec: 'auto' },
    browser, 0, false);
  assert.equal(fallback.source, null);
  assert.equal(fallback.fallback, false);
  const explicit = playbackRendition(variants, { quality: '720p', codec: 'bytevc2' },
    browser, 0, false);
  assert.equal(explicit.source, null);
});
