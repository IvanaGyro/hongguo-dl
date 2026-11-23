// SPDX-License-Identifier: GPL-3.0-only
// Q1: 12th smallest of 45 highest-passing CRFs, tested with adaptive VMAF.
// veryfast is omitted from the measured time/size Pareto frontier.
export const DEFAULT_H264_TRADEOFF = 1;
export const H264_TRADEOFFS = Object.freeze([
  Object.freeze({ preset: 'ultrafast', crf: 18, label: '極速' }),
  Object.freeze({ preset: 'superfast', crf: 19, label: '快速' }),
  Object.freeze({ preset: 'faster', crf: 16, label: '偏快' }),
  Object.freeze({ preset: 'fast', crf: 17, label: '均衡' }),
  Object.freeze({ preset: 'medium', crf: 18, label: '省空間' }),
  Object.freeze({ preset: 'slow', crf: 18, label: '最省空間' })
]);
export function h264TradeoffIndex(value, fallback = DEFAULT_H264_TRADEOFF) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number < H264_TRADEOFFS.length
    ? number : fallback;
}
export function h264Tradeoff(value) {
  return H264_TRADEOFFS[h264TradeoffIndex(value)];
}
export function h264EncoderArgs(value) {
  const { preset, crf } = h264Tradeoff(value);
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];
}
