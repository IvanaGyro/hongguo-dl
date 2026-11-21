// SPDX-License-Identifier: GPL-3.0-only
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideMediaRoute,
  BVC2_RENDER_MIME,
  mseCandidates,
  MAX_REMUX_FILE_BYTES
} from '../../../src/media-route.js';

describe('ByteVC2 render route', () => {
  const metadata = (fields = {}) => ({ indexed: true, fragmented: false, fileSize: 4 * 1024 * 1024,
    hasAac: true, ...fields });
  const bvc2 = (fields = {}) => decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata(),
    processing: true, typeSupport: { [BVC2_RENDER_MIME]: true,
      'video/mp4; codecs="avc1.42C01F, mp4a.40.2"': true }, ...fields });

  test('ByteVC2 render demand uses the AAC-only MSE route', () => {
    const route = bvc2({ render: true });
    assert.equal(route.kind, 'mse');
    assert.equal(route.render, true);
    assert.equal(route.reason, 'bvc2-render');
    assert.equal(route.candidates.mime, BVC2_RENDER_MIME);
  });

  test('ByteVC2 keeps the H.264 transcode without render or without AAC', () => {
    assert.equal(bvc2().render, undefined);
    assert.equal(bvc2().candidates.mime, 'video/mp4; codecs="avc1.42C01F, mp4a.40.2"');
    const silent = decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata({ hasAac: false }),
      processing: true, typeSupport: { 'video/mp4; codecs="avc1.42C01F"': true }, render: true });
    assert.equal(silent.kind, 'mse');
    assert.equal(silent.render, undefined);
    assert.equal(silent.candidates.mime, 'video/mp4; codecs="avc1.42C01F"');
  });

  test('render asks for AAC MSE support before routing', () => {
    const route = decideMediaRoute({ bridge: 'bvc2', codec: 'h264', metadata: metadata(),
      processing: true, typeSupport: {}, render: true });
    assert.equal(route.kind, 'pending');
    assert.deepEqual(route.types, [BVC2_RENDER_MIME]);
  });

  test('render falls back to the H.264 transcode when AAC-only MSE is unsupported', () => {
    const route = bvc2({ render: true, typeSupport: { [BVC2_RENDER_MIME]: false,
      'video/mp4; codecs="avc1.42C01F, mp4a.40.2"': true } });
    assert.equal(route.kind, 'mse');
    assert.equal(route.render, undefined);
    assert.equal(route.candidates.mime, 'video/mp4; codecs="avc1.42C01F, mp4a.40.2"');
  });
});

describe('CENC and ByteVC2 routes', () => {
  test('route: CENC never falls back to an encrypted URL; fragmented CENC prefers native EME', () => {
    const metadata = { indexed: true, fragmented: false, hasKid: true, hasAac: true,
      videoCodec: 'hvc1', hevcCodecString: 'hvc1.2.4.L120.90', fileSize: 1024 };
    const pending = decideMediaRoute({ bridge: 'cenc', codec: 'hevc', metadata, processing: true });
    assert.equal(pending.kind, 'pending');
    assert.deepEqual(pending.types, ['video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"',
      'video/mp4; codecs="hev1.2.4.L120.90, mp4a.40.2"']);
    const types = { [pending.types[0]]: false, [pending.types[1]]: true };
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', metadata, processing: true, typeSupport: types }).kind, 'mse');
    const none = { [pending.types[0]]: false, [pending.types[1]]: false };
    assert.deepEqual(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', metadata, processing: true, typeSupport: none }).kind, 'unsupported');
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true, typeSupport: types,
      metadata: { ...metadata, fileSize: MAX_REMUX_FILE_BYTES + 1 } }).reason, 'remux-file-limit');
    const fragmented = { ...metadata, fragmented: true };
    // Native EME waits for the fragment index probe, then passes fragments through.
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true, eme: true,
      metadata: fragmented }).kind, 'pending-index');
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: false, eme: true, typeSupport: types,
      fragmentIndex: { kind: 'sidx' }, metadata: fragmented }).kind, 'eme');
    // Passthrough is not WASM work: the remux file limit does not apply.
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true, eme: true, typeSupport: types,
      fragmentIndex: { kind: 'mfra' }, metadata: { ...fragmented, fileSize: MAX_REMUX_FILE_BYTES + 1 } }).kind, 'eme');
    // Without an index (or without EME) the next step is WASM streaming.
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true, eme: true, typeSupport: types,
      fragmentIndex: null, metadata: fragmented }).reason, 'fragmented-remux');
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true, typeSupport: types,
      metadata: fragmented }).kind, 'mse');
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: false, eme: true,
      fragmentIndex: null, metadata: fragmented }).reason, 'fmp4-index-unavailable');
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: false,
      metadata: fragmented }).reason, 'eme-unavailable');
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: true,
      metadata: { ...metadata, hasKid: false } }).reason, 'no-cenc-kid');
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'h264', processing: true, metadata }).reason,
      'stsd-declared-codec-mismatch');
    assert.equal(decideMediaRoute({ bridge: 'cenc', codec: 'hevc', processing: false, metadata }).reason,
      'remux-unavailable');
  });

  test('route: ByteVC2 needs an indexed progressive source and an H.264 MSE output', () => {
    const metadata = { indexed: true, fragmented: false, hasKid: false, hasAac: false, fileSize: 2048 };
    assert.equal(mseCandidates({ bridge: 'bvc2', codec: 'h264', metadata }).mime, 'video/mp4; codecs="avc1.42C01F"');
    assert.deepEqual(decideMediaRoute({ bridge: 'bvc2', metadata: { ...metadata, indexed: false }, processing: true }),
      { kind: 'error', code: 'BVC2_ERROR', reason: 'bvc2-unindexed' });
    assert.equal(decideMediaRoute({ bridge: 'bvc2', metadata, processing: false }).kind, 'unsupported');
    assert.equal(decideMediaRoute({ bridge: 'bvc2', metadata, processing: true,
      typeSupport: { 'video/mp4; codecs="avc1.42C01F"': true } }).kind, 'mse');
  });
});
