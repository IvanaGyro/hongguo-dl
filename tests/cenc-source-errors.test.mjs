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
