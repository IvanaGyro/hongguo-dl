import test from 'node:test';
import assert from 'node:assert/strict';
import { safeName, formatBytes, assertSupportedMediaUrl,
  classifyError, isHlsUrl, mediaProxyUrl, apiUrl, normalizeWorkerOrigin, chooseWorkerOrigin } from '../src/logic.js';

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
test('HLS playlists are rejected as an unsupported format', () => {
  assert.throws(() => assertSupportedMediaUrl('https://example.com/a.m3u8?token=abc'), { code: 'UNSUPPORTED_FORMAT' });
  assert.doesNotThrow(() => assertSupportedMediaUrl('https://example.com/a.mp4'));
  assert.equal(classifyError({ code: 'UNSUPPORTED_FORMAT' }).code, 'UNSUPPORTED_FORMAT');
});
test('errors are safe for UI display', () => {
  assert.equal(classifyError({ code: 'EMPTY_MEDIA', message: 'no bytes' }).code, 'EMPTY_MEDIA');
  assert.equal(classifyError({ name: 'AbortError' }).code, 'CANCELED');
});

test('separate Worker origin uses HTTPS and preserves API path', () => {
  assert.equal(normalizeWorkerOrigin('https://test.example/'), 'https://test.example');
  assert.equal(apiUrl('/api/health', 'https://test.example/'), 'https://test.example/api/health');
  assert.equal(mediaProxyUrl('https://cdn.example/a.mp4', 'web', 'https://test.example'),
    'https://test.example/api/media?url=https%3A%2F%2Fcdn.example%2Fa.mp4&profile=web');
  assert.throws(() => apiUrl('/ffmpeg/core.js', 'https://test.example'));
  assert.throws(() => normalizeWorkerOrigin('http://attacker.example'));
  assert.throws(() => normalizeWorkerOrigin('https://test.example/malicious-path'));
});

test('PROXY-provided default is used unless a valid browser override exists', () => {
  const built = 'https://hongguo-dl.example.workers.dev/';
  assert.equal(chooseWorkerOrigin('', built), 'https://hongguo-dl.example.workers.dev');
  assert.equal(chooseWorkerOrigin(null, built), 'https://hongguo-dl.example.workers.dev');
  assert.equal(chooseWorkerOrigin('https://custom.example/', built), 'https://custom.example');
  assert.equal(chooseWorkerOrigin('not a URL', built), 'https://hongguo-dl.example.workers.dev');
  assert.equal(chooseWorkerOrigin('http://unsafe.example', built), 'https://hongguo-dl.example.workers.dev');
  assert.equal(chooseWorkerOrigin('', ''), '');
});


test('legacy Worker MEDIA_HTTP 403 and 429 are classified as media access, not codec failure', () => {
  const denied = classifyError({ code: 'MEDIA_HTTP', message: '媒體來源回傳 HTTP 403' });
  assert.equal(denied.code, 'MEDIA_SOURCE_FORBIDDEN');
  assert.match(denied.message, /CDN.*403/);
  assert.match(denied.message, /不是影音解碼失敗/);
  const limited = classifyError({ code: 'MEDIA_HTTP', message: '媒體來源回傳 HTTP 429' });
  assert.equal(limited.code, 'MEDIA_RATE_LIMITED');
  assert.match(limited.message, /429/);
  assert.equal(classifyError({ code: 'MEDIA_HTTP', message: '媒體來源回傳 HTTP 500' }).code, 'MEDIA_HTTP');
});
