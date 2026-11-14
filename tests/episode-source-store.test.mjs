import test from 'node:test';
import assert from 'node:assert/strict';
import { createEpisodeSourceStore } from '../src/episode-source-store.js';
import { initialDownloadQualityEpisode, downloadQualityOptions, hasExactDownloadQuality } from '../src/download-quality-options.js';

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
  assert.equal((await store.get('series','ep',{complete:true})).variants.length,2);
  assert.deepEqual(updates,[1,2]);
});
test('sample first restricted episode and never invent unobserved tiers', () => {
  assert.equal(initialDownloadQualityEpisode([{vid:'a',available:true},{vid:'b',available:false}]).vid,'b');
  const variants=[{quality:'720p'},{quality:'1080p'},{quality:'720p'},{quality:'public'}];
  assert.deepEqual(downloadQualityOptions(variants),['1080p','720p']);
  assert.equal(hasExactDownloadQuality(variants,'540p'),false);
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
