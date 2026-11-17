// SPDX-License-Identifier: GPL-3.0-only
// CENC Clear Key uses the browser CDM and HTTP Range rather than decrypting
// millions of samples in JS/WASM. The media Worker opens the source and
// inspects bounded MP4 metadata; this module only owns the browser EME route.
import { errorWith } from './logic.js';
import { createMediaDownload } from './media-download.js';
import { openCencProgressiveStream } from './cenc-remux.js';
import { aborted } from './mp4-metadata.js';
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

// Only fragmented MP4 is valid as a progressive ISO BMFF MSE stream.
// A regular faststart MP4 can have a valid KID but cannot be appended into a
// SourceBuffer as if it contained moof/mdat segments.
function openCencMse({ video, mime, url, signal, fetchImpl }) {
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime))
    return null;
  const mediaSource = new MediaSource();
  const controller = new AbortController();
  let reader = null, closed = false, sourceBuffer = null;
  const objectUrl = URL.createObjectURL(mediaSource);
  const abort = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    void reader?.cancel().catch(() => {});
    URL.revokeObjectURL(objectUrl);
  };
  const append = bytes => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) return reject(errorWith('CANCELED', '已切換影片'));
    if (mediaSource.readyState !== 'open') return reject(errorWith('CENC_UNAVAILABLE', 'MSE 已關閉'));
    const cleanup = () => {
      sourceBuffer.removeEventListener('updateend', done);
      sourceBuffer.removeEventListener('error', failed);
      sourceBuffer.removeEventListener('abort', failed);
      controller.signal.removeEventListener('abort', stopped);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(errorWith('CENC_UNAVAILABLE', 'MSE 封裝緩衝區錯誤')); };
    const stopped = () => { cleanup(); reject(errorWith('CANCELED', '已切換影片')); };
    sourceBuffer.addEventListener('updateend', done, { once: true });
    sourceBuffer.addEventListener('error', failed, { once: true });
    sourceBuffer.addEventListener('abort', failed, { once: true });
    controller.signal.addEventListener('abort', stopped, { once: true });
    try { sourceBuffer.appendBuffer(bytes); } catch (error) { cleanup(); reject(error); }
  });
  // Apply transport backpressure rather than buffering the entire remaining
  // episode when the user pauses. Keep ~40s of playable media ahead.
  const waitForBufferRoom = () => {
    if (closed || !sourceBuffer?.buffered?.length) return Promise.resolve();
    let end;
    try { end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1); }
    catch { return Promise.resolve(); }
    if (!Number.isFinite(end) || end - video.currentTime <= 40)
      return Promise.resolve();
    return new Promise(resolve => {
      const check = () => {
        if (closed || controller.signal.aborted ||
            !sourceBuffer?.buffered?.length) return finish();
        try {
          if (sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) -
              video.currentTime <= 25) finish();
        } catch { finish(); }
      };
      const finish = () => {
        for (const type of ['timeupdate', 'seeked', 'playing'])
          video.removeEventListener(type, check);
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      for (const type of ['timeupdate', 'seeked', 'playing'])
        video.addEventListener(type, check);
      controller.signal.addEventListener('abort', finish, { once: true });
      check();
    });
  };
  const pump = async () => {
    sourceBuffer = mediaSource.addSourceBuffer(mime);
    // A single open-ended Range request is consumed incrementally. This is
    // streaming input, NOT fetch(...).arrayBuffer() on an entire episode.
    const res = await fetchImpl(url, {
      headers: { Range: 'bytes=0-' }, signal: controller.signal, cache: 'no-store'
    });
    if (![200, 206].includes(res.status) || !res.body)
      throw errorWith('CENC_UNAVAILABLE', 'MSE HTTP 串流無法讀取');
    const advertised = Number(res.headers.get('content-length') || 0);
    if (advertised > 260 * 1024 * 1024)
      throw errorWith('MEMORY_LIMIT', 'MSE 片源超過安全上限');
    reader = res.body.getReader();
    let total = 0;
    try {
      while (!closed) {
        await waitForBufferRoom();
        if (closed || signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (total > 260 * 1024 * 1024)
          throw errorWith('MEMORY_LIMIT', 'MSE 片源超過安全上限');
        await append(value);
      }
      if (!closed && mediaSource.readyState === 'open')
        mediaSource.endOfStream();
    } finally {
      reader.releaseLock();
      reader = null;
    }
  };
  mediaSource.addEventListener('sourceopen', () => {
    void pump().catch(error => {
      if (closed || signal?.aborted) return;
      // Do not log signed URLs or decryption keys.
      console.info('[Hongguo MSE] stream failed:', error?.name || 'Error');
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream('decode');
      } catch { /* video error handler still owns playback retries */ }
    });
  }, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  return {
    url: objectUrl, kind: 'mse',
    close: async () => {
      abort();
      signal?.removeEventListener('abort', abort);
    }
  };
}

export async function openClearKeyStream({
  video, source, codec, workerOrigin, signal, startSeconds = 0,
  fetchImpl = fetch, download = null, onStage = () => {}, preload = false, remainingMediaAttempts = 20,
  requestAccess = typeof navigator !== 'undefined'
    ? navigator.requestMediaKeySystemAccess?.bind(navigator) : null
}) {
  // Only report a stage and an error type. Media URLs and content keys are
  // deliberately excluded from diagnostics (even on failures).
  const declined = (stage, error = null) => {
    onStage('cenc.declined', { reason: stage, code: error?.code || 'none', errorName: error?.name || 'none' });
    console.info('[Hongguo EME] native stream unavailable:', stage,
      error?.name || '');
    return null;
  };
  const mime = mimeForCodec(codec);
  // Bare 'hvc1' is incomplete for some HEVC MSE implementations. Read the
  // bounded moov first and build the exact codec string from hvcC instead of
  // rejecting a device based solely on this generic preliminary probe.
  if (!mime || !source?.contentKey ||
      (codec !== 'hevc' && !video.canPlayType(mime))) return null;
  aborted(signal);
  const input = download || createMediaDownload({ fetchImpl, getWorkerOrigin: () => workerOrigin });
  const { transport, url } = input.open(source,
    (reason, fields) => onStage('media.transport.fallback', { reason, ...fields }), {
    direct: typeof window !== 'undefined' &&
      !['localhost', '127.0.0.1'].includes(location.hostname) });
  // One demand to the media Worker: it opens the single `bytes=0-` response,
  // inspects bounded metadata and either streams clear fMP4 (MSE) or reports
  // that only the browser's native EME pipeline can play this source.
  const key = hexKey(source.contentKey);
  let metadata = null, route = null, remux;
  try {
    remux = await openCencProgressiveStream({
      video, input: input.input(source, transport), onStage, codec,
      key: source.contentKey, signal, preload, remainingMediaAttempts, fetchImpl,
      durationSeconds: source.duration || null, startSeconds,
      onMetadata: (value, decided) => { metadata = value; route = decided; }
    });
  } catch (error) {
    // A rejected/broken HTTP Range is a source/network failure, not a
    // demux/decode failure. Never turn it into a whole-file FFmpeg fallback.
    if (signal?.aborted || error?.code === 'PLAYBACK_STEP_LIMIT' || error?.code === 'CENC_METADATA_LIMIT' ||
        error?.code?.startsWith('CENC_RANGE_') ||
        ['CENC_SOURCE_FORBIDDEN', 'CENC_RATE_LIMITED', 'CANCELED'].includes(error?.code))
      throw error;
    return declined('mp4-range-or-kid-probe', error);
  }
  if (remux) {
    onStage('cenc.route', { kind: 'progressive-remux' });
    console.info('[Hongguo CENC] playback route: progressive-remux-to-mse');
    return remux;
  }
  if (!metadata || !route) return declined('mp4-range-or-kid-probe');
  if (route.kind === 'unsupported') return declined(route.reason);
  const kid = Uint8Array.from(metadata.kid.match(/../g), pair => parseInt(pair, 16));
  // Never attach a speculative EME session to the currently playing video.
  if (preload) return declined('preload-remux-unavailable');
  // Already-fragmented CENC remains encrypted and is delivered through EME.
  // When the local remux binary is not deployed, retain the existing fallback.
  if (typeof requestAccess !== 'function' || typeof video.setMediaKeys !== 'function')
    return declined('no-eme-or-remux');
  let access;
  try {
    onStage('eme-access');
    access = await requestAccess(KEY_SYSTEM, [{
      initDataTypes: ['cenc', 'keyids'],
      videoCapabilities: [{ contentType: mime, encryptionScheme: 'cenc' }],
      persistentState: 'not-allowed', distinctiveIdentifier: 'not-allowed',
      sessionTypes: ['temporary']
    }]);
  } catch (error) { return declined('key-system-access', error); }
  aborted(signal);
  let session = null, mediaKeysSet = false;
  try {
    aborted(signal);
    onStage('eme-session');
    const keys = await access.createMediaKeys();
    await video.setMediaKeys(keys);
    mediaKeysSet = true;
    session = keys.createSession('temporary');
    const listener = new Promise((resolve, reject) => {
      session.addEventListener('message', async event => {
        try {
          const request = JSON.parse(new TextDecoder().decode(event.message));
          const currentKid = base64Url(kid);
          if (!Array.isArray(request.kids) || !request.kids.includes(currentKid))
            throw errorWith('CENC_UNAVAILABLE', 'CDM 要求未知的影片金鑰');
          await session.update(new TextEncoder().encode(clearKeyLicense(kid, key)));
          resolve();
        } catch (error) { reject(error); }
      }, { once: true });
    });
    const timer = new Promise((_, reject) => setTimeout(
      () => reject(errorWith('CENC_UNAVAILABLE', '瀏覽器 Clear Key 初始化逾時')), 5000));
    const acceptsCenc = access.getConfiguration?.().initDataTypes?.includes('cenc');
    const initType = acceptsCenc ? 'cenc' : 'keyids';
    console.info('[Hongguo EME] init-data:', initType);
    const initData = acceptsCenc ? commonCencPssh(kid) : new TextEncoder().encode(
      JSON.stringify({ kids: [base64Url(kid)] }));
    await session.generateRequest(initType, initData);
    await Promise.race([listener, timer]);
    console.info('[Hongguo EME] key-status:',
      session.keyStatuses ? Array.from(session.keyStatuses.values()).join(',') || 'empty' : 'unavailable');
    aborted(signal);
    const mse = metadata.fragmented
      ? openCencMse({ video, mime, url, signal, fetchImpl }) : null;
    onStage('cenc.route', { kind: mse ? 'eme-mse' : 'eme-progressive' });
    console.info('[Hongguo EME] playback route:', mse ? 'mse-fmp4' : 'progressive-mp4');
    return {
      url: mse?.url || url, kind: mse?.kind || 'progressive',
      close: async () => {
        await mse?.close();
        await session.close().catch(() => {});
      }
    };
  } catch (error) {
    await session?.close().catch(() => {});
    if (mediaKeysSet) await video.setMediaKeys(null).catch(() => {});
    if (signal?.aborted) throw error;
    return declined('key-session-or-license', error);
  }
}
