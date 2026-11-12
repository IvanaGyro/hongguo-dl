import test from 'node:test';
import assert from 'node:assert/strict';
import { idsFromUrl, urlForSeriesIds } from '../src/deep-link.js';
import { episodeFileName, collectionFileName, originalExtension } from '../src/naming.js';
import { availableRenditions, chooseRendition } from '../src/source-options.js';
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

test('stable episode filenames naturally sort, sanitise, and indicate codecs', () => {
  const base = { id: 'abcdefgh-uuid', seriesId: '7699513062054710296',
    seriesTitle: 'nova：新星', vid: '7699522762213182488', mode: 'original',
    quality: 'auto', codec: 'auto' };
  const one = episodeFileName({ ...base, index: 1 }, '.mp4');
  const sixty = episodeFileName({ ...base, index: 60 }, '.mp4');
  assert.equal(one, 'nova：新星_第001集.mp4');
  assert.equal(sixty, 'nova：新星_第060集.mp4');
  assert.ok(one < sixty);
  assert.equal(episodeFileName({ ...base, index: 2, quality: '720p', codec: 'hevc' }),
    'nova：新星_第002集_720p_hevc.mp4');
  assert.equal(originalExtension('https://cdn.example/path/video.webm?auth=abc'), '.webm');
  assert.equal(collectionFileName([
    { ...base, index: 5 }, { ...base, index: 1 }
  ], 'zip'), 'nova：新星_第1-5集.zip');
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

test('queue export chooses queue entries sorted by series and episode, not current page selection', () => {
  const entries = [
    { id: 'b', seriesId: '9', index: 10 },
    { id: 'a', seriesId: '9', index: 2 },
    { id: 'c', seriesId: '8', index: 1 }
  ];
  assert.deepEqual(orderQueueSelection(entries).map(x => x.id), ['c', 'a', 'b']);
});

test('MP4 queue export of one staged file does not re-fetch or transcode', async () => {
  const job = { id: 'abc', vid: '123', seriesId: '42', index: 1, seriesTitle: '短劇',
    mode: 'original', codec: 'h264', quality: 'auto' };
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
  assert.equal(result.filename, '短劇_第001集.mp4');
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
