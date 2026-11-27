// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticBuffer } from '../../../src/playback-diagnostics.js';

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

test('diagnostics retain exact HEVC codec declarations and support results', () => {
  const b = createDiagnosticBuffer(() => 0);
  b.log('cenc.stage', { phase: 'mse.codec-check', codecString: 'hvc1.1.6.L186',
    primarySupported: false, alternateSupported: true });
  assert.match(b.text(), /codecString=hvc1\.1\.6\.L186/);
  assert.match(b.text(), /primarySupported=false alternateSupported=true/);
});

test('diagnostics keep numeric series and episode IDs only in their named fields', () => {
  const b = createDiagnosticBuffer(() => 0);
  b.log('source.api.request', { seriesId: '7451234567890123456', vid: '7451234567890999999',
    deviceId: '1234567890123456789', vidUrl: 'https://cdn.example/7451234567890999999' });
  assert.match(b.text(), /seriesId=7451234567890123456/);
  assert.match(b.text(), /vid=7451234567890999999/);
  assert.match(b.text(), /deviceId=\[redacted\]/);
  assert.match(b.text(), /vidUrl=\[redacted\]/);
  b.log('source.api.request', { vid: 'https://cdn.example/private' });
  assert.doesNotMatch(b.text(), /cdn\.example/);
});
