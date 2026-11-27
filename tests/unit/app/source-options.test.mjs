// SPDX-License-Identifier: GPL-3.0-only
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  playbackRendition,
  renditionOptions,
  playableVariants,
  reconcileRendition,
  browserCanPlayVariant,
  parseRenditionValue,
  matchingRenditionValue,
  candidateRenditions,
  availableRenditions,
  chooseRendition,
  qualityId,
  renditionForAttempt,
  codecsAtQuality
} from '../../../src/source-options.js';

describe('automatic quality', () => {
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
});

describe('ByteVC2 renditions', () => {
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
});

describe('HEVC renditions', () => {
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
});

describe('remembered quality', () => {
  test('quality survives episode changes while vanished codecs and quality tiers do not', () => {
    const variants = [{ quality: '720p', codec: 'bytevc2' }, { quality: '1080p', codec: 'hevc' }];
    assert.deepEqual(reconcileRendition(variants, { quality: '720p', codec: 'hevc' }), { quality: '720p', codec: 'bytevc2' });
    assert.deepEqual(reconcileRendition(variants, { quality: '540p', codec: 'hevc' }), { quality: 'auto', codec: 'auto' });
    assert.deepEqual(reconcileRendition(variants, { quality: 'auto', codec: 'hevc' }), { quality: 'auto', codec: 'auto' });
  });
});

describe('rendition menu options', () => {
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
});

describe('late App candidates', () => {
  const source = label => ({ variants: [{ url: 'https://cdn.example/' + label }] });

  test('late App candidates can be selected without retrying the earlier web URL', async () => {
    const { untriedPlaybackRendition } = await import('../../../src/source-options.js');
    const variants = [
      { url: 'https://cdn.example/public', codec: 'unknown', quality: 'public' },
      { url: 'https://cdn.example/hevc', codec: 'hevc', quality: '1080p',
        contentKey: 'fixture', width: 1920, height: 1080 }
    ];
    const selected = untriedPlaybackRendition(variants, { quality: 'auto', codec: 'auto' },
      () => 'probably', new Set(['https://cdn.example/public']), false);
    assert.equal(selected.source.url, 'https://cdn.example/hevc');
  });
});

describe('CDN and codec choices', () => {
  test('Nova source variant controls expose real resolution and codec tiers', () => {
    const variants = [
      { codec: 'hevc', quality: '1080p' },
      { codec: 'bytevc2', quality: '720p', width: 1280, height: 720 },
      { codec: 'bytevc2', quality: '540p', width: 1024, height: 576 },
      { codec: 'bytevc2', quality: '480p', width: 854, height: 480 },
      { codec: 'bytevc2', quality: '360p', width: 640, height: 360 }
    ];
    const available = availableRenditions(variants);
    assert.deepEqual(available.qualities, ['1080p', '720p', '540p', '480p', '360p']);
    assert.deepEqual(available.codecs, ['hevc', 'bytevc2']);
    assert.equal(chooseRendition(variants, { quality: '540p' }).codec, 'bytevc2');
    assert.equal(chooseRendition(variants, { codec: 'hevc' }).quality, '1080p');
    assert.equal(chooseRendition(variants, { quality: '720p', codec: 'hevc' }), null);
  });

  test('mislabelled 720p HEVC does not override the actual dimensions', () => {
    const bad = { url: 'https://cdn-a.example/bad', codec: 'hevc',
      quality: '720p', width: 1920, height: 1080 };
    const good = { url: 'https://cdn-b.example/good', codec: 'bytevc2',
      quality: '720p', width: 1280, height: 720 };
    assert.equal(qualityId(bad), '1080p');
    assert.equal(qualityId({ codec: 'bytevc2', quality: '540p',
      width: 1024, height: 576 }), '540p');
    assert.equal(chooseRendition([bad, good], { quality: '720p' }), good);
    assert.equal(chooseRendition([bad, good], { quality: '720p', codec: 'hevc' }), null);
  });

  test('retries choose alternate CDN within the selected rendition', () => {
    const a = { url: 'https://cdn-a.example/one', codec: 'hevc', quality: '1080p' };
    const b = { url: 'https://cdn-b.example/two', codec: 'hevc', quality: '1080p' };
    const lower = { url: 'https://cdn-c.example/three', codec: 'bytevc2', quality: '720p' };
    const variants = [a, b, lower];
    assert.equal(renditionForAttempt(variants, { quality: '1080p' }, 0), a);
    assert.equal(renditionForAttempt(variants, { quality: '1080p' }, 1), b);
    assert.equal(renditionForAttempt(variants, { quality: '1080p' }, 2), a);
    assert.equal(renditionForAttempt(variants, { quality: '720p' }, 1), lower);
  });

  test('episode 30 720p is VVC, not HEVC; codec options follow exact quality', () => {
    const variants = [
      { codec: 'hevc', quality: '1080p', contentKey: 'encrypted' },
      { codec: 'bytevc2', quality: '720p', contentKey: 'encrypted', width: 1280, height: 720 },
      { codec: 'bytevc2', quality: '540p', contentKey: 'encrypted', width: 1024, height: 576 }
    ];
    assert.deepEqual(codecsAtQuality(variants, '720p'), ['bytevc2']);
    assert.deepEqual(codecsAtQuality(variants, '1080p'), ['hevc']);
    const allSupported = () => 'probably';
    assert.equal(browserCanPlayVariant(variants[1], allSupported), false,
      'Encrypted VVC cannot be decrypted/remuxed by the shipped FFmpeg.wasm');
    const selected = playbackRendition(variants, { quality: '720p', codec: 'auto' }, allSupported);
    assert.equal(selected.source, null, 'Known VVC-only 720p must not switch to HEVC 1080p');
    assert.equal(selected.fallback, false);
    const missingTier = playbackRendition(variants, { quality: '480p', codec: 'auto' }, allSupported);
    assert.equal(missingTier.source, variants[0], 'An unadvertised tier may use an announced fallback');
    assert.equal(missingTier.fallback, true);
    const noFallback = playbackRendition(variants,
      { quality: '720p', codec: 'auto' }, () => '');
    assert.equal(noFallback.source, null, 'No fake playable 720p should be reported');
    assert.equal(playbackRendition(variants,
      { quality: '720p', codec: 'bytevc2' }, allSupported).source, null,
      'An explicit codec selection must not silently substitute HEVC');
  });

  test('playable rendition cycles same-quality CDNs without switching codecs', () => {
    const mk = (suffix, codec, quality) =>
      ({ url: 'https://cdn.example/' + suffix, codec, quality });
    const variants = [mk('a', 'hevc', '1080p'), mk('b', 'hevc', '1080p'),
      mk('c', 'bytevc2', '720p'), mk('d', 'h264', '720p')];
    const canPlay = mime => mime.includes('avc1') ? 'probably' : '';
    const pref = { quality: '720p', codec: 'auto' };
    assert.equal(playbackRendition(variants, pref, canPlay, 0).source, variants[3]);
    assert.equal(playbackRendition(variants, pref, canPlay, 2).source, variants[3]);
    assert.deepEqual(codecsAtQuality(variants, '720p'), ['bytevc2', 'h264']);
  });
});
