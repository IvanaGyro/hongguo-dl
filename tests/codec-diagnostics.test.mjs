import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCodecCapabilities } from '../src/codec-diagnostics.js';

test('capability report distinguishes MSE, canPlayType and MediaCapabilities', async () => {
  const reports = [];
  const data = await inspectCodecCapabilities({
    video: { canPlayType: mime => mime.includes('vvc1') ? '' : 'maybe' },
    mediaSource: { isTypeSupported: mime => !mime.includes('vvc1') },
    decodingInfo: async config => {
      reports.push(config);
      return { supported: true, smooth: true, powerEfficient: false };
    }
  });
  assert.equal(data.schema, 1);
  assert.equal(data.hasMediaSource, true);
  assert.equal(data.formats.length, 4);
  assert.equal(data.formats[0].codec, 'H.264 + AAC');
  assert.equal(data.formats[1].codec, 'HEVC + AAC');
  assert.equal(data.formats[1].canPlayType, 'maybe');
  assert.equal(data.formats[1].mseSupported, true);
  assert.deepEqual(data.formats[1].mediaCapabilities,
    { supported: true, smooth: true, powerEfficient: false });
  assert.equal(data.formats[3].mseSupported, false);
  assert.equal(data.formats[3].mediaCapabilities, null);
  assert.equal(reports.length, 3);
  assert.equal(reports[1].type, 'media-source');
  assert.equal(reports[1].video.width, 1920);
  assert.equal(reports[1].video.height, 1080);
  assert.equal(reports[1].audio.samplerate, 48000);
  assert.match(data.limitations.join(' '), /not evidence a frame decoded/);
});

test('missing media APIs or rejected profile probes are unknown, not supported', async () => {
  const data = await inspectCodecCapabilities({
    video: { canPlayType: () => '' },
    mediaSource: { isTypeSupported: () => true },
    decodingInfo: async () => { throw new TypeError('unsupported format'); }
  });
  assert.equal(data.formats.length, 4);
  assert(data.formats.every(row => row.mediaCapabilities === null));
  const missingMse = await inspectCodecCapabilities({
    video: { canPlayType: () => '' }, mediaSource: null, decodingInfo: null
  });
  assert.equal(missingMse.hasMediaSource, false);
  assert(missingMse.formats.every(row => row.mseSupported === false));
});
