// SPDX-License-Identifier: GPL-3.0-only
// Download speed/size slider stops for each output encoder. Every stop is an
// encoder preset plus its rate-control value (x264/x265/SVT-AV1: CRF,
// VVenC: QP), passed unchanged to media_convert().
//
// H.264: 12th smallest of 45 highest-passing CRFs, tested with adaptive VMAF
// (docs/h264-download-speed-size.md); veryfast is omitted from the measured
// time/size Pareto frontier. HEVC/AV1/VVC keep one quality value per codec,
// so moving the slider trades encoding time for file size at roughly the
// same quality; their values are not yet VMAF-measured.
const stop = (preset, quality, label) => Object.freeze({ preset, quality, crf: quality, label });
export const ENCODER_TRADEOFFS = Object.freeze({
  h264: Object.freeze([
    stop('ultrafast', 18, '極速'), stop('superfast', 19, '快速'), stop('faster', 16, '偏快'),
    stop('fast', 17, '均衡'), stop('medium', 18, '省空間'), stop('slow', 18, '最省空間')
  ]),
  hevc: Object.freeze([
    stop('ultrafast', 22, '極速'), stop('superfast', 22, '快速'), stop('veryfast', 22, '偏快'),
    stop('faster', 22, '均衡'), stop('fast', 22, '省空間'), stop('medium', 22, '最省空間')
  ]),
  // SVT-AV1 presets are numbers: higher is faster.
  av1: Object.freeze([
    stop('12', 30, '極速'), stop('10', 30, '快速'), stop('9', 30, '偏快'),
    stop('8', 30, '均衡'), stop('7', 30, '省空間'), stop('6', 30, '最省空間')
  ]),
  // VVenC slow/slower take minutes per second of 1080p video in WASM.
  vvc: Object.freeze([
    stop('faster', 30, '快速'), stop('fast', 30, '均衡'), stop('medium', 30, '省空間')
  ])
});
export const ENCODER_NAMES = Object.freeze({ h264: 'H.264', hevc: 'H.265', av1: 'AV1', vvc: 'VVC' });
export const DEFAULT_TRADEOFFS = Object.freeze({ h264: 1, hevc: 1, av1: 1, vvc: 0 });
export const DEFAULT_H264_TRADEOFF = DEFAULT_TRADEOFFS.h264;
export const H264_TRADEOFFS = ENCODER_TRADEOFFS.h264;

export const isEncodingMode = mode => Object.hasOwn(ENCODER_TRADEOFFS, mode);

export function tradeoffIndex(mode, value, fallback = DEFAULT_TRADEOFFS[mode] ?? 0) {
  const stops = ENCODER_TRADEOFFS[mode];
  if (!stops || value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number < stops.length ? number : fallback;
}
export function encoderTradeoff(mode, value) {
  const stops = ENCODER_TRADEOFFS[mode];
  return stops ? stops[tradeoffIndex(mode, value)] : null;
}
/** Filename suffix, e.g. `.hevc-superfast` or `.av1-p10`. */
export function tradeoffSuffix(mode, value) {
  const profile = encoderTradeoff(mode, value);
  if (!profile) return '';
  return '.' + mode + '-' + (mode === 'av1' ? 'p' + profile.preset : profile.preset);
}
export const h264TradeoffIndex = (value, fallback = DEFAULT_H264_TRADEOFF) =>
  tradeoffIndex('h264', value, fallback);
export const h264Tradeoff = value => encoderTradeoff('h264', value);
