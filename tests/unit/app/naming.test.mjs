import test from 'node:test';
import assert from 'node:assert/strict';
import {
  episodeFileName,
  collectionFileName,
  originalExtension,
  filenameExtension,
  episodeDisplayTitle
} from '../../../src/naming.js';

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
