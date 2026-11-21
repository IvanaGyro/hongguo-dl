import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEpisodeSourceStore } from '../../../src/episode-source-store.js';

describe('shared episode sources', () => {
  test('share one source request across quality switches and downloads', async () => {
    let requests = 0;
    const store = createEpisodeSourceStore(async () => {
      requests++;return {variants:[{url:'https://cdn.example/a',quality:'1080p',codec:'hevc'}]};
    });
    const a = await store.get('series','ep');
    const b = await store.get('series','ep',{complete:true});
    assert.deepEqual(a.variants,b.variants);
    assert.equal(requests,1);
    await store.get('series','ep',{refresh:true});
    assert.equal(requests,2);
  });

  test('merge asynchronously arriving App renditions and publish update', async () => {
    let finish;
    const late = new Promise(done=>finish=done), updates=[];
    const store = createEpisodeSourceStore(async () => ({
      variants:[{url:'https://cdn.example/public',quality:'public'}],lateVariants:late
    }),(_sid,_vid,variants)=>updates.push(variants.length));
    const first=await store.get('series','ep');
    assert.equal(first.variants.length,1);
    finish([{url:'https://cdn.example/hevc',quality:'1080p'}]);
    await first.lateVariants;
    const complete = await store.get('series','ep',{complete:true});
    assert.equal(complete.variants.length,2);
    assert.deepEqual(complete.winnerVariants, first.variants,
      'A later higher tier must not replace the first successful list used by Auto');
    assert.deepEqual(updates,[1,2]);
  });

  test('page teardown aborts shared source I/O, including an unsignaled quality probe', async () => {
    let observed;
    const store = createEpisodeSourceStore((_sid, _vid, { signal }) => {
      observed = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('Canceled'), { code: 'CANCELED' })), { once: true }));
    });
    const sample = store.get('42', '101');
    const job = store.get('42', '101', { signal: new AbortController().signal });
    await Promise.resolve();
    const a = assert.rejects(sample, { code: 'CANCELED' });
    const b = assert.rejects(job, { code: 'CANCELED' });
    store.abortAll();
    await Promise.all([a, b]);
    assert.equal(observed.aborted, true);
    assert.equal(store.peek('42', '101'), null);
  });
});

describe('prefetch joining and failures', () => {
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
});
