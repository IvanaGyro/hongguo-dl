import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaCache, episodeCacheKey } from '../src/media-cache.js';

test('media-cache keeps rendition metadata but not signed source URL or content key', () => {
  const cache = new MediaCache(10), key = episodeCacheKey('42', '101', '1080p', 'auto');
  const blob = new Blob(['abc']);
  assert(cache.put(key, blob, { codec: 'hevc', quality: '1080p',
    source: 'app', url: 'https://secret.example/t?token=secret', contentKey: 'PRIVATE' }));
  assert.equal(cache.get(key), blob);
  assert.deepEqual(cache.getEntry(key).source,
    { codec: 'hevc', quality: '1080p', width: undefined, height: undefined,
      duration: undefined, source: 'cache' });
  assert.equal(cache.getEntry(key).source.url, undefined);
  assert.equal(cache.getEntry(key).source.contentKey, undefined);
  assert.equal(cache.size, 3);
  assert.equal(cache.put('large', new Blob(['abcdefghijk'])), false);
});
