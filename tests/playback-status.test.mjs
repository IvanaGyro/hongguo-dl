import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackStatus } from '../src/playback-status.js';
import { createCachedMediaReader } from '../src/cached-media-reader.js';

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

test('only outstanding cache-miss reads report a layer-1 wait; read-ahead and cache hits do not', async () => {
  const waits = []; let release;
  const bytes = new Uint8Array(128).fill(7);
  const reader = createCachedMediaReader({ url: 'https://media.test/a', fileSize: 128, initialRanges: [{ offset: 0, data: bytes.subarray(0, 16) }],
    onStage: (stage, fields) => { if (stage === 'media.wait') waits.push(fields.pending); },
    fetchImpl: async (_url, options) => {
      const start = Number(/bytes=(\d+)-/.exec(options.headers.Range)[1]);
      return new Response(new ReadableStream({ start(controller) { release = () => { controller.enqueue(bytes.subarray(start)); controller.close(); }; } }), {
        status: 206, headers: { 'Content-Range': `bytes ${start}-127/128`, 'Content-Length': String(128 - start) }
      });
    }
  });
  try {
    assert.equal((await reader.read(0, 8)).length, 8); assert.deepEqual(waits, []);
    const pending = reader.read(16, 8);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(waits, [1]);
    release(); assert.equal((await pending).length, 8);
    assert.deepEqual(waits, [1, 0]);
    await reader.read(16, 8); reader.prefetch(true);
    assert.deepEqual(waits, [1, 0]);
  } finally { reader.close(); }
});
