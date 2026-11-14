import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackRendition, renditionOptions, playableVariants, reconcileRendition } from '../src/source-options.js';

test('Auto chooses the highest supported quality and player menus exclude unsupported codecs', () => {
  const variants = [
    { quality: '720p', codec: 'h264', url: 'low' },
    { quality: '1080p', codec: 'hevc', url: 'high-a' },
    { quality: '1080p', codec: 'hevc', url: 'high-b' }
  ];
  const h264Only = mime => mime.includes('avc1') ? 'probably' : '';
  assert.equal(playbackRendition(variants, {}, h264Only).source.quality, '720p');
  assert.deepEqual(renditionOptions(playableVariants(variants, h264Only)).map(o => o.label), ['720p']);
  assert.deepEqual(renditionOptions(variants).map(o => o.label), ['1080p', '720p'],
    'Download menus retain metadata independently of browser capability');
  assert.equal(playbackRendition(variants, {}, () => 'probably').source.quality, '1080p');
  assert.equal(playbackRendition([...variants,
    { quality: '1080p', codec: 'h264', url: 'high-compatible' }
  ], {}, h264Only).source.url, 'high-compatible', 'Another codec at the highest quality is valid');
});

test('same-quality codec changes reconcile internally after playable filtering', () => {
  const next = [{ quality: '720p', codec: 'bytevc2', url: 'bvc2' }];
  const allowed = playableVariants(next, () => 'probably', true);
  assert.deepEqual(reconcileRendition(allowed, { quality: '720p', codec: 'hevc' }),
    { quality: '720p', codec: 'bytevc2' });
  assert.equal(playbackRendition(allowed, reconcileRendition(allowed,
    { quality: '720p', codec: 'hevc' }), () => 'probably', 0, true).source.url, 'bvc2');
});

test('only codec ambiguity adds labels; CDN aliases and unobserved tiers do not add options', () => {
  const variants = [
    { quality: '1080p', codec: 'hevc' }, { quality: '1080p', codec: 'h265' },
    { quality: '720p', codec: 'h264' }
  ];
  assert.deepEqual(renditionOptions(variants).map(o => o.label), ['1080p', '720p']);
  assert.deepEqual(renditionOptions([...variants, { quality: '720p', codec: 'bytevc2' }])
    .map(o => o.label), ['1080p', '720p（H.264）', '720p（ByteVC2）']);
});
