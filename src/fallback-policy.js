// SPDX-License-Identifier: GPL-3.0-only
// One playback fallback order for every encrypted/transcoded route:
//   native EME (fragmented CENC) → WASM streaming → whole-file processing.
// Only processing failures move down this order. Source failures (CDN 403,
// 429, broken or unsupported HTTP Range, timeouts) belong to the download
// session's candidate rotation: a whole-file read would hit the same CDN.
const PROCESSING_FAILURES = new Set([
  'CENC_UNAVAILABLE',       // streaming Worker or MSE route could not run
  'CENC_REMUX_FAILED',      // WASM demux/decrypt/remux or SourceBuffer failure
  'BVC2_TRANSCODE_FAILED',  // WASM ByteVC2 → H.264 failure
  'BVC2_UNAVAILABLE',
  'HEVC_INIT_MISMATCH',
  'HEVC_INIT_UNSUPPORTED',
  'EME_UNAVAILABLE',        // no Clear Key, unusable key or EME codec
  'EME_FAILED',             // native EME playback failed after setup
  'FMP4_INDEX_UNAVAILABLE'  // fragmented MP4 without sidx/mfra
]);

export function isProcessingFailure(code) {
  return PROCESSING_FAILURES.has(code);
}

// An absent code means the streaming route declined before reporting one.
export function allowsWholeFileFallback(error) {
  if (!error) return true;
  return isProcessingFailure(error.code);
}
