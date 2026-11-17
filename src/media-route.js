// SPDX-License-Identifier: GPL-3.0-only
// Choose a feasible processing route from Worker-owned metadata and the
// capabilities the main thread reported. Pure: no fetch, DOM or WASM.

// The application-owned WASM remux/transcode budget. Metadata inspection and
// browser-native EME routes deliberately do not apply this limit.
export const MAX_REMUX_FILE_BYTES = 260 * 1024 * 1024;
const HEVC_CODEC = /^hvc1\.[A-C]?\d{1,2}\.[a-fA-F0-9]{1,8}\.[LH]\d{1,3}(?:\.[a-fA-F0-9]{2}){0,6}$/;

/**
 * Clear fMP4 output MIME candidates. The HEVC input's hvcC is known, but the
 * muxer has not emitted its clear sample entry yet; hvc1 or hev1 may follow.
 */
export function mseCandidates({ bridge, codec, metadata }) {
  const hasAac = Boolean(metadata?.hasAac);
  const videoCodec = bridge === 'bvc2' ? 'avc1.42C01F'
    : codec === 'hevc' ? (HEVC_CODEC.test(metadata?.hevcCodecString || '') ? metadata.hevcCodecString : null)
      : codec === 'h264' ? 'avc1.42E01E' : null;
  if (!videoCodec) return null;
  const toMime = tag => 'video/mp4; codecs="' + tag + (hasAac ? ', mp4a.40.2' : '') + '"';
  return {
    videoCodec, hasAac, mime: toMime(videoCodec),
    alternateMime: bridge !== 'bvc2' && codec === 'hevc' ? toMime('hev1' + videoCodec.slice(4)) : null
  };
}

/**
 * Returns { kind, reason, ... } where kind is
 *  - 'mse': the Worker produces clear fMP4 for MSE,
 *  - 'native': only a browser-native pipeline (EME/CDM) can play it,
 *  - 'unsupported': no route, the caller selects another rendition,
 *  - 'error': a source failure with a public code,
 *  - 'pending': MIME support answers are still needed (see `types`).
 */
export function decideMediaRoute({ bridge, codec, metadata, processing, typeSupport = {} }) {
  if (bridge === 'bvc2') {
    if (!metadata.indexed || metadata.fragmented)
      return { kind: 'error', code: 'BVC2_ERROR', reason: 'bvc2-unindexed' };
    if (metadata.fileSize > MAX_REMUX_FILE_BYTES) return { kind: 'unsupported', reason: 'remux-file-limit' };
    if (!processing) return { kind: 'unsupported', reason: 'remux-unavailable' };
  } else {
    if (!metadata.hasKid) return { kind: 'unsupported', reason: 'no-cenc-kid' };
    if (metadata.videoCodec &&
        (codec === 'hevc' && !['hvc1', 'hev1'].includes(metadata.videoCodec) ||
         codec === 'h264' && !['avc1', 'avc3'].includes(metadata.videoCodec)))
      return { kind: 'unsupported', reason: 'stsd-declared-codec-mismatch' };
    if (metadata.fragmented) return { kind: 'native', reason: 'fragmented' };
    if (metadata.fileSize > MAX_REMUX_FILE_BYTES) return { kind: 'native', reason: 'remux-file-limit' };
    if (!processing) return { kind: 'native', reason: 'remux-unavailable' };
  }
  const candidates = mseCandidates({ bridge, codec: bridge === 'bvc2' ? 'h264' : codec, metadata });
  const fallback = bridge === 'bvc2' ? 'unsupported' : 'native';
  if (!candidates) return { kind: fallback, reason: 'codec-string' };
  const wanted = [candidates.mime, candidates.alternateMime].filter(Boolean);
  const unknown = wanted.filter(mime => typeof typeSupport[mime] !== 'boolean');
  if (unknown.length) return { kind: 'pending', types: unknown, candidates };
  const primarySupported = typeSupport[candidates.mime];
  const alternateSupported = Boolean(candidates.alternateMime && typeSupport[candidates.alternateMime]);
  const check = { primarySupported, alternateSupported };
  if (!primarySupported && !alternateSupported)
    return { kind: fallback, reason: 'mse-codec-unsupported', candidates, check };
  return { kind: 'mse', reason: 'progressive-remux', candidates, check };
}
