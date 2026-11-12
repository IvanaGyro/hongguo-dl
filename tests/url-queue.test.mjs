import test from 'node:test';
import assert from 'node:assert/strict';
import { idsFromUrl, urlForSeriesIds } from '../src/deep-link.js';
import { episodeFileName, collectionFileName, originalExtension, filenameExtension, episodeDisplayTitle } from '../src/naming.js';
import { availableRenditions, chooseRendition, qualityId, renditionForAttempt, codecsAtQuality, browserCanPlayVariant, playbackRendition } from '../src/source-options.js';
import { orderQueueSelection, exportQueue } from '../src/queue-export.js';
import { rememberPlayback, playbackKey, watchRecords } from '../src/library.js';

test('GitHub Pages URL IDs remain exact 19-digit strings, deduplicated and capped', () => {
  const id = '7699513062054710296';
  assert.deepEqual(idsFromUrl('https://ivanagyro.github.io/hongguo-dl/?id=' + id), [id]);
  assert.deepEqual(idsFromUrl('https://example.com/?id=42,60&id=42&ids=5%3B6&series_id=7'),
    ['42', '60', '5', '6', '7']);
  assert.deepEqual(idsFromUrl('https://example.com/?id=-1&id=abc&id=1e6'), []);
  assert.deepEqual(idsFromUrl('https://example.com/?id=1,2,3', 2), ['1', '2']);
  assert.equal(new URL(urlForSeriesIds('https://example.com/?id=old&keep=yes',
    [id, '60'])).searchParams.getAll('id')[0], id);
});

test('episode filenames depend on series total, not quality/codec or chosen episode count', () => {
  const base = { id: 'abcdefgh-uuid', seriesId: '7699513062054710296',
    seriesTitle: 'nova：新星', vid: '7699522762213182488', mode: 'original',
    quality: 'auto', codec: 'auto', seriesTotal: 60 };
  const one = episodeFileName({ ...base, index: 1 }, '.mp4');
  const sixty = episodeFileName({ ...base, index: 60 }, '.mp4');
  assert.equal(one, 'nova：新星.E01.mp4');
  assert.equal(sixty, 'nova：新星.E60.mp4');
  assert.ok(one < sixty);
  assert.equal(episodeFileName({ ...base, index: 2, quality: '720p', codec: 'hevc' }),
    'nova：新星.E02.mp4');
  assert.equal(episodeFileName({ ...base, index: 2, mode: 'h264' }), 'nova：新星.E02.mp4');
  for (const [total, expected] of [
    [1, 'E02'], [9, 'E02'], [99, 'E02'], [100, 'E002'],
    [999, 'E002'], [1000, 'E0002'], [9999, 'E0002'], [10000, 'E00002']
  ]) {
    assert.equal(episodeFileName({ ...base, seriesTotal: total, index: 2 }), 'nova：新星.' + expected + '.mp4');
  }
  assert.equal(episodeFileName({ ...base, seriesTotal: 100, index: 100 }), 'nova：新星.E100.mp4');
  assert.equal(episodeFileName({ ...base, seriesTotal: 1000, index: 1000 }), 'nova：新星.E1000.mp4');
  assert.equal(episodeFileName({ ...base, seriesTotal: null, index: 2 }), 'nova：新星.E02.mp4');
  assert.equal(episodeFileName({ ...base, index: 2 }, '.mkv'), 'nova：新星.E02.mkv');
  assert.equal(episodeFileName({ id: '12345678', vid: 'direct' }, '.webm'), '媒體直連_12345678.webm');
  assert.equal(originalExtension('https://cdn.example/path/video.webm?auth=abc'), '.webm');
  assert.equal(filenameExtension('legacy_第002集.mkv'), '.mkv');
  assert.equal(filenameExtension('unknown'), '.mp4');
  assert.equal(collectionFileName([
    { ...base, index: 5 }, { ...base, index: 1 }
  ], 'zip'), 'nova：新星_第1-5集.zip');
});

test('queue labels use unpadded episode numbers, including old saved jobs', () => {
  const job = { seriesId: '42', seriesTitle: '短劇', vid: '101',
    index: 6, title: '短劇 · 第 006 集', seriesTotal: 60 };
  assert.equal(episodeDisplayTitle(job), '短劇 · 第 6 集');
  assert.equal(episodeFileName(job), '短劇.E06.mp4');
  assert.equal(episodeDisplayTitle({ ...job, index: 100, seriesTotal: 1000 }), '短劇 · 第 100 集');
  assert.equal(episodeFileName({ ...job, index: 100, seriesTotal: 1000 }), '短劇.E0100.mp4');
  assert.equal(episodeDisplayTitle({ vid: 'direct', title: '媒體直連' }), '媒體直連');
});

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

test('queue export chooses queue entries sorted by series and episode, not current page selection', () => {
  const entries = [
    { id: 'b', seriesId: '9', index: 10 },
    { id: 'a', seriesId: '9', index: 2 },
    { id: 'c', seriesId: '8', index: 1 }
  ];
  assert.deepEqual(orderQueueSelection(entries).map(x => x.id), ['c', 'a', 'b']);
});

test('MP4 queue export of one staged file does not re-fetch or transcode', async () => {
  const job = { id: 'abc', vid: '123', seriesId: '42', index: 1, seriesTotal: 100,
    seriesTitle: '短劇', mode: 'original', codec: 'h264', quality: 'auto' };
  const file = { id: 'abc', filename: '短劇_第001集.mp4',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' }), codec: 'h264' };
  let result;
  const report = await exportQueue({
    jobs: [job], type: 'mp4',
    readFile: async id => id === 'abc' ? file : null,
    currentStatus: () => 'completed',
    saveMp4: async (bytes, filename) => { result = { bytes, filename }; }
  });
  assert.equal(report.completed, 1);
  assert.equal(result.filename, '短劇.E001.mp4');
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
});

test('history cannot lose saved position on transient media-time-zero during reload', () => {
  const memory = new Map();
  const store = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) };
  rememberPlayback(store, '42', '101', 87, 100);
  rememberPlayback(store, '42', '101', 0, 100);
  assert.equal(watchRecords(store)[playbackKey('42', '101')].seconds, 87);
  rememberPlayback(store, '42', '101', 100, 100, true);
  assert.equal(watchRecords(store)[playbackKey('42', '101')].completed, true);
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
