// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticBuffer } from '../src/playback-diagnostics.js';
import { blockHevcFullFileFallback } from '../src/playback-policy.js';

test('diagnostics redact URLs and keys and have a bounded log', () => {
  let ms = 0;
  const b = createDiagnosticBuffer(() => ms++);
  b.log('cenc.stage', {
    phase: 'media-range', status: 206,
    source: 'https://example.com/video?token=private',
    key: 'f'.repeat(32), details: { secrets: 'private' }
  });
  assert.match(b.text(), /status=206/);
  assert.match(b.text(), /phase=media-range/);
  assert.doesNotMatch(b.text(), /example\.com|token=private|fffff|secrets/);
  assert.match(b.text(), /source=\[redacted\]/);
  for (let i = 0; i < 440; i++) b.log('media.progress', { time: i });
  assert.equal(b.size(), 400);
  b.clear();
  assert.equal(b.text(), '');
});

test('HEVC CENC MP4 rejects whole-file playback fallback', () => {
  const video = { codec: 'hevc', contentKey: 'placeholder', url: 'https://example.com/x.mp4' };
  assert.equal(blockHevcFullFileFallback(video), true);
  assert.equal(blockHevcFullFileFallback({ ...video, codec: 'bytevc2' }), false);
  assert.equal(blockHevcFullFileFallback({ ...video, contentKey: null }), false);
  assert.equal(blockHevcFullFileFallback({ ...video, url: 'https://example.com/x.m3u8' }), false);
});


test('diagnostics show resolution label but redact unsafe strings', () => {
  const b = createDiagnosticBuffer(() => 0);
  b.log('source.selected', { quality: '1080p', codec: 'hevc',
    suspicious: 'https://cdn.example/private' });
  assert.match(b.text(), /quality=1080p/);
  assert.match(b.text(), /codec=hevc/);
  assert.match(b.text(), /suspicious=\[redacted\]/);
});

test('diagnostics preserve complete numeric buffer/cache intervals but reject nested secrets', () => {
  const b = createDiagnosticBuffer(() => 0);
  b.log('media.progress', { bufferedRanges: [[0.16, 30], [90, 140]], byteRanges: [[0, 65536]],
    unsafe: [['https://secret', 4]], malformed: [[10, 1]] });
  assert.match(b.text(), /bufferedRanges=\[\[0.16,30\],\[90,140\]\]/);
  assert.match(b.text(), /byteRanges=\[\[0,65536\]\]/);
  assert.doesNotMatch(b.text(), /https|secret/);
  assert.match(b.text(), /malformed=\[redacted\]/);
});
