// SPDX-License-Identifier: GPL-3.0-only
// Choose a feasible processing route from Worker-owned metadata and the
// capabilities the main thread reported. Pure: no fetch, DOM or WASM.

// The application-owned WASM remux/transcode budget. Metadata inspection and
// native EME passthrough deliberately do not apply this limit.
export const MAX_REMUX_FILE_BYTES = 260 * 1024 * 1024;
export const BVC2_RENDER_MIME = 'audio/mp4; codecs="mp4a.40.2"';
const HEVC_CODEC = /^hvc1\.[A-C]?\d{1,2}\.[a-fA-F0-9]{1,8}\.[LH]\d{1,3}(?:\.[a-fA-F0-9]{2}){0,6}$/;

/**
 * Clear fMP4 output MIME candidates. The HEVC input's hvcC is known, but the
 * muxer has not emitted its clear sample entry yet; hvc1 or hev1 may follow.
 */
export function mseCandidates({ bridge, codec, metadata, render = false }) {
  const hasAac = Boolean(metadata?.hasAac);
  // Direct ByteVC2 rendering: MSE carries only the AAC track; it is the clock.
  if (bridge === 'bvc2' && render) return hasAac
    ? { videoCodec: null, hasAac, mime: BVC2_RENDER_MIME, alternateMime: null, render: true } : null;
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
 *  - 'mse': the Worker produces clear fMP4 for MSE (WASM remux/transcode);
 *    with `render`, ByteVC2 yields AAC-only fMP4 plus decoded pictures,
 *  - 'eme': the Worker passes already-fragmented CENC through for MSE, and
 *    the browser's CDM decrypts it (native EME; needs a fragment index),
 *  - 'unsupported': no route, the caller falls back or selects another rendition,
 *  - 'error': a source failure with a public code,
 *  - 'pending': MIME support answers are still needed (see `types`),
 *  - 'pending-index': the fragment index has not been probed yet.
 * An encrypted URL is never handed to the media element directly: browsers
 * decrypt CENC only through MSE.
 */
export function decideMediaRoute({ bridge, codec, metadata, processing, typeSupport = {},
  eme = false, fragmentIndex, render = false }) {
  let passthrough = false;
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
    // Fallback order: native EME → WASM streaming → (caller) whole-file.
    if (metadata.fragmented && eme) {
      if (fragmentIndex === undefined) return { kind: 'pending-index' };
      passthrough = Boolean(fragmentIndex);
    }
    if (!passthrough) {
      if (metadata.fileSize > MAX_REMUX_FILE_BYTES) return { kind: 'unsupported', reason: 'remux-file-limit' };
      if (!processing) return { kind: 'unsupported', reason: metadata.fragmented
        ? (eme ? 'fmp4-index-unavailable' : 'eme-unavailable') : 'remux-unavailable' };
    }
  }
  // A ByteVC2 source without AAC has no audio clock, and a browser without
  // AAC-only MSE cannot play it: transcode those instead.
  const renderable = bridge === 'bvc2' && render && Boolean(metadata.hasAac) &&
    typeSupport[BVC2_RENDER_MIME] !== false;
  const candidates = mseCandidates({ bridge, codec: bridge === 'bvc2' ? 'h264' : codec, metadata,
    render: renderable });
  if (!candidates) return { kind: 'unsupported', reason: 'codec-string' };
  const wanted = [candidates.mime, candidates.alternateMime].filter(Boolean);
  const unknown = wanted.filter(mime => typeof typeSupport[mime] !== 'boolean');
  if (unknown.length) return { kind: 'pending', types: unknown, candidates };
  const primarySupported = typeSupport[candidates.mime];
  const alternateSupported = Boolean(candidates.alternateMime && typeSupport[candidates.alternateMime]);
  const check = { primarySupported, alternateSupported };
  if (!primarySupported && !alternateSupported)
    return { kind: 'unsupported', reason: 'mse-codec-unsupported', candidates, check };
  if (passthrough) return { kind: 'eme', reason: 'fragmented-eme', candidates, check };
  if (renderable) return { kind: 'mse', reason: 'bvc2-render', render: true, candidates, check };
  return { kind: 'mse', reason: metadata.fragmented ? 'fragmented-remux' : 'progressive-remux', candidates, check };
}
