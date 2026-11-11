import test from 'node:test';
import assert from 'node:assert/strict';
import { recentSeries, rememberSeries, forgetSeries, playbackKey, rememberPlayback,
  watchRecords, suggestedEpisode } from '../src/library.js';
import { recordFailure } from '../src/retry.js';
import { MediaCache, episodeCacheKey } from '../src/media-cache.js';
function fakeStorage() {
  const map = new Map();
  return {
    getItem: k => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => map.set(k, v),
    removeItem: k => map.delete(k)
  };
}
test('episode history persists title and IDs but never signed URLs', () => {
  const storage = fakeStorage();
  const series = { kind: 'series', seriesId: '123', title: '短劇',
    total: 3, episodes: [
      { vid: 'a', index: 1, url: 'https://secret.example/?token=TOPSECRET' },
      { vid: 'b', index: 2 }, { vid: 'c', index: 3 }
    ] };
  rememberSeries(storage, series);
  assert.equal(recentSeries(storage)[0].title, '短劇');
  assert.ok(!JSON.stringify(recentSeries(storage)).includes('TOPSECRET'));
  rememberSeries(storage, { ...series, title: '改名' });
  assert.equal(recentSeries(storage).length, 1);
  assert.equal(recentSeries(storage)[0].title, '改名');
  rememberSeries(storage, { ...series, kind: 'direct', seriesId: null });
  assert.equal(recentSeries(storage).length, 1);
  forgetSeries(storage, '123');
  assert.equal(recentSeries(storage).length, 0);
});
test('watched and resume positions persist independently for each episode', () => {
  const storage = fakeStorage();
  const series = { seriesId: '9', episodes: [
    { vid: '1', index: 1 }, { vid: '2', index: 2 }, { vid: '3', index: 3 }
  ] };
  rememberPlayback(storage, '9', '1', 100, 100, true);
  rememberPlayback(storage, '9', '2', 22, 100);
  const records = watchRecords(storage);
  assert.equal(records[playbackKey('9', '1')].completed, true);
  assert.equal(records[playbackKey('9', '2')].seconds, 22);
  assert.equal(suggestedEpisode(series, records).vid, '2');
  rememberPlayback(storage, '9', '2', 100, 100, true);
  assert.equal(suggestedEpisode(series, watchRecords(storage)).vid, '3');
});
test('retry stops after 3 or 5 identical failures, resets on different errors', () => {
  let state;
  for (let i = 0; i < 2; i++) {
    state = recordFailure(state, { code: 'NETWORK', message: 'timeout' }, 3);
    assert.equal(state.retry, true);
  }
  state = recordFailure(state, { code: 'NETWORK', message: 'reset' }, 3);
  assert.equal(state.streak, 1);
  state = recordFailure(state, { code: 'NETWORK', message: 'reset' }, 3);
  assert.equal(state.retry, true);
  state = recordFailure(state, { code: 'NETWORK', message: 'reset' }, 3);
  assert.equal(state.retry, false);
  let playback = null;
  for (let i = 1; i <= 5; i++) {
    playback = recordFailure(playback, { code: 'PLAYBACK_ERROR', message: 'decode' }, 5);
    assert.equal(playback.retry, i < 5);
  }
  assert.equal(recordFailure(null, { code: 'CANCELED', message: 'user' }, 5).retry, false);
});
test('memory buffers are bounded and keyed by source quality/codec', () => {
  const cache = new MediaCache(8);
  assert.equal(cache.put('a', new Blob(['123456'])), true);
  assert.equal(cache.put('b', new Blob(['7890'])), true);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b').size, 4);
  assert.notEqual(episodeCacheKey('1', '2', 'auto', 'h264'),
    episodeCacheKey('1', '2', '720p', 'h264'));
});
