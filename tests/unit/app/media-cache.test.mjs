import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { MediaCache, episodeCacheKey } from '../../../src/media-cache.js';

describe('memory buffers', () => {
  test('memory buffers are bounded and keyed by source quality/codec', () => {
    const cache = new MediaCache(8);
    assert.equal(cache.put('a', new Blob(['123456'])), true);
    assert.equal(cache.put('b', new Blob(['7890'])), true);
    assert.equal(cache.get('a'), null);
    assert.equal(cache.get('b').size, 4);
    assert.notEqual(episodeCacheKey('1', '2', 'auto', 'h264'),
      episodeCacheKey('1', '2', '720p', 'h264'));
  });
});

describe('stored metadata', () => {
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
});
