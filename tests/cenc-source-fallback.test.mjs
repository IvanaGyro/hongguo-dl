import test from 'node:test';
import assert from 'node:assert/strict';
import { canTryNextCencSource } from '../src/cenc-source-fallback.js';

const hevc = (url, quality = '1080p') =>
  ({ url, codec: 'hevc', quality, contentKey: 'fixture-placeholder' });
const bytevc2 = (url, quality = '720p') =>
  ({ url, codec: 'bytevc2', quality, contentKey: 'fixture-placeholder' });
const variants = [hevc('https://cdn-a.example/1'),
  hevc('https://cdn-b.example/1'), bytevc2('https://cdn-b.example/low')];

test('one denied HEVC source permits one official same-tier alternate, then stops', () => {
  const base = { code: 'CENC_SOURCE_FORBIDDEN', variants,
    variantsVid: '101', episodeVid: '101', quality: '1080p', codec: 'hevc' };
  assert.equal(canTryNextCencSource({ ...base, tried: 1 }), true);
  assert.equal(canTryNextCencSource({ ...base, tried: 2 }), false);
  assert.equal(canTryNextCencSource({ ...base, tried: 3 }), false);
});

test('auto quality can rotate only among first top-quality HEVC CDN variants', () => {
  const base = { code: 'CENC_SOURCE_FORBIDDEN', variants,
    variantsVid: '101', episodeVid: '101', quality: 'auto', codec: 'auto' };
  assert.equal(canTryNextCencSource({ ...base, tried: 1 }), true);
  assert.equal(canTryNextCencSource({ ...base, tried: 2 }), false,
    'Never silently retry encrypted ByteVC2 at lower quality');
});

test('429, decoding failures, wrong episode and user-selected ByteVC2 never rotate', () => {
  const base = { code: 'CENC_SOURCE_FORBIDDEN', variants,
    variantsVid: '101', episodeVid: '101', tried: 1,
    quality: '1080p', codec: 'hevc' };
  for (const code of ['MEDIA_RATE_LIMITED', 'CENC_RATE_LIMITED',
    'PLAYBACK_ERROR', 'CENC_RANGE_INVALID', 'HEVC_INIT_UNSUPPORTED'])
    assert.equal(canTryNextCencSource({ ...base, code }), false);
  assert.equal(canTryNextCencSource({ ...base, episodeVid: '102' }), false);
  assert.equal(canTryNextCencSource({ ...base, quality: '720p', codec: 'bytevc2' }), false);
});

test('duplicate CDN URLs and single candidate do not cause redundant 403 retries', () => {
  const base = { code: 'CENC_SOURCE_FORBIDDEN',
    variantsVid: '101', episodeVid: '101', tried: 1,
    quality: '1080p', codec: 'hevc' };
  assert.equal(canTryNextCencSource({ ...base,
    variants: [hevc('https://cdn-a.example/1')] }), false);
  assert.equal(canTryNextCencSource({ ...base,
    variants: [hevc('https://cdn-a.example/1'), hevc('https://cdn-a.example/1')] }), false);
});

test('old Worker MEDIA_SOURCE_FORBIDDEN can rotate HEVC; not generic MEDIA_HTTP', () => {
  const base = { variants, variantsVid: '101', episodeVid: '101',
    tried: 1, quality: '1080p', codec: 'hevc' };
  assert.equal(canTryNextCencSource({ ...base, code: 'MEDIA_SOURCE_FORBIDDEN' }), true);
  assert.equal(canTryNextCencSource({ ...base, code: 'MEDIA_HTTP' }), false);
});
