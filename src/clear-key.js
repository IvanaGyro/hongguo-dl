// SPDX-License-Identifier: GPL-3.0-only
// Encrypted CENC playback. Browsers decrypt CENC only through MSE, so an
// encrypted URL is never assigned to the media element. The media Worker
// opens the source, probes bounded metadata and chooses the route:
//   - fragmented CENC with a sidx/mfra index → native EME: the Worker passes
//     the encrypted fragments through MSE and the browser CDM decrypts;
//   - otherwise → WASM decrypt + remux to clear fMP4 for MSE.
// This module owns the Clear Key side: one MediaKeys per media element,
// attached once and kept, and one key session per episode.
import { errorWith } from './logic.js';
import { createMediaDownload } from './media-download.js';
import { openCencProgressiveStream } from './cenc-remux.js';
import { aborted } from './mp4-metadata.js';
import { isProcessingFailure } from './fallback-policy.js';
export { mp4Boxes, cencKidFromMoov, probeCencKid } from './mp4-metadata.js';

const KEY_SYSTEM = 'org.w3.clearkey';

const base64Url = bytes => {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  const encoded = typeof btoa === 'function'
    ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
export function clearKeyLicense(kid, key) {
  return JSON.stringify({ keys: [{ kty: 'oct', kid: base64Url(kid),
    k: base64Url(key) }], type: 'temporary' });
}

/**
 * A single-KID version-1 Common PSSH box (ISO BMFF / EME 'cenc').
 * A preloaded 'keyids' license alone is not necessarily associated with
 * CENC MP4 playback by browser CDMs. The Common SystemID is standardized.
 */
export function commonCencPssh(kid) {
  if (!(kid instanceof Uint8Array) || kid.length !== 16)
    throw errorWith('INVALID_KEY', 'CENC KID 必須為 16 bytes');
  const pssh = new Uint8Array(52);
  const view = new DataView(pssh.buffer);
  view.setUint32(0, pssh.length);
  pssh.set([0x70, 0x73, 0x73, 0x68, 1, 0, 0, 0], 4); // 'pssh', version 1
  pssh.set([0x10, 0x77, 0xef, 0xec, 0xc0, 0xb2, 0x4d, 0x02,
    0xac, 0xe3, 0x3c, 0x1e, 0x52, 0xe2, 0xfb, 0x4b], 12);
  view.setUint32(28, 1); // one key ID
  pssh.set(kid, 32);
  view.setUint32(48, 0); // no system-specific data
  return pssh;
}
function hexKey(value) {
  if (!/^[a-f0-9]{32}$/i.test(value || ''))
    throw errorWith('INVALID_KEY', '影片金鑰必須為 128-bit 十六進位');
  return Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
}
export function mimeForCodec(codec) {
  if (codec === 'h264') return 'video/mp4; codecs="avc1.42E01E"';
  if (codec === 'hevc') return 'video/mp4; codecs="hvc1"';
  return null;
}

// Capabilities asked for once per element; the CDM keeps the supported ones.
const EME_VIDEO = ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.64001F"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'];
const EME_AUDIO = ['audio/mp4; codecs="mp4a.40.2"'];
const attached = new WeakMap(); // media element → Promise<{ access, keys }>

/**
 * MediaKeys are attached to a media element the first time an episode needs
 * EME and are never detached: clear MSE and direct playback keep working with
 * keys attached, so route changes never call setMediaKeys(null).
 */
export function ensureMediaKeys(video, requestAccess, onStage = () => {}) {
  let pending = attached.get(video);
  if (pending) return pending;
  pending = (async () => {
    onStage('eme-access');
    const access = await requestAccess(KEY_SYSTEM, [{
      initDataTypes: ['cenc', 'keyids'],
      videoCapabilities: EME_VIDEO.map(contentType => ({ contentType, encryptionScheme: 'cenc' })),
      audioCapabilities: EME_AUDIO.map(contentType => ({ contentType, encryptionScheme: 'cenc' })),
      persistentState: 'not-allowed', distinctiveIdentifier: 'not-allowed',
      sessionTypes: ['temporary']
    }]);
    const keys = await access.createMediaKeys();
    await video.setMediaKeys(keys);
    return { access, keys };
  })();
  attached.set(video, pending);
  pending.catch(() => { if (attached.get(video) === pending) attached.delete(video); });
  return pending;
}

const BAD_KEY_STATUS = ['internal-error', 'output-restricted', 'expired', 'released'];

/** One temporary Clear Key session for one episode's KID. */
export async function openKeySession({ access, keys, kid, key, onFailure = () => {}, timeoutMs = 5000 }) {
  const session = keys.createSession('temporary');
  let timer;
  try {
    const licensed = new Promise((resolve, reject) => {
      session.addEventListener('message', async event => {
        try {
          const request = JSON.parse(new TextDecoder().decode(event.message));
          if (!Array.isArray(request.kids) || !request.kids.includes(base64Url(kid)))
            throw errorWith('EME_UNAVAILABLE', 'CDM 要求未知的影片金鑰');
          await session.update(new TextEncoder().encode(clearKeyLicense(kid, key)));
          resolve();
        } catch (error) { reject(error); }
      }, { once: true });
    });
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(errorWith('EME_UNAVAILABLE', '瀏覽器 Clear Key 初始化逾時')), timeoutMs);
    });
    const acceptsCenc = access.getConfiguration?.().initDataTypes?.includes('cenc');
    const initType = acceptsCenc ? 'cenc' : 'keyids';
    const initData = acceptsCenc ? commonCencPssh(kid) : new TextEncoder().encode(
      JSON.stringify({ kids: [base64Url(kid)] }));
    await session.generateRequest(initType, initData);
    await Promise.race([licensed, expired]);
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
  const statuses = () => session.keyStatuses ? Array.from(session.keyStatuses.values()) : [];
  if (statuses().some(status => BAD_KEY_STATUS.includes(status))) {
    await session.close().catch(() => {});
    throw errorWith('EME_UNAVAILABLE', 'Clear Key 金鑰狀態不可用');
  }
  // A key that later becomes unusable is an EME processing failure.
  session.addEventListener('keystatuseschange', () => {
    if (statuses().some(status => BAD_KEY_STATUS.includes(status) && status !== 'released')) onFailure('EME_FAILED');
  });
  return session;
}

export async function openClearKeyStream({
  video, source, codec, workerOrigin, signal, startSeconds = 0,
  fetchImpl = fetch, download = null, onStage = () => {}, preload = false, remainingMediaAttempts = 20,
  retainSource = () => false, allowEme = true, processor = null,
  requestAccess = typeof navigator !== 'undefined'
    ? navigator.requestMediaKeySystemAccess?.bind(navigator) : null
}) {
  // Only report a stage and an error type. Media URLs and content keys are
  // deliberately excluded from diagnostics (even on failures).
  const declined = (stage, error = null) => {
    onStage('cenc.declined', { reason: stage, code: error?.code || 'none', errorName: error?.name || 'none' });
    console.info('[Hongguo CENC] incremental route unavailable:', stage, error?.name || '');
    return null;
  };
  const mime = mimeForCodec(codec);
  // Bare 'hvc1' is incomplete for some HEVC MSE implementations. The Worker
  // reads the bounded moov and checks the exact codec string instead.
  if (!mime || !source?.contentKey ||
      (codec !== 'hevc' && !video.canPlayType(mime))) return null;
  aborted(signal);
  const input = download || createMediaDownload({ fetchImpl, getWorkerOrigin: () => workerOrigin });
  const { transport } = input.open(source,
    (reason, fields) => onStage('media.transport.fallback', { reason, ...fields }), {
    direct: typeof window !== 'undefined' &&
      !['localhost', '127.0.0.1'].includes(location.hostname) });
  const key = hexKey(source.contentKey);
  const emeUsable = allowEme && typeof requestAccess === 'function' &&
    typeof video.setMediaKeys === 'function';
  const prepareEme = async (metadata, { onFailure }) => {
    try {
      if (!/^[a-f0-9]{32}$/i.test(metadata?.kid || '')) throw errorWith('EME_UNAVAILABLE', '缺少 CENC KID');
      const kid = Uint8Array.from(metadata.kid.match(/../g), pair => parseInt(pair, 16));
      const { access, keys } = await ensureMediaKeys(video, requestAccess, onStage);
      aborted(signal);
      const session = await openKeySession({ access, keys, kid, key, onFailure });
      onStage('eme.key-status', { status: Array.from(session.keyStatuses?.values?.() || []).join(',') || 'unknown' });
      return session;
    } catch (error) {
      if (signal?.aborted || error?.code === 'CANCELED') throw errorWith('CANCELED', '已切換影片');
      throw Object.assign(errorWith('EME_UNAVAILABLE', '瀏覽器無法使用 Clear Key'),
        { reason: error?.name || error?.code || 'eme-error' });
    }
  };
  let stream;
  try {
    stream = await openCencProgressiveStream({
      video, input: input.input(source, transport), onStage, codec,
      key: source.contentKey, signal, preload, remainingMediaAttempts, fetchImpl, retainSource,
      durationSeconds: source.duration || null, startSeconds, processor,
      eme: emeUsable, prepareEme: emeUsable ? prepareEme : null
    });
  } catch (error) {
    // A rejected/broken HTTP Range is a source/network failure, not a
    // processing failure: the download session rotates the CDN instead.
    if (signal?.aborted || !isProcessingFailure(error?.code)) throw error;
    return declined('incremental-route-failed', error);
  }
  if (!stream) return declined('no-incremental-route');
  onStage('cenc.route', { kind: stream.kind === 'eme-mse' ? 'eme-mse' : 'progressive-remux' });
  console.info('[Hongguo CENC] playback route:', stream.kind);
  return stream;
}
