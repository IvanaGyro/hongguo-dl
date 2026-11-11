import test from 'node:test';
import assert from 'node:assert/strict';
import { planHlsMediaPlaylist, rewriteHlsMediaPlaylist } from '../src/hls-playlist.js';

test('media playlist planner identifies keys, initialization maps and logical segments', () => {
  const raw = '#EXTM3U\r\n#EXT-X-TARGETDURATION:4\r\n' +
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef\r\n' +
    '#EXT-X-MAP:URI="init.mp4"\r\n#EXTINF:4,\r\nseg.ts\r\n' +
    '#EXTINF:4,\r\nseg.ts\r\n#EXT-X-ENDLIST\r\n';
  const plan = planHlsMediaPlaylist(raw);
  assert.equal(plan.segmentCount, 2);
  assert.deepEqual(plan.resources.map(({ kind, uri, key }) => ({ kind, uri, key })), [
    { kind: 'attribute', uri: 'key.bin', key: true },
    { kind: 'attribute', uri: 'init.mp4', key: false },
    { kind: 'segment', uri: 'seg.ts', key: false },
    { kind: 'segment', uri: 'seg.ts', key: false }
  ]);
  const rewritten = rewriteHlsMediaPlaylist(plan,
    ['staged_0.key', 'staged_1.mp4', 'staged_2.ts', 'staged_2.ts']);
  assert.match(rewritten, /#EXT-X-KEY:METHOD=AES-128,URI="staged_0.key"/);
  assert.match(rewritten, /#EXT-X-MAP:URI="staged_1.mp4"/);
  assert.match(rewritten, /#EXTINF:4,\nstaged_2.ts\n#EXTINF:4,\nstaged_2.ts/);
  assert.ok(rewritten.endsWith('#EXT-X-ENDLIST\n'));
  assert.deepEqual(plan.rows[5], 'seg.ts', 'source plan stays immutable');
});

test('quoted URI attributes use original offsets even if replacements vary in length', () => {
  const raw = '#EXTM3U\n#EXT-X-MEDIA:URI="one",ALTERNATE-URI="two",LANGUAGE="zh"\n' +
    '#EXTINF:1,\na.ts\n#EXT-X-ENDLIST';
  const plan = planHlsMediaPlaylist(raw);
  assert.deepEqual(plan.resources.map(x => x.uri), ['one', 'two', 'a.ts']);
  assert.equal(rewriteHlsMediaPlaylist(plan,
    ['12345678901234567890.ts', 'b.ts', 'a123456.ts']).split('\n')[1],
    '#EXT-X-MEDIA:URI="12345678901234567890.ts",ALTERNATE-URI="b.ts",LANGUAGE="zh"');
});

test('malformed, live, DRM, empty and oversized playlists fail before download', () => {
  assert.throws(() => planHlsMediaPlaylist('#EXTINF:1,\na.ts\n'), { code: 'HLS_MANIFEST' });
  assert.throws(() => planHlsMediaPlaylist('#EXTM3U\n#EXTINF:1,\na.ts\n'), { code: 'HLS_LIVE' });
  assert.throws(() => planHlsMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\na.ts\n#EXT-X-ENDLIST'), { code: 'HLS_DRM' });
  assert.throws(() => planHlsMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=k\na.ts\n#EXT-X-ENDLIST'), { code: 'HLS_MANIFEST' });
  assert.throws(() => planHlsMediaPlaylist('#EXTM3U\n#EXT-X-ENDLIST'), { code: 'HLS_MANIFEST' });
  assert.throws(() => planHlsMediaPlaylist('#EXTM3U\n' +
    'a.ts\n'.repeat(1501) + '#EXT-X-ENDLIST'), { code: 'HLS_MANIFEST' });
});

test('media playlist rewriting rejects missing or unsafe stage names', () => {
  const plan = planHlsMediaPlaylist('#EXTM3U\na.ts\n#EXT-X-ENDLIST');
  assert.throws(() => rewriteHlsMediaPlaylist(plan, []), /count/);
  assert.throws(() => rewriteHlsMediaPlaylist(plan, ['../../evil.ts']), /safe local basename/);
  assert.throws(() => rewriteHlsMediaPlaylist(plan, ['file"hack.ts']), /safe local basename/);
});
