import test from 'node:test';
import assert from 'node:assert/strict';
import { nextEpisode, prefetchLeadSeconds, shouldPrefetchNext } from '../src/player-prefetch.js';

test('next-episode preload respects chronological order, including episode 30', () => {
  const episodes = [{ vid: '32', index: 32 }, { vid: '30', index: 30 },
    { vid: '31', index: 31 }];
  assert.equal(nextEpisode(episodes, '30').vid, '31');
  assert.equal(nextEpisode(episodes, '31').vid, '32');
  assert.equal(nextEpisode(episodes, '32'), null);
});

test('preload starts near ending and adapts to observed startup time', () => {
  const duration = 146.193;
  const lead = prefetchLeadSeconds(duration, 20);
  assert.equal(lead, 45);
  assert.equal(shouldPrefetchNext({ duration, position: 10 }), false);
  assert.equal(shouldPrefetchNext({ duration, position: 105 }), true);
  assert.equal(shouldPrefetchNext({ duration, position: 100 }), false);
  assert(prefetchLeadSeconds(duration, 60) > lead);
  assert(prefetchLeadSeconds(30, 200) <= 22.5);
});

test('paused, last-episode, auto-next off or data-saver blocks prefetch', () => {
  const arg = { duration: 150, position: 140 };
  for (const extra of [{ paused: true }, { hasNext: false },
    { autoNext: false }, { saveData: true }]) {
    assert.equal(shouldPrefetchNext({ ...arg, ...extra }), false);
  }
  assert.equal(shouldPrefetchNext({ ...arg, position: 150 }), false);
  assert.equal(shouldPrefetchNext({ ...arg, duration: Infinity }), false);
});
