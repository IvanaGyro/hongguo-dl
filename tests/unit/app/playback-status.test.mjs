import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackStatus } from '../../../src/playback-status.js';

test('current wait switches download → processing → playback; playing hides speculative work', () => {
  let text = ''; const events = [];
  const status = createPlaybackStatus({ render: value => text = value, log: (event, fields) => events.push([event, fields]) });
  status.update(1, '正在取得片源…', 'source');
  assert.match(text, /^下載｜正在取得片源/);
  status.update(2, '正在轉碼…', 'transcode');
  assert.match(text, /^解密／解碼｜正在轉碼/);
  status.mediaRead(2); assert.match(text, /^下載｜/);
  status.mediaRead(1); assert.match(text, /^下載｜/);
  status.mediaRead(0); assert.match(text, /^解密／解碼｜/);
  status.update(3, '正在等待畫面…', 'frame'); assert.match(text, /^播放｜/);
  status.playing(); assert.equal(text, '');
  status.mediaRead(1); assert.equal(text, '');
  status.waiting(); assert.match(text, /^下載｜/);
  assert.equal(events.at(-1)[1].layer, 1);
  status.reset(); status.update(2, '正在解碼影片…');
  assert.equal(text, '解密／解碼｜正在解碼影片…');
  assert.doesNotMatch(text, /取不到|502|重試/);
});
