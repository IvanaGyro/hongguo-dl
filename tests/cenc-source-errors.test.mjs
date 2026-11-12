import test from 'node:test';
import assert from 'node:assert/strict';
import { openClearKeyStream, probeCencKid } from '../src/clear-key.js';
import { recordFailure } from '../src/retry.js';

const source = {
  url: 'https://cdn.example/protected.mp4',
  contentKey: '00112233445566778899aabbccddeeff',
  codec: 'hevc', source: 'app'
};

for (const [status, code, nonRetryable] of [
  [200, 'CENC_RANGE_UNSUPPORTED', true],
  [403, 'CENC_SOURCE_FORBIDDEN', true],
  [416, 'CENC_RANGE_INVALID', true],
  [429, 'CENC_RATE_LIMITED', true],
  [503, 'CENC_RANGE_HTTP', false]
]) {
  test('CENC metadata HTTP ' + status + ' is distinguished from codec failure', async () => {
    let ranged = 0, canceled = 0, eme = 0;
    const fetchImpl = async (_url, { headers }) => {
      assert.equal(headers.Range, 'bytes=0-65535');
      ranged++;
      return { status, body: { cancel: async () => { canceled++; } } };
    };
    const check = error => {
      assert.equal(error.code, code);
      assert(!/https?:|token|key=/i.test(error.message),
        'Public errors must not include signed URLs or keys');
      const failure = recordFailure(null, error, 5);
      assert.equal(failure.retry, !nonRetryable);
      return true;
    };
    await assert.rejects(openClearKeyStream({
      video: { canPlayType: () => '' },
      source, codec: 'hevc', workerOrigin: 'https://worker.example',
      fetchImpl, requestAccess: async () => { eme++; throw new Error('unexpected EME'); }
    }), check);
    assert.equal(ranged, 1, 'A failed source must not be downloaded in full');
    assert.equal(canceled, 1, 'Range error must cancel HTTP response body');
    assert.equal(eme, 0, 'CDN error is not an EME or decode error');
    await assert.rejects(probeCencKid('https://example.test/stream', null,
      fetchImpl), { code });
  });
}

test('truncated or malformed 206 metadata never falls back to whole encrypted MP4', async () => {
  const cases = [
    {
      name: 'inconsistent Content-Range',
      range: 'bytes 1-65535/100000', bytes: 65535
    },
    {
      name: 'declared full Range but truncated body',
      range: 'bytes 0-65535/100000', bytes: 100
    },
    {
      name: 'oversized body with matching Range header',
      range: 'bytes 0-65535/100000', bytes: 65537
    },
    {
      name: 'short declared Content-Length',
      range: 'bytes 0-65535/100000', bytes: 100, contentLength: '100'
    }
  ];
  for (const scenario of cases) {
    let requests = 0;
    await assert.rejects(openClearKeyStream({
      video: { canPlayType: () => '' },
      source, codec: 'hevc', workerOrigin: 'https://worker.example',
      fetchImpl: async (_url, { headers }) => {
        requests++;
        assert.equal(headers.Range, 'bytes=0-65535');
        return new Response(new Uint8Array(scenario.bytes), {
          status: 206, headers: {
            'Content-Range': scenario.range,
            ...(scenario.contentLength ? { 'Content-Length': scenario.contentLength } : {})
          }
        });
      },
      requestAccess: async () => { throw new Error('Unexpected EME fallback'); }
    }), error => error.code === 'CENC_RANGE_INVALID' &&
      !error.message.includes('https://cdn.example'));
    assert.equal(requests, 1, scenario.name + ': no whole-episode fallback');
  }
});

test('CENC metadata fetch and read errors stay bounded, retryable and redacted', async () => {
  for (const phase of ['fetch', 'read']) {
    let calls = 0, canceled = 0;
    const fetchImpl = async (_url, { headers }) => {
      calls++;
      assert.equal(headers.Range, 'bytes=0-65535');
      if (phase === 'fetch') throw new Error('private signed URL and key=secrets');
      const reader = {
        read: async () => { throw new Error('private signed URL and key=secrets'); },
        cancel: async () => { canceled++; },
        releaseLock() {}
      };
      return {
        status: 206,
        headers: new Headers({ 'Content-Range': 'bytes 0-65535/100000' }),
        body: { getReader: () => reader }
      };
    };
    await assert.rejects(openClearKeyStream({
      video: { canPlayType: () => '' },
      source, codec: 'hevc', workerOrigin: 'https://worker.example',
      fetchImpl, requestAccess: async () => { throw new Error('Not EME'); }
    }), error => {
      assert.equal(error.code, 'CENC_RANGE_HTTP');
      assert(!/private|secret|https?:\/\//i.test(error.message));
      assert.equal(recordFailure(null, error, 5).retry, true);
      return true;
    });
    assert.equal(calls, 1, 'No full-file fallback after ' + phase + ' failed');
    assert.equal(canceled, phase === 'read' ? 1 : 0);
  }
});
