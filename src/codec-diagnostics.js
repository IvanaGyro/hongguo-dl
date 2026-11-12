// SPDX-License-Identifier: GPL-3.0-only
// Passive device-capability diagnostics. This does not request a signed
// video URL, DRM key, microphone or device identifier.
const FORMATS = [
  { codec: 'H.264 + AAC', videoMime: 'video/mp4; codecs="avc1.42E01E"',
    mseMime: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' },
  { codec: 'HEVC + AAC', videoMime: 'video/mp4; codecs="hvc1"',
    mseMime: 'video/mp4; codecs="hvc1, mp4a.40.2"' },
  { codec: 'HEVC Main10 + AAC', videoMime: 'video/mp4; codecs="hvc1.2.4.L120.90"',
    mseMime: 'video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"' },
  { codec: 'VVC (not ByteVC2)', videoMime: 'video/mp4; codecs="vvc1"',
    mseMime: 'video/mp4; codecs="vvc1, mp4a.40.2"' }
];

export async function inspectCodecCapabilities({
  video = document.createElement('video'),
  mediaSource = typeof MediaSource === 'undefined' ? null : MediaSource,
  decodingInfo = typeof navigator === 'undefined' ? null
    : navigator.mediaCapabilities?.decodingInfo?.bind(navigator.mediaCapabilities)
} = {}) {
  const results = await Promise.all(FORMATS.map(async ({ codec, videoMime, mseMime }) => {
    const canPlayType = video.canPlayType?.(mseMime) || '';
    const mseSupported = Boolean(mediaSource?.isTypeSupported?.(mseMime));
    let mediaCapabilities = null;
    if (mseSupported && typeof decodingInfo === 'function') {
      try {
        const info = await decodingInfo({
          type: 'media-source',
          video: {
            contentType: videoMime, width: 1920, height: 1080,
            bitrate: 5000000, framerate: 24
          },
          audio: {
            contentType: 'audio/mp4; codecs="mp4a.40.2"',
            channels: '2', bitrate: 128000, samplerate: 48000
          }
        });
        mediaCapabilities = {
          supported: Boolean(info.supported),
          smooth: Boolean(info.smooth),
          powerEfficient: Boolean(info.powerEfficient)
        };
      } catch {
        // Some implementations reject an incomplete codec string; no
        // response is UNKNOWN, not proof a decoder is absent.
      }
    }
    return { codec, canPlayType, mseSupported, mediaCapabilities };
  }));
  return {
    schema: 1,
    hasMediaSource: Boolean(mediaSource),
    formats: results,
    limitations: [
      'MSE.isTypeSupported and canPlayType are declarations, not evidence a frame decoded.',
      'MediaCapabilities describes the proposed 1080p bitrate and may be unavailable.',
      'VVC is not interchangeable with ByteVC2; real encrypted playback requires an authorized source.'
    ]
  };
}
