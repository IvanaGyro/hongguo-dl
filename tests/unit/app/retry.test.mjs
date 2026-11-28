import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { playbackRendition } from '../../../src/source-options.js';
import {
  recordFailure,
  playbackFailureMessage,
  playbackAttemptMessage
} from '../../../src/retry.js';
import { retryAfterMs } from '../../../src/retry-after.js';

describe('CDN rotation on CENC 403', () => {
  const source = {
    url: 'https://cdn.example/protected.mp4',
    contentKey: '00112233445566778899aabbccddeeff',
    codec: 'hevc', source: 'app'
  };

  test('playback retries CENC 403 with CDN rotation and existing finite limits', () => {
    const variants = ['a', 'b'].map(host => ({
      ...source, url: 'https://' + host + '.example/video.mp4', quality: '1080p'
    }));
    const error = { code: 'CENC_SOURCE_FORBIDDEN', message: 'CDN 拒絕存取影片（HTTP 403）' };
    let failure;
    const hosts = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      hosts.push(new URL(playbackRendition(variants, { quality: '1080p' },
        () => 'probably', attempt).source.url).hostname);
      failure = recordFailure(failure, error, 5, 20, { retryForbidden: true });
      assert.equal(failure.retry, attempt < 4);
    }
    assert.deepEqual(hosts, ['a.example', 'b.example', 'a.example', 'b.example', 'a.example']);
    assert.equal(failure.stoppedBy, 'repeated');
    assert.equal(recordFailure(null, { code: 'CENC_RATE_LIMITED' }, 5, 20,
      { retryForbidden: true }).retry, false, '429 policy remains unchanged');
    assert.equal(recordFailure(null, error, 5).retry, false, 'Default/download policy remains unchanged');
  });
});

describe('retry limits and status', () => {
  test('retry stops after 3 or 5 identical failures, resets on different errors', () => {
    let state;
    for (let i = 0; i < 2; i++) {
      state = recordFailure(state, { code: 'NETWORK', message: 'timeout' }, 3);
      assert.equal(state.retry, true);
    }
    state = recordFailure(state, { code: 'NETWORK', message: 'reset' }, 3);
    assert.equal(state.streak, 1);
    state = recordFailure(state, { code: 'NETWORK', message: 'reset' }, 3);
    assert.equal(state.retry, true);
    state = recordFailure(state, { code: 'NETWORK', message: 'reset' }, 3);
    assert.equal(state.retry, false);
    let playback = null;
    for (let i = 1; i <= 5; i++) {
      playback = recordFailure(playback, { code: 'PLAYBACK_ERROR', message: 'decode' }, 5);
      assert.equal(playback.retry, i < 5);
    }
    assert.equal(recordFailure(null, { code: 'CANCELED', message: 'user' }, 5).retry, false);
  });

  test('playback status distinguishes identical-error and total retry limits and exposes the cause', () => {
    const limit = 5;
    const decoderError = { code: 'FFMPEG_ERROR', message: '無法載入本機 FFmpeg.wasm' };
    let repeated;
    for (let i = 0; i < limit; i++)
      repeated = recordFailure(repeated, decoderError, limit);
    assert.equal(repeated.stoppedBy, 'repeated');
    assert.match(playbackFailureMessage(repeated, decoderError, limit), /連續相同錯誤 5 次/);
    assert.match(playbackFailureMessage(repeated, decoderError, limit), /無法載入本機 FFmpeg.wasm/);
    let alternating;
    for (let i = 0; i < 20; i++)
      alternating = recordFailure(alternating, { code: i % 2 ? 'HTTP_403' : 'FFMPEG_ERROR',
        message: i % 2 ? '媒體來源拒絕' : '解碼失敗' }, limit);
    assert.equal(alternating.streak, 1);
    assert.equal(alternating.attempts, 20);
    assert.equal(alternating.stoppedBy, 'total-limit');
    assert.match(playbackFailureMessage(alternating,
      { code: 'HTTP_403', message: '媒體來源拒絕' }, limit), /累計失敗 20 次（安全上限）/);
    const blocked = recordFailure(null, { code: 'UNSUPPORTED_FORMAT', message: '不支援 HLS' }, limit);
    assert.equal(blocked.stoppedBy, 'not-retryable');
    const tooLargeIndex = recordFailure(null, {
      code: 'CENC_METADATA_LIMIT', message: 'MP4 moov exceeds 8 MiB'
    }, limit);
    assert.equal(tooLargeIndex.stoppedBy, 'not-retryable');
    assert.equal(tooLargeIndex.retry, false);
    // A missing media core cannot recover by retrying the same episode.
    assert.equal(recordFailure(null, { code: 'MEDIA_CORE_UNAVAILABLE', message: '尚未部署' }, limit)
      .stoppedBy, 'not-retryable');
    assert.match(playbackFailureMessage(blocked,
      { code: 'UNSUPPORTED_FORMAT', message: '不支援 HLS' }, limit), /此錯誤不可重試/);
  });

  test('retry UI counts all retries and carries a brief cause into later stages', () => {
    let failure = recordFailure(null, {code: 'CENC_SOURCE_FORBIDDEN'}, 5, 20, {retryForbidden:true});
    const forbidden = {code: 'CENC_SOURCE_FORBIDDEN', message: 'https://private/?key=secret'};
    assert.match(playbackFailureMessage(failure, forbidden), /HTTP 403.*0.7 秒後進行第 1 次重試/);
    failure = recordFailure(failure, {code: 'PLAYBACK_TIMEOUT'}, 5);
    assert.equal(failure.streak, 1);
    assert.match(playbackFailureMessage(failure, {code:'PLAYBACK_TIMEOUT'}), /逾時.*第 2 次重試/);
    const stage = playbackAttemptMessage('正在讀取影片索引…', 2, forbidden);
    assert.match(stage, /第 2 次重試.*HTTP 403.*影片索引/);
    assert(!stage.includes('private') && !stage.includes('secret'));
    assert.equal(playbackAttemptMessage('正在取得影片來源…'), '正在取得影片來源…');
  });
});

describe('per-step budgets and Retry-After', () => {
  test('each step gets its own twenty-attempt budget and 429 waits for Retry-After', () => {
    let state;
    for (let i = 1; i < 20; i++) state = recordFailure(state, {
      code: 'EMPTY_RESPONSE', retryStep: 'source-app', stepAttempt: i
    }, 20, 20, { retryRateLimited: true });
    assert.equal(state.retry, true);
    const cdn = recordFailure(state, { code: 'CENC_RANGE_TIMEOUT', retryStep: 'metadata', stepAttempt: 1 }, 20, 20);
    assert.equal(cdn.attempts, 1); assert.equal(cdn.retry, true);
    const stop = recordFailure(cdn, { code: 'EMPTY_RESPONSE', retryStep: 'source-app', stepAttempt: 20 }, 20, 20);
    assert.equal(stop.retry, false); assert.match(playbackFailureMessage(stop, { code: 'EMPTY_RESPONSE' }, 20), /重新整理/);
    const limited = recordFailure(null, { code: 'CENC_RATE_LIMITED', retryStep: 'media-download', stepAttempt: 2,
      status: 429, retryAfterMs: 23000 }, 20, 20, { retryRateLimited: true });
    assert.equal(limited.retry, true); assert.equal(limited.delay, 23000);
    assert.match(playbackFailureMessage(limited, { code: 'CENC_RATE_LIMITED' }, 20), /影片資料下載第 2\/20 次/);
    assert.equal(retryAfterMs('23'), 23000); assert.equal(retryAfterMs('invalid'), null);
  });
});
