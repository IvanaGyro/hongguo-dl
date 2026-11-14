import test from 'node:test';
import assert from 'node:assert/strict';
import { canTryNextCencSource, sameTierHevcCandidates } from '../src/cenc-source-fallback.js';

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


test('HEVC retry candidates stay at original quality and remove duplicates', () => {
  const candidates = sameTierHevcCandidates([
    hevc('https://cdn-a.example/1'), hevc('https://cdn-a.example/1'),
    hevc('https://cdn-b.example/1'),
    hevc('https://cdn-c.example/lower', '720p'),
    bytevc2('https://cdn-d.example/1')
  ], { quality: 'auto', codec: 'auto' }, { codec: 'hevc', quality: '1080p' });
  assert.deepEqual(candidates.map(v => v.url), [
    'https://cdn-a.example/1', 'https://cdn-b.example/1'
  ]);
});

test('timeouts and 520 network errors rotate by actual tried URLs, ignoring API failure counts', () => {
  const base = { variants, variantsVid:'101', episodeVid:'101', quality:'1080p', codec:'hevc',
    tier: { quality:'1080p', codec:'hevc' }, tried: 7,
    triedUrls: new Set(['https://cdn-a.example/1']) };
  for (const code of ['CENC_RANGE_HTTP', 'CENC_RANGE_TIMEOUT']) {
    assert.equal(canTryNextCencSource({ ...base, code }), true);
    assert.equal(canTryNextCencSource({ ...base, code,
      triedUrls: new Set(['https://cdn-a.example/1','https://cdn-b.example/1']) }), false);
  }
  assert.equal(canTryNextCencSource({ ...base, code:'CENC_RATE_LIMITED' }), false);
});

test('ByteVC2 HTTP refusal rotates distinct same-quality sources without changing codec', () => {
  const variants = [{ quality: '720p', codec: 'bytevc2', url: 'https://cdn/a' },
    { quality: '720p', codec: 'bytevc2', url: 'https://cdn/b' },
    { quality: '720p', codec: 'hevc', url: 'https://cdn/c', contentKey: 'key' }];
  const args = { code: 'MEDIA_SOURCE_FORBIDDEN', variants, variantsVid: '12', episodeVid: '12',
    tried: 1, triedUrls: new Set(['https://cdn/a']), tier: { quality: '720p', codec: 'bytevc2' },
    quality: '720p', codec: 'bytevc2' };
  assert.equal(canTryNextCencSource(args), true);
  assert.equal(canTryNextCencSource({ ...args, triedUrls: new Set(['https://cdn/a','https://cdn/b']) }), false);
});
