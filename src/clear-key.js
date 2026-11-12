// SPDX-License-Identifier: GPL-3.0-only
// CENC Clear Key uses the browser CDM and HTTP Range rather than decrypting
// millions of samples in JS/WASM. JS inspects at most 1 MiB of MP4 metadata.
import { mediaProxyUrl, errorWith } from './logic.js';

const HEADER_SIZE = 64 * 1024;
const MAX_MOOV = 1024 * 1024;
const MAX_RANGES = 4;
const KEY_SYSTEM = 'org.w3.clearkey';

const read32 = (data, pos) =>
  (data[pos] * 0x1000000 + (data[pos + 1] << 16) + (data[pos + 2] << 8) + data[pos + 3]) >>> 0;
const typeAt = (data, pos) =>
  String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);

export function mp4Boxes(data, fileOffset = 0) {
  const boxes = [];
  for (let pos = 0; pos + 8 <= data.length;) {
    let size = read32(data, pos), header = 8;
    if (size === 1) {
      if (pos + 16 > data.length) break;
      size = read32(data, pos + 8) * 0x100000000 + read32(data, pos + 12);
      header = 16;
    }
    if (!Number.isSafeInteger(size) || size < header) break;
    const box = { type: typeAt(data, pos), offset: fileOffset + pos,
      size, complete: size <= data.length - pos };
    boxes.push(box);
    if (!box.complete) break;
    pos += size;
  }
  return boxes;
}

export function cencKidFromMoov(data) {
  if (!(data instanceof Uint8Array) || data.length > MAX_MOOV ||
      data.length < 32 || typeAt(data, 0) !== 'moov' ||
      read32(data, 0) !== data.length) return null;
  // Only examine moov (not mdat). Validate tenc size and version before
  // taking the default_KID; the rest of the CENC structure stays native.
  for (let typePos = 8; typePos + 28 <= data.length; typePos++) {
    if (data[typePos] !== 0x74 || data[typePos + 1] !== 0x65 ||
        data[typePos + 2] !== 0x6e || data[typePos + 3] !== 0x63) continue;
    const start = typePos - 4, size = read32(data, start);
    if (size < 32 || size > 128 || start + size > data.length ||
        data[start + 8] > 1 || ![8, 16].includes(data[start + 15])) continue;
    const kid = data.slice(start + 16, start + 32);
    if (kid.length === 16 && kid.some(Boolean)) return kid;
  }
  return null;
}

function aborted(signal) {
  if (signal?.aborted) throw errorWith('CANCELED', '已切換影片');
}
async function rangeFetch(url, start, bytes, signal, fetchImpl) {
  aborted(signal);
  if (!Number.isSafeInteger(start) || start < 0 || bytes > MAX_MOOV ||
      bytes < 8 || !Number.isSafeInteger(start + bytes))
    throw errorWith('CENC_UNAVAILABLE', 'MP4 metadata 超出限定範圍');
  const res = await fetchImpl(url, {
    headers: { Range: 'bytes=' + start + '-' + (start + bytes - 1) },
    signal, cache: 'no-store'
  });
  if (res.status !== 206) {
    await res.body?.cancel();
    throw errorWith('CENC_UNAVAILABLE', 'CDN 不支援有限的 HTTP Range 讀取');
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
  if (!match || Number(match[1]) !== start || Number(match[2]) >= start + bytes ||
      !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= Number(match[2])) {
    await res.body?.cancel();
    throw errorWith('CENC_UNAVAILABLE', 'HTTP Content-Range 不符合要求');
  }
  const length = Number(res.headers.get('content-length'));
  if (res.headers.has('content-length') && length > bytes) {
    await res.body?.cancel();
    throw errorWith('CENC_UNAVAILABLE', 'HTTP Range 回應過大');
  }
  const reader = res.body?.getReader();
  if (!reader) throw errorWith('CENC_UNAVAILABLE', 'HTTP Range 回應缺少串流');
  const chunks = [];
  let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      aborted(signal);
      count += value.byteLength;
      if (count > bytes) throw errorWith('CENC_UNAVAILABLE', 'HTTP Range 超過預算');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const output = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return { data: output, fileSize: Number(match[3]) };
}

export async function probeCencKid(mediaUrl, signal, fetchImpl = fetch, metadata = null) {
  let offset = 0;
  const tried = new Set();
  for (let probe = 0; probe < MAX_RANGES; probe++) {
    aborted(signal);
    if (tried.has(offset)) return null;
    tried.add(offset);
    const { data, fileSize } = await rangeFetch(mediaUrl, offset, HEADER_SIZE, signal, fetchImpl);
    const boxes = mp4Boxes(data, offset);
    if (probe === 0 && boxes[0]?.type !== 'ftyp') return null;
    for (const box of boxes) {
      if (box.type !== 'moov') continue;
      if (box.size > MAX_MOOV) return null;
      const moov = box.complete
        ? data.subarray(box.offset - offset, box.offset - offset + box.size)
        : (await rangeFetch(mediaUrl, box.offset, box.size, signal, fetchImpl)).data;
      if (metadata) {
        metadata.fragmented = mp4Boxes(moov.subarray(8))
          .some(child => child.type === 'mvex');
        metadata.fileSize = fileSize;
      }
      return cencKidFromMoov(moov);
    }
    const last = boxes.at(-1);
    if (!last || last.complete || last.type !== 'mdat') return null;
    const jump = last.offset + last.size;
    if (jump >= fileSize || jump <= offset) return null;
    offset = jump;
  }
  return null;
}

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
function openCencMse({ mime, url, signal, fetchImpl }) {
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
  video, source, codec, workerOrigin, signal,
  fetchImpl = fetch,
  requestAccess = typeof navigator !== 'undefined'
    ? navigator.requestMediaKeySystemAccess?.bind(navigator) : null
}) {
  // Only report a stage and an error type. Media URLs and content keys are
  // deliberately excluded from diagnostics (even on failures).
  const declined = (stage, error = null) => {
    console.info('[Hongguo EME] native stream unavailable:', stage,
      error?.name || '');
    return null;
  };
  const mime = mimeForCodec(codec);
  if (!mime || !source?.contentKey || typeof requestAccess !== 'function' ||
      typeof video.setMediaKeys !== 'function' || !video.canPlayType(mime)) return null;
  aborted(signal);
  let access;
  try {
    access = await requestAccess(KEY_SYSTEM, [{
      initDataTypes: ['cenc', 'keyids'],
      videoCapabilities: [{ contentType: mime, encryptionScheme: 'cenc' }],
      persistentState: 'not-allowed', distinctiveIdentifier: 'not-allowed',
      sessionTypes: ['temporary']
    }]);
  } catch (error) { return declined('key-system-access', error); }
  aborted(signal);
  const url = mediaProxyUrl(source.url, source.source === 'app' ? 'app' : 'web', workerOrigin);
  const metadata = {};
  let kid;
  try { kid = await probeCencKid(url, signal, fetchImpl, metadata); }
  catch (error) {
    if (signal?.aborted) throw error;
    return declined('mp4-range-or-kid-probe', error);
  }
  if (!kid) return declined('no-cenc-kid');
  const key = hexKey(source.contentKey);
  let session = null, mediaKeysSet = false;
  try {
    aborted(signal);
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
      ? openCencMse({ mime, url, signal, fetchImpl }) : null;
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
