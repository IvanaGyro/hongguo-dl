import test from 'node:test';
import assert from 'node:assert/strict';
import { createEpisodeSourceStore } from '../src/episode-source-store.js';
import { recordFailure, playbackFailureMessage } from '../src/retry.js';
import { playbackStage } from '../src/playback-stage.js';
import { retryAfterMs } from '../src/retry-after.js';
import { withRangeDeadline } from '../src/range-deadline.js';

test('foreground joining prefetch sees its current operation; subscriptions detach independently', async () => {
  let notify, finish; const background = [], foreground = [], canceled = [];
  const store = createEpisodeSourceStore((_sid, _vid, { onStage, attempts }) => {
    notify = onStage;
    const attempt = attempts.begin('source-app');
    onStage('source.wait', { tasks: [{ phase: 'source-app', attempt }] });
    return new Promise(resolve => { finish = resolve; });
  });
  const preload = store.get('42', '101', { onStage: (...args) => background.push(args) });
  await Promise.resolve();
  const abort = new AbortController();
  const abandoned = store.get('42', '101', { signal: abort.signal, onStage: (...args) => canceled.push(args) });
  const active = store.get('42', '101', { onStage: (...args) => foreground.push(args) });
  assert.equal(foreground[0][1].tasks[0].attempt, 1);
  const stopped = assert.rejects(abandoned, { code: 'CANCELED' }); abort.abort(); await stopped;
  notify('source.wait', { tasks: [{ phase: 'source-app', attempt: 1 }, { phase: 'device-register', attempt: 2 }] });
  assert.equal(canceled.length, 1); assert.equal(foreground.length, 2);
  finish({ variants: [{ url: 'https://cdn.test/a' }] });
  const [a, b] = await Promise.all([preload, active]); assert.equal(a.attempts, b.attempts);
  const completedEvents = foreground.length;
  notify('source.wait', { tasks: [] }); assert.equal(foreground.length, completedEvents);
});

test('source query failures from prefetch count toward the same episode limit, independently of CDN probes', async () => {
  let calls = 0;
  const store = createEpisodeSourceStore(async (_sid, _vid, { attempts }) => {
    const attempt = attempts.begin('source-app'); calls++;
    if (attempt < 20) throw attempts.decorate(Object.assign(new Error('empty'), { code: 'EMPTY_RESPONSE' }), 'source-app');
    return { variants: [{ url: 'https://cdn.test/a' }] };
  });
  for (let i = 1; i < 20; i++) await assert.rejects(store.get('42', '101'), error => error.stepAttempt === i);
  const handed = await store.get('42', '101'); assert.equal(handed.attempts.count('source-app'), 20);
  assert.equal(handed.attempts.begin('cdn-probe'), 1);
  await assert.rejects(store.get('42', '101', { refresh: true }), { code: 'PLAYBACK_STEP_LIMIT', stepAttempt: 20 });
  assert.equal(calls, 20);
  await assert.rejects(store.get('42', '102'), error => error.stepAttempt === 1); // A different episode starts at one.
});

test('each step gets its own twenty-attempt budget and 429 waits for Retry-After', () => {
  let state;
  for (let i = 1; i < 20; i++) state = recordFailure(state, {
    code: 'EMPTY_RESPONSE', retryStep: 'source-app', stepAttempt: i
  }, 20, 20, { retryRateLimited: true });
  assert.equal(state.retry, true);
  const cdn = recordFailure(state, { code: 'CENC_RANGE_TIMEOUT', retryStep: 'metadata', stepAttempt: 1 }, 20, 20);
  assert.equal(cdn.attempts, 1); assert.equal(cdn.retry, true);
  const stop = recordFailure(cdn, { code: 'EMPTY_RESPONSE', retryStep: 'source-app', stepAttempt: 20 }, 20, 20);
  assert.equal(stop.retry, false); assert.match(playbackFailureMessage(stop, { code: 'EMPTY_RESPONSE' }, 20), /重新整理/);
  const limited = recordFailure(null, { code: 'CENC_RATE_LIMITED', retryStep: 'media-download', stepAttempt: 2,
    status: 429, retryAfterMs: 23000 }, 20, 20, { retryRateLimited: true });
  assert.equal(limited.retry, true); assert.equal(limited.delay, 23000);
  assert.match(playbackFailureMessage(limited, { code: 'CENC_RATE_LIMITED' }, 20), /影片資料下載第 2\/20 次/);
  assert.equal(retryAfterMs('23'), 23000); assert.equal(retryAfterMs('invalid'), null);
});

test('beta text distinguishes registration, source lists, CDN candidates and actual metadata byte reads', () => {
  assert.match(playbackStage('source.wait', { tasks: [{ phase: 'device-register', attempt: 3 }] }).message, /裝置.*第 3\/20 次/);
  assert.match(playbackStage('source.wait', { tasks: [{ phase: 'source-app', attempt: 4 }] }).message, /畫質候選.*第 4\/20 次/);
  assert.match(playbackStage('cdn.selected', { candidate: 2, attempt: 5 }).message, /CDN #2.*第 5\/20 次/);
  assert.match(playbackStage('range.retry', { part: 'moov', offset: 28, bytes: 90668, candidate: 2, attempt: 6, status: 502 }).message,
    /moov.*bytes 28–90695.*HTTP 502.*CDN #2.*第 6\/20 次/);
});

test('metadata progress cannot keep its hard total cap alive forever', async () => {
  let canceled = false;
  await assert.rejects(withRangeDeadline(async (signal, progress) => {
    signal.addEventListener('abort', () => { canceled = true; });
    const timer = setInterval(progress, 10);
    try { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
    finally { clearInterval(timer); }
  }, undefined, 40, { maxDurationMs: 100 }), { code: 'CENC_RANGE_TIMEOUT' });
  assert.equal(canceled, true);
});
