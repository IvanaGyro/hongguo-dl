import test from 'node:test';
import assert from 'node:assert/strict';
import { openProgressiveMediaDownload } from '../src/progressive-media-download.js';

const data = Uint8Array.from({ length: 200000 }, (_, i) => i % 251);
function fakeResponse(start, end = data.length) {
  const bytes = data.subarray(start, end);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, Math.min(80000, bytes.length)));
      if (bytes.length > 80000) controller.enqueue(bytes.subarray(80000));
      controller.close();
    }
  }), { status: 206, headers: {
    'Content-Range': `bytes ${start}-${end - 1}/${data.length}`,
    'Content-Length': String(bytes.length)
  } });
}

test('one open-ended CDN request serves metadata and the transferable decoder stream', async () => {
  const requests = [];
  const download = await openProgressiveMediaDownload({
    url: 'https://example.test/video.mp4',
    fetchImpl: async (_url, opts) => {
      requests.push(opts.headers.Range);
      return fakeResponse(0);
    }
  });
  try {
    const metadata = await download.read(0, 65536);
    assert.equal(metadata.fileSize, data.length);
    assert.deepEqual(metadata.data, data.subarray(0, 65536));
    const shared = download.handoff();
    assert.deepEqual(shared.initialRanges[0].data, metadata.data);
    assert.equal(shared.initialOffset, 65536);
    assert.equal(shared.initialEnd, data.length);
    const transferred = structuredClone(shared.initialStream, {
      transfer: [shared.initialStream]
    });
    const reader = transferred.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    assert.deepEqual(Buffer.concat(parts), Buffer.from(data.subarray(65536)));
    assert.deepEqual(requests, ['bytes=0-']);
  } finally { download.close(); }
});

test('a short MP4 requires no second request when the 64 KiB probe exceeds its size', async () => {
  const payload = data.subarray(0, 4096), calls = [];
  const download = await openProgressiveMediaDownload({
    url: 'https://example.test/short.mp4',
    fetchImpl: async (_, opts) => {
      calls.push(opts.headers.Range);
      return new Response(payload, { status: 206, headers: {
        'Content-Range': 'bytes 0-4095/4096', 'Content-Length': '4096'
      } });
    }
  });
  try {
    const header = await download.read(0, 65536);
    assert.deepEqual(header.data, payload);
    assert.equal(download.handoff().initialOffset, 4096);
    assert.deepEqual(calls, ['bytes=0-']);
  } finally { download.close(); }
});

test('a distant moov can be fetched with a bounded seek instead of reading intervening media', async () => {
  const calls = [];
  const download = await openProgressiveMediaDownload({
    url: 'https://example.test/tail.mp4',
    fetchImpl: async (_, opts) => {
      calls.push(opts.headers.Range);
      const match = /^bytes=(\d+)-(\d*)$/.exec(opts.headers.Range);
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) + 1 : data.length;
      return fakeResponse(start, end);
    }
  });
  try {
    await download.read(0, 65536);
    assert.deepEqual((await download.read(150000, 100)).data, data.subarray(150000, 150100));
    const shared = download.handoff();
    assert.equal(shared.initialStream, null);
    assert.deepEqual(calls, ['bytes=0-', 'bytes=150000-150099']);
  } finally { download.close(); }
});

test('malformed byte-zero response is rejected without reading the video body', async () => {
  await assert.rejects(openProgressiveMediaDownload({
    url: 'https://example.test/wrong.mp4',
    fetchImpl: async () => new Response(new Uint8Array(100), {
      status: 206, headers: { 'Content-Range': 'bytes 1-100/200000' }
    })
  }), { code: 'CENC_RANGE_INVALID' });
});
