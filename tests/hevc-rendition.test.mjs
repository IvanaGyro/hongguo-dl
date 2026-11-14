import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCanPlayVariant, playbackRendition } from '../src/source-options.js';

const encryptedHevc = { codec: 'hevc', quality: '1080p',
  contentKey: '00112233445566778899aabbccddeeff' };
const main10 = 'video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"';

test('precise HEVC Main declarations including the observed L186 keep 1080p selectable', () => {
  for (const prefix of ['hvc1', 'hev1']) for (const profile of ['1.6.L120.90', '1.6.L186']) {
    const actual = 'video/mp4; codecs="' + prefix + '.' + profile + ', mp4a.40.2"';
    const mseSupport = mime => mime === actual;
    assert.equal(browserCanPlayVariant(encryptedHevc, () => '', false, mseSupport), true);
    assert.equal(playbackRendition([encryptedHevc, { quality: '720p', codec: 'h264' }],
      { quality: 'auto' }, () => '', 0, false, mseSupport).source, encryptedHevc);
  }
});

test('precise HEVC Main10 MSE support can reach the encrypted rendition', () => {
  const noGenericCanPlay = () => '';
  const mseSupport = mime => mime === main10;
  assert.equal(browserCanPlayVariant(encryptedHevc,
    noGenericCanPlay, false, mseSupport), true);
  const selected = playbackRendition([encryptedHevc],
    { quality: '1080p', codec: 'auto' }, noGenericCanPlay, 0, false, mseSupport);
  assert.equal(selected.source, encryptedHevc);
  assert.equal(selected.fallback, false);
});

test('unsupported HEVC MSE does not create a false positive', () => {
  assert.equal(browserCanPlayVariant(encryptedHevc, () => '', false,
    () => false), false);
  assert.equal(playbackRendition([encryptedHevc],
    { quality: '1080p', codec: 'hevc' }, () => '', 0, false,
    () => false).source, null);
});

test('MSE-only HEVC is not used to claim unencrypted progressive MP4 support', () => {
  const clearHevc = { ...encryptedHevc, contentKey: null };
  assert.equal(browserCanPlayVariant(clearHevc, () => '', false,
    mime => mime === main10), false);
  assert.equal(browserCanPlayVariant(clearHevc,
    mime => mime === main10 ? 'maybe' : '', false, () => false), true);
});

test('HEVC encrypted rendition is selectable with only hev1 MSE support', () => {
  const hev1Main10 = 'video/mp4; codecs="hev1.2.4.L120.90, mp4a.40.2"';
  const mseSupport = mime => mime === hev1Main10;
  const unsupportedCanPlay = () => '';
  assert.equal(browserCanPlayVariant(encryptedHevc,
    unsupportedCanPlay, false, mseSupport), true);
  const selected = playbackRendition([encryptedHevc],
    { quality: '1080p', codec: 'hevc' }, unsupportedCanPlay, 0, false, mseSupport);
  assert.equal(selected.source, encryptedHevc);
  assert.equal(browserCanPlayVariant(
    { ...encryptedHevc, contentKey: null }, unsupportedCanPlay, false, mseSupport), false);
});
