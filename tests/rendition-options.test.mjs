import test from 'node:test';
import assert from 'node:assert/strict';
import { renditionOptions, parseRenditionValue, matchingRenditionValue,
  candidateRenditions } from '../src/source-options.js';

const variants = [
  { quality: '1080p', codec: 'h265', url: 'high-a' },
  { quality: '1080p', codec: 'hevc', url: 'high-b' },
  { quality: '720p', codec: 'bytevc2', url: 'low-a' }
];
test('one codec at a quality shows only the quality, deduplicating CDN URLs and aliases', () => {
  assert.deepEqual(renditionOptions(variants).map(o => o.label), ['1080p', '720p']);
  assert.deepEqual(parseRenditionValue(renditionOptions(variants)[0].value),
    { quality: '1080p', codec: 'hevc' });
});
test('only an ambiguous quality shows codec suffixes; selected pair filters download and playback', () => {
  const expanded = [...variants, { quality: '720p', codec: 'h264', url: 'low-b' }];
  const options = renditionOptions(expanded);
  assert.deepEqual(options.map(o => o.label), ['1080p', '720p（H.264）', '720p（ByteVC2）']);
  const selected = parseRenditionValue(options[1].value);
  assert.deepEqual(candidateRenditions(expanded, selected).map(v => v.url), ['low-b']);
  assert.equal(matchingRenditionValue(options, { quality: '720p', codec: 'bytevc2' }), '720p|bytevc2');
});
test('old preferences and episode codec changes retain quality; absent tiers remain detectable', () => {
  const options = renditionOptions(variants);
  assert.equal(matchingRenditionValue(options, { quality: '720p', codec: 'hevc' }), '720p|bytevc2');
  assert.equal(matchingRenditionValue(options, parseRenditionValue('1080p')), '1080p|hevc');
  assert.equal(matchingRenditionValue(options, { quality: '540p', codec: 'auto' }), null);
  assert.deepEqual(parseRenditionValue('auto'), { quality: 'auto', codec: 'auto' });
});
