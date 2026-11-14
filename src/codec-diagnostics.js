// SPDX-License-Identifier: GPL-3.0-only
// Passive device-capability diagnostics. This does not request a signed
// video URL, DRM key, microphone or device identifier.
const FORMATS = [
  { codec: 'H.264 + AAC', videoCodec: 'avc1.42E01E' },
  { codec: 'HEVC + AAC', videoCodec: 'hvc1' }, // Compare with the old incomplete probe.
  { codec: 'HEVC Main + AAC', videoCodec: 'hvc1.1.6.L120.90' },
  { codec: 'HEVC Main (hev1) + AAC', videoCodec: 'hev1.1.6.L120.90' },
  { codec: 'HEVC Main L6.2 + AAC', videoCodec: 'hvc1.1.6.L186' },
  { codec: 'HEVC Main L6.2 (hev1) + AAC', videoCodec: 'hev1.1.6.L186' },
  { codec: 'HEVC Main10 + AAC', videoCodec: 'hvc1.2.4.L120.90' },
  { codec: 'HEVC Main10 (hev1) + AAC', videoCodec: 'hev1.2.4.L120.90' },
  { codec: 'HEVC Main10 L5.1 + AAC', videoCodec: 'hvc1.2.4.L153.90' },
  { codec: 'VVC (not ByteVC2)', videoCodec: 'vvc1' }
];

export async function inspectCodecCapabilities({
  video = document.createElement('video'),
  mediaSource = globalThis.MediaSource || globalThis.ManagedMediaSource || null,
  decodingInfo = typeof navigator === 'undefined' ? null
    : navigator.mediaCapabilities?.decodingInfo?.bind(navigator.mediaCapabilities),
  timeoutMs = 2500,
  userAgent = globalThis.navigator?.userAgent || null
} = {}) {
  const configuration = { width: 1920, height: 1080, bitrate: 5000000, framerate: 24 };
  const audio = { contentType: 'audio/mp4; codecs="mp4a.40.2"',
    channels: '2', bitrate: 128000, samplerate: 48000 };
  const probe = mime => {
    let canPlayType = '', mseSupported = false, canPlayTypeError, mseError;
    try { canPlayType = video.canPlayType?.(mime) || ''; }
    catch (error) { canPlayTypeError = error?.name || 'Error'; }
    try { mseSupported = Boolean(mediaSource?.isTypeSupported?.(mime)); }
    catch (error) { mseError = error?.name || 'Error'; }
    return { mime, canPlayType, mseSupported,
      ...(canPlayTypeError ? { canPlayTypeError } : {}), ...(mseError ? { mseError } : {}) };
  };
  const capabilities = async config => {
    if (typeof decodingInfo !== 'function') return { status: 'unavailable', result: null };
    let timer;
    // Do not gate this independent API on isTypeSupported. A rejected or
    // hanging query is unknown; it must not be reported as supported=false.
    const task = Promise.resolve().then(() => decodingInfo(config)).then(info => ({
      status: 'ok', result: { supported: Boolean(info.supported), smooth: Boolean(info.smooth),
        powerEfficient: Boolean(info.powerEfficient) }
    })).catch(() => ({ status: 'error', result: null }));
    try {
      return await Promise.race([task, new Promise(resolve => {
        timer = setTimeout(() => resolve({ status: 'timeout', result: null }), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const audioCapabilities = capabilities({ type: 'media-source', audio });
  const results = await Promise.all(FORMATS.map(async ({ codec, videoCodec }) => {
    const videoMime = 'video/mp4; codecs="' + videoCodec + '"';
    const mseMime = 'video/mp4; codecs="' + videoCodec + ', mp4a.40.2"';
    const videoConfig = { contentType: videoMime, ...configuration };
    const [combined, file, videoOnly, audioOnly] = await Promise.all([
      capabilities({ type: 'media-source', video: videoConfig, audio }),
      capabilities({ type: 'file', video: videoConfig, audio }),
      capabilities({ type: 'media-source', video: videoConfig }), audioCapabilities
    ]);
    return { codec, ...probe(mseMime),
      mediaCapabilities: combined.result, mediaCapabilitiesStatus: combined.status,
      fileCapabilities: file.result, fileCapabilitiesStatus: file.status,
      videoOnly: { ...probe(videoMime), mediaCapabilities: videoOnly.result,
        mediaCapabilitiesStatus: videoOnly.status },
      audioOnly: { ...probe(audio.contentType), mediaCapabilities: audioOnly.result,
        mediaCapabilitiesStatus: audioOnly.status } };
  }));
  return {
    schema: 2,
    userAgent,
    configuration,
    hasMediaSource: Boolean(mediaSource),
    formats: results,
    limitations: [
      'MSE.isTypeSupported and canPlayType are declarations, not evidence a frame decoded.',
      'MediaCapabilities describes the proposed 1080p bitrate and may be unavailable.',
      'File, video-only, audio-only and combined MSE results describe different configurations.',
      'A null MediaCapabilities result is unknown; its status distinguishes errors, timeouts and missing APIs.',
      'The HEVC profiles are diagnostic probes, not the selected file\'s parsed hvcC.',
      'VVC is not interchangeable with ByteVC2; real encrypted playback requires an authorized source.'
    ]
  };
}
