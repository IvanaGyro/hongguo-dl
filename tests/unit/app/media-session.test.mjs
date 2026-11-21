// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the bvc2_stream URL option no longer exists; ByteVC2 always starts on streaming', () => {
  for (const file of ['src/player.js', 'src/media-session.js'])
    assert.doesNotMatch(readFileSync(new URL('../../../' + file, import.meta.url), 'utf8'), /bvc2_stream|bvc2Mode/);
});

test('HEVC CENC uses the shared fallback policy rather than a codec block', () => {
  assert.doesNotMatch(readFileSync(new URL('../../../src/media-session.js', import.meta.url), 'utf8'),
    /blockHevcFullFileFallback|增量串流重試失敗，已禁止整檔備援下載/);
});
