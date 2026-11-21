import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  recentSeries,
  rememberSeries,
  forgetSeries,
  playbackKey,
  rememberPlayback,
  watchRecords,
  suggestedEpisode
} from '../../../src/library.js';

describe('watch history', () => {
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

  test('CENC 55s seek progress survives a temporary 0s media-source reload', () => {
    const storage = fakeStorage();
    rememberPlayback(storage, '123456789', '111111111', 55.8, 70);
    const key = playbackKey('123456789', '111111111');
    assert.equal(watchRecords(storage)[key].completed, false);
    rememberPlayback(storage, '123456789', '111111111', 0, 70);
    assert.equal(watchRecords(storage)[key].seconds, 55.8);
    assert.equal(watchRecords(storage)[key].completed, false);
  });
});

describe('history across media reloads', () => {
  test('history cannot lose saved position on transient media-time-zero during reload', () => {
    const memory = new Map();
    const store = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) };
    rememberPlayback(store, '42', '101', 87, 100);
    rememberPlayback(store, '42', '101', 0, 100);
    assert.equal(watchRecords(store)[playbackKey('42', '101')].seconds, 87);
    rememberPlayback(store, '42', '101', 100, 100, true);
    assert.equal(watchRecords(store)[playbackKey('42', '101')].completed, true);
  });
});
