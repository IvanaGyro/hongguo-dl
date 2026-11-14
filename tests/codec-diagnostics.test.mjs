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
  assert.equal(data.schema, 2);
  assert.equal(data.hasMediaSource, true);
  assert(data.formats.some(row => row.videoOnly.mime.includes('hvc1.1.6.L120.90')));
  assert(data.formats.some(row => row.videoOnly.mime.includes('hvc1.1.6.L186')));
  assert(data.formats.some(row => row.videoOnly.mime.includes('hev1.2.4.L120.90')));
  assert.equal(data.formats[0].codec, 'H.264 + AAC');
  assert.equal(data.formats[1].codec, 'HEVC + AAC');
  assert.equal(data.formats[1].canPlayType, 'maybe');
  assert.equal(data.formats[1].mseSupported, true);
  assert.deepEqual(data.formats[1].mediaCapabilities,
    { supported: true, smooth: true, powerEfficient: false });
  const vvc = data.formats.find(row => row.codec === 'VVC (not ByteVC2)');
  assert.equal(vvc.mseSupported, false);
  assert.equal(vvc.mediaCapabilities.supported, true,
    'Even a negative MSE declaration must not skip an independent MediaCapabilities query');
  assert.equal(vvc.mediaCapabilitiesStatus, 'ok');
  assert(reports.some(config => config.type === 'file' && config.video && config.audio));
  assert(reports.some(config => config.type === 'media-source' && config.video && !config.audio));
  assert(reports.some(config => config.type === 'media-source' && !config.video && config.audio));
  assert.deepEqual(data.configuration, { width:1920, height:1080, bitrate:5000000, framerate:24 });
  assert.match(data.limitations.join(' '), /not evidence a frame decoded/);
});

test('missing media APIs or rejected profile probes are unknown, not supported', async () => {
  const data = await inspectCodecCapabilities({
    video: { canPlayType: () => '' },
    mediaSource: { isTypeSupported: () => true },
    decodingInfo: async () => { throw new TypeError('unsupported format'); }
  });
  assert(data.formats.every(row => row.mediaCapabilities === null));
  assert(data.formats.every(row => row.mediaCapabilitiesStatus === 'error'));
  const missingMse = await inspectCodecCapabilities({
    video: { canPlayType: () => '' }, mediaSource: null, decodingInfo: null
  });
  assert.equal(missingMse.hasMediaSource, false);
  assert(missingMse.formats.every(row => row.mseSupported === false));
  assert(missingMse.formats.every(row => row.mediaCapabilitiesStatus === 'unavailable'));
});

test('separate video/audio, combined MSE and file capabilities are not conflated', async () => {
  const data = await inspectCodecCapabilities({
    video: { canPlayType: mime => mime.includes(',') ? '' : 'probably' },
    mediaSource: { isTypeSupported: mime => !mime.includes(',') },
    decodingInfo: async config => ({
      supported: config.type === 'file' || !config.video || !config.audio,
      smooth: true, powerEfficient: true
    })
  });
  const hevc = data.formats.find(row => row.videoOnly.mime.includes('hvc1.1.6.L120.90'));
  assert.equal(hevc.mseSupported, false);
  assert.equal(hevc.videoOnly.mseSupported, true);
  assert.equal(hevc.audioOnly.mseSupported, true);
  assert.equal(hevc.videoOnly.mediaCapabilities.supported, true);
  assert.equal(hevc.audioOnly.mediaCapabilities.supported, true);
  assert.equal(hevc.mediaCapabilities.supported, false);
  assert.equal(hevc.mediaCapabilitiesStatus, 'ok');
  assert.equal(hevc.fileCapabilities.supported, true);
});

test('a hanging Windows capability query times out as unknown without blocking the report', async () => {
  const data = await inspectCodecCapabilities({
    video: { canPlayType: () => '' }, mediaSource: null,
    decodingInfo: () => new Promise(() => {}), timeoutMs: 5
  });
  assert(data.formats.every(row => row.mediaCapabilities === null && row.mediaCapabilitiesStatus === 'timeout'));
  assert(data.formats.every(row => row.fileCapabilities === null && row.fileCapabilitiesStatus === 'timeout'));
});

test('a rejected MIME declaration does not abort other profile diagnostics', async () => {
  const data = await inspectCodecCapabilities({
    video: { canPlayType: () => { throw new TypeError('bad MIME'); } },
    mediaSource: { isTypeSupported: () => { throw new TypeError('bad MIME'); } },
    decodingInfo: async () => ({ supported: false, smooth: false, powerEfficient: false })
  });
  assert(data.formats.every(row => row.canPlayTypeError === 'TypeError' && row.mseError === 'TypeError'));
  assert(data.formats.every(row => row.mediaCapabilitiesStatus === 'ok' && row.mediaCapabilities.supported === false));
});
