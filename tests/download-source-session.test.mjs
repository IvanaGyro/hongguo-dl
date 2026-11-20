import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadSourceSession } from '../src/download-source-session.js';
import { createMediaDownload } from '../src/media-download.js';
const preferences = { quality: '720p', codec: 'h264' };
const capabilities = { mimeSupport: () => true, mseSupport: () => true, canTranscodeBvc2: false };
const source = name => ({ url: `https://${name}.fqnovelvod.com/media.mp4`, source: 'app',
  quality: '720p', codec: 'h264', contentKey: '00112233445566778899aabbccddeeff' });
const options = () => ({ ...preferences, signal: new AbortController().signal });

test('layer 1 selects CDNs and refreshes a full failed cycle; consumers receive no URLs', async () => {
  let queries = 0; const fetched = [];
  const session = createDownloadSourceSession({ seriesId: '42', episode: { vid: '1' },
    sourceFor: async (...args) => {
      queries++;
      assert.equal(Boolean(args[5].refresh), queries > 1);
      return { variants: queries === 1 ? [source('a'), source('b')] : [source('a'), source('c')] };
    } });
  const download = createMediaDownload({ getWorkerOrigin: () => 'https://proxy.test',
    fetchBytes: async url => { fetched.push(url); return new Uint8Array([1, 2]); } });
  for (const code of ['CENC_SOURCE_SLOW', 'CENC_RANGE_HTTP', 'CENC_RATE_LIMITED']) {
    const list = await session.list(options());
    assert(list.variants.every(item => item.url === undefined && item.userAgent === undefined));
    const selected = session.acquire(preferences, capabilities);
    assert.equal(selected.source.url, undefined);
    assert.deepEqual(await download.read(selected.source), new Uint8Array([1, 2]));
    assert.equal(session.failed(code), true);
  }
  assert.equal(queries, 2);
  assert.deepEqual(fetched, ['a', 'b', 'c'].map(name => source(name).url));
});

test('a refreshed list cannot reintroduce failed URLs', async () => {
  let queries = 0;
  const session = createDownloadSourceSession({ seriesId: '42', episode: { vid: '1' },
    sourceFor: async () => { queries++; return { variants: [source('a')] }; } });
  const list = await session.list(options());
  session.acquire(preferences, capabilities);
  session.failed('CENC_SOURCE_SLOW');
  await assert.rejects(session.list(options()), { code: 'CENC_SOURCE_EXHAUSTED' });
  assert.equal(queries, 2);
  assert.equal(session.failed('CENC_REMUX_FAILED'), false, 'Decode errors are not CDN failure decisions');
});

test('the same download session preserves candidate history when another consumer takes over', async () => {
  let queries = 0;
  const session = createDownloadSourceSession({ seriesId: '42', episode: { vid: '1' },
    sourceFor: async () => { queries++; return { variants: [source('a'), source('b')] }; } });
  const list = await session.list(options());
  const first = session.acquire(preferences, capabilities);
  assert.equal(session.acquire(preferences, capabilities), first);
  assert.equal(session.failed('CENC_REMUX_FAILED'), false);
  assert.equal(session.acquire(preferences, capabilities), first, 'Decode work does not invalidate a healthy CDN');
  session.failed('CENC_SOURCE_SLOW');
  const nextList = await session.list(options());
  const second = session.acquire(preferences, capabilities);
  assert.equal(first.candidate, 1); assert.equal(second.candidate, 2);
  assert.equal(queries, 1);
});

test('whole-file ByteVC2 HTTP_403 rotates once to a distinct same-tier CDN', async () => {
  const sources = ['denied', 'alternate'].map(host => ({
    url: `https://${host}.fqnovelvod.com/play.mp4`,
    source: 'app', codec: 'bytevc2', quality: '720p', contentKey: null
  }));
  const options = { quality: '720p', codec: 'bytevc2' };
  const caps = { mimeSupport: () => false, mseSupport: () => false, canTranscodeBvc2: true };
  let queries = 0;
  const session = createDownloadSourceSession({
    seriesId: '42', episode: { vid: '111111111', index: 1 },
    sourceFor: async () => { queries++; return { variants: sources }; }
  });
  await session.list({ ...options, signal: new AbortController().signal });
  const first = session.acquire(options, caps);
  assert.equal(first.candidate, 1);
  assert.equal(session.failed('HTTP_429'), false, 'Rate limiting cannot rotate a CDN');
  assert.equal(session.failed('BVC2_ERROR'), false, 'Decoder errors cannot rotate a CDN');
  assert.equal(session.failed('HTTP_403'), true, 'An access refusal must retire the first CDN');
  await session.list({ ...options, signal: new AbortController().signal });
  const second = session.acquire(options, caps);
  assert.equal(second.candidate, 2);
  assert.equal(queries, 1, 'Switching already advertised CDNs must not query API again');
  assert.equal(session.failed('HTTP_403'), true, 'An exhausted tier may request fresh signed URLs');
  await assert.rejects(
    session.list({ ...options, signal: new AbortController().signal }),
    { code: 'CENC_SOURCE_EXHAUSTED' },
  );
  assert.equal(queries, 2, 'Refresh must not resurrect either rejected signed URL');
});

test('a direct HLS URL is rejected before any source query or media request', async () => {
  let queries = 0;
  const session = createDownloadSourceSession({ seriesId: null,
    episode: { vid: 'direct', url: 'https://v.fqnovelvod.com/list.m3u8' },
    sourceFor: async () => { queries++; return { variants: [] }; } });
  await assert.rejects(session.list(options()), { code: 'UNSUPPORTED_FORMAT' });
  assert.equal(queries, 0);
});

test('HLS variants from the source API are never offered to playback', async () => {
  const hls = { ...source('hls'), url: 'https://hls.fqnovelvod.com/list.m3u8' };
  const session = createDownloadSourceSession({ seriesId: '42', episode: { vid: '1' },
    sourceFor: async () => ({ variants: [hls, source('a')], winnerVariants: [hls, source('a')] }) });
  const list = await session.list(options());
  assert.equal(list.variants.length, 1);
  assert.equal(list.winnerVariants.length, 1);
  const selected = session.acquire(preferences, capabilities);
  const download = createMediaDownload({ getWorkerOrigin: () => 'https://proxy.test' });
  assert.equal(download.input(selected.source, { mode: 'direct' }).url, source('a').url);
});

test('a source list with only HLS variants fails as unsupported, not as a media error', async () => {
  const hls = { ...source('hls'), url: 'https://hls.fqnovelvod.com/list.m3u8' };
  const session = createDownloadSourceSession({ seriesId: '42', episode: { vid: '1' },
    sourceFor: async () => ({ variants: [hls] }) });
  await assert.rejects(session.list(options()), { code: 'UNSUPPORTED_FORMAT' });
});
