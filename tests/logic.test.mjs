import test from 'node:test';
import assert from 'node:assert/strict';
import { safeName, formatBytes, selectHlsVariant, assertHlsManifest,
  classifyError, isHlsUrl, mediaProxyUrl } from '../src/logic.js';

test('filename sanitization preserves Traditional Chinese and blocks unsafe characters', () => {
  assert.equal(safeName('台灣<第1集>:?*'), '台灣_第1集____');
  assert.equal(safeName('   ...   '), 'video');
  assert.equal(safeName('a/b\\c'), 'a_b_c');
});
test('media proxy URL encodes user-supplied query and never uses it as path', () => {
  const url = mediaProxyUrl('https://x.example/video.mp4?a=1&b=2', 'app');
  assert.equal(url, '/api/media?url=https%3A%2F%2Fx.example%2Fvideo.mp4%3Fa%3D1%26b%3D2&profile=app');
});
test('sizes and HLS URL detection', () => {
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.ok(isHlsUrl('https://example.com/a.m3u8?token=abc'));
  assert.ok(!isHlsUrl('https://example.com/a.mp4'));
});
test('HLS master selects highest bandwidth and rejects live/DRM', () => {
  const txt = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20000\nhi.m3u8\n';
  assert.equal(selectHlsVariant(txt, 'https://example.com/master.m3u8'), 'https://example.com/hi.m3u8');
  assert.doesNotThrow(() => assertHlsManifest(txt));
  assert.throws(() => assertHlsManifest('#EXTM3U\n#EXTINF:3,\na.ts\n'), { code: 'HLS_LIVE' });
  assert.throws(() => assertHlsManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXT-X-ENDLIST\n'), { code: 'HLS_DRM' });
});
test('errors are safe for UI display', () => {
  assert.equal(classifyError({ code: 'EMPTY_MEDIA', message: 'no bytes' }).code, 'EMPTY_MEDIA');
  assert.equal(classifyError({ name: 'AbortError' }).code, 'CANCELED');
});
