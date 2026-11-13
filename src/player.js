// Video.js 10 controls with a native <video> media element.
// Source resolution, encryption, resume and episode navigation stay app-owned.
// Only the current episode is active.
// Both progress recording and restoration are guarded against the common
// reload race: a 0-second metadata load must never erase a saved position.
import { errorWith, classifyError, isHlsUrl, mediaProxyUrl } from './logic.js';
import { watchRecords, playbackKey, rememberPlayback, suggestedEpisode } from './library.js';
import { episodeCacheKey } from './media-cache.js';
import { recordFailure, playbackFailureMessage, playbackAttemptMessage } from './retry.js';
import { convertBytes, convertHls, prepareFfmpeg } from './ffmpeg.js';
import { availableRenditions, codecsAtQuality, playbackRendition, codecId, qualityId } from './source-options.js';
import { nextEpisode, shouldPrefetchNext } from './player-prefetch.js';
import { openClearKeyStream } from './clear-key.js';
import { bvc2BridgeAvailable, transcodeBvc2 } from './bvc2.js';
import { timeIsBuffered, clampStreamSeek } from './cenc-seek.js';

const PREF_KEY = 'hongguo-dl-player-preferences-v1';
const SESSION_TIMEOUT = 25000;
function loadPrefs(storage) {
  try { return JSON.parse(storage.getItem(PREF_KEY) || '{}') || {}; }
  catch { return {}; }
}
function printableSource(source) {
  const names = { h264: 'H.264', hevc: 'HEVC', bytevc2: 'ByteVC2' };
  return [
    (source.outputCodec ? 'ByteVC2 → H.264（WASM 實驗性轉碼）' : names[source.codec] || source.codec || ''),
    source.width && source.height ? source.width + '×' + source.height : source.quality || '',
    source.duration ? Math.round(source.duration) + ' 秒' : ''
  ].filter(Boolean).join(' · ');
}
export function createPlayer({
  video, status, label, prevButton, nextButton, qualitySelect, codecSelect,
  speedSelect, fitSelect, autoNextInput, settingsToggle, settingsMenu,
  settingsClose, pipButton, sourceInfo,
  getSeries, sourceFor, fetchBytes, getWorkerOrigin, cache, storage, onProgress
}) {
  let current = null;
  let controller = null, token = 0, activeUrl = null;
  let loading = false, readyForHistory = false, restoredTime = 0;
  let lastSaved = 0, lastUiPaint = 0, failure = null, recoveryStart = 0;
  let sourceAttempt = 0;
  let lastVariants = null, lastVariantsVid = null, lastVariantsAt = 0;
  let prefetched = null, lastStartupSeconds = 0, loadStartedAt = 0;
  let nativeStream = null, keyCleanup = Promise.resolve();
  let retryIncrementalCenc = false, retryError = null;
  let restartingRemoteSeek = false;
  let canTranscodeBvc2 = false;
  // All measurements refer to the same selected-episode click, not the start
  // of an individual fetch or decoder stage. Never log signed URLs or keys.
  let startupStages = new Set();
  function markStartupStage(stage) {
    if (!current || startupStages.has(stage) || !loadStartedAt) return;
    startupStages.add(stage);
    console.info('[Hongguo startup] E' + current.index + ' ' + stage + ': ' +
      Math.round(performance.now() - loadStartedAt) + 'ms');
  }
  const mimeSupport = mime => video.canPlayType(mime);
  // Source selection uses a provisional HEVC probe; openClearKeyStream later
  // parses bounded hvcC metadata and checks the exact MSE SourceBuffer MIME.
  const mseSupport = mime => typeof MediaSource !== 'undefined' &&
    Boolean(MediaSource.isTypeSupported?.(mime));
  const CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC', bytevc2: 'ByteVC2/VVC' };
  video.controls = false;
  const preferences = loadPrefs(storage);
  for (const [select, value] of [
    [qualitySelect, preferences.quality], [codecSelect, preferences.codec],
    [speedSelect, preferences.speed], [fitSelect, preferences.fit]
  ]) {
    if (value && Array.from(select.options).some(o => o.value === value)) select.value = value;
  }
  if (typeof preferences.autoNext === 'boolean') autoNextInput.checked = preferences.autoNext;
  function persistPrefs() {
    try {
      storage.setItem(PREF_KEY, JSON.stringify({
        quality: qualitySelect.value, codec: codecSelect.value,
        speed: speedSelect.value, fit: fitSelect.value,
        autoNext: autoNextInput.checked
      }));
    } catch { /* storage might be disabled */ }
  }
  function setStatus(value) { status.textContent = value; }
  function updateCodecOptions(variants) {
    const available = availableRenditions(variants);
    const atQuality = codecsAtQuality(variants, qualitySelect.value);
    for (const option of codecSelect.options) {
      if (option.value !== 'auto')
        option.disabled = available.codecs.length > 0 &&
          !(qualitySelect.value === 'auto' ? available.codecs : atQuality).includes(option.value);
    }
    if (codecSelect.value !== 'auto' && !atQuality.includes(codecSelect.value))
      codecSelect.value = 'auto';
    const auto = codecSelect.querySelector('option[value="auto"]');
    if (auto) auto.textContent = atQuality.length === 1 && qualitySelect.value !== 'auto'
      ? '自動（' + (CODEC_NAMES[atQuality[0]] || atQuality[0]) + '）' : '自動';
    for (const option of qualitySelect.options) {
      if (option.value !== 'auto') {
        const candidates = (variants || []).filter(v => qualityId(v) === option.value);
        option.disabled = available.qualities.length > 0 && !candidates.length;
        option.textContent = option.value + (candidates.length &&
          candidates.every(v => codecId(v.codec) === 'bytevc2' && v.contentKey) && !canTranscodeBvc2
            ? '（ByteVC2，尚無可用 WASM）' : '');
      }
    }
  }
  function ordered() {
    return [...(getSeries()?.episodes || [])].sort((a, b) => Number(a.index) - Number(b.index));
  }
  function refreshButtons() {
    const list = ordered(), i = list.findIndex(ep => ep.vid === current?.vid);
    prevButton.disabled = i < 1;
    nextButton.disabled = i < 0 || i >= list.length - 1;
  }
  function savePosition(completed = false) {
    // Switching sources triggers pause/timeupdate/emptied events. Until a real
    // media timeline exists, its zero timestamp is NOT a new viewing position.
    if (!current || !readyForHistory || !Number.isFinite(video.currentTime)) return;
    const series = getSeries();
    rememberPlayback(storage, series?.seriesId, current.vid,
      video.currentTime, video.duration, completed);
    onProgress?.();
  }
  function savedResumeSeconds(episode, seriesId = getSeries()?.seriesId) {
    const record = watchRecords(storage)[playbackKey(seriesId, episode.vid)];
    return !record?.completed && Number.isFinite(record?.seconds) &&
      record.seconds > 0.5 ? record.seconds : 0;
  }
  function disposeNativeKeys() {
    const stream = nativeStream;
    if (!stream) return;
    nativeStream = null;
    // The media element is unloaded before clearing MediaKeys. New loads must
    // await this cleanup, otherwise two episodes could race over one CDM.
    keyCleanup = keyCleanup.catch(() => {}).then(async () => {
      await stream.close();
      await video.setMediaKeys(null);
    }).catch(() => {});
  }
  function disposeSource() {
    controller?.abort();
    controller = null;
    readyForHistory = false;
    loading = false;
    video.pause();
    video.removeAttribute('src');
    video.load();
    disposeNativeKeys();
    if (activeUrl) { URL.revokeObjectURL(activeUrl); activeUrl = null; }
  }
  async function waitMetadata(signal) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;
    await new Promise((resolve, reject) => {
      let timeout;
      const clear = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', loaded);
        video.removeEventListener('error', failed);
        signal.removeEventListener('abort', aborted);
      };
      const loaded = () => { clear(); resolve(); };
      const failed = () => { clear(); reject(errorWith('PLAYBACK_ERROR',
        video.error?.message || '瀏覽器無法解碼此影片')); };
      const aborted = () => { clear(); reject(errorWith('CANCELED', '已切換影片')); };
      timeout = setTimeout(() => { clear(); reject(errorWith('PLAYBACK_TIMEOUT', '載入影片逾時')); },
        SESSION_TIMEOUT);
      video.addEventListener('loadedmetadata', loaded, { once: true });
      video.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
  // Firefox often exposes metadata before HTTP Range seekability. Set the
  // target, then retry when media data/seekable ranges arrive. Never overwrite
  // saved localStorage while this asynchronous restoration is in flight.
  async function restoreTime(seconds, signal) {
    if (!Number.isFinite(seconds) || seconds <= 0.5) return;
    const target = Number.isFinite(video.duration)
      ? Math.min(seconds, Math.max(0, video.duration - 0.3)) : seconds;
    function trySeek() {
      if (signal.aborted || !Number.isFinite(target)) return false;
      try {
        if (Math.abs(video.currentTime - target) > 0.4) video.currentTime = target;
        return Math.abs(video.currentTime - target) < 0.6;
      } catch { return false; }
    }
    if (trySeek()) return;
    await new Promise(resolve => {
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadeddata', check);
        video.removeEventListener('canplay', check);
        video.removeEventListener('progress', check);
        video.removeEventListener('seeked', check);
        signal.removeEventListener('abort', cleanup);
        resolve();
      };
      const check = () => { if (trySeek()) cleanup(); };
      const timeout = setTimeout(cleanup, 8000);
      for (const type of ['loadeddata', 'canplay', 'progress', 'seeked'])
        video.addEventListener(type, check);
      signal.addEventListener('abort', cleanup, { once: true });
      check();
    });
    if (!signal.aborted) trySeek();
  }
  // MSE reports loadedmetadata before its first media fragment arrives.
  // Keep the resume handshake in 'loading' state until the requested instant
  // is actually decoded/buffered. Otherwise a delayed seeking event can
  // accidentally start a second Worker and discard the first one.
  async function waitForCencResume(seconds, signal, stream) {
    if (stream?.kind !== 'cenc-remux' || seconds <= 0.5) return;
    const target = clampStreamSeek(seconds, stream.durationSeconds || video.duration);
    if (target === null) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const events = ['progress', 'loadeddata', 'canplay', 'seeked',
        'timeupdate', 'durationchange', 'playing'];
      const cleanup = () => {
        clearTimeout(timeout);
        for (const event of events) video.removeEventListener(event, check);
        video.removeEventListener('error', failed);
        signal.removeEventListener('abort', canceled);
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const canceled = () => finish(errorWith('CANCELED', '已切換影片'));
      const failed = () => finish(errorWith('PLAYBACK_ERROR', 'CENC 續播解碼失敗'));
      const check = () => {
        if (signal.aborted) return canceled();
        if (video.error) return failed();
        if (!timeIsBuffered(video.buffered, target, 0.15)) return;
        // Some browsers keep currentTime at zero during MSE startup even
        // after we first assigned the target in restoreTime().
        if (Math.abs(video.currentTime - target) > 0.6) {
          try { video.currentTime = target; } catch { /* retry on canplay */ }
        }
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            Math.abs(video.currentTime - target) <= 0.6) finish();
      };
      const timeout = setTimeout(() =>
        finish(errorWith('PLAYBACK_TIMEOUT', 'CENC 續播片段未在時限內準備完成')),
      SESSION_TIMEOUT);
      for (const event of events) video.addEventListener(event, check);
      video.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', canceled, { once: true });
      check();
    });
  }
  const streamStages = {
    metadata: '正在讀取影片索引與加密資訊…',
    'remux-check': '正在檢查增量串流支援…',
    'eme-access': '正在檢查瀏覽器串流解密支援…',
    'eme-session': '正在初始化串流解密…',
    'wasm-download': '正在載入增量串流工具…',
    'wasm-verify': '正在驗證串流工具…',
    'wasm-start': '正在初始化串流工具…',
    'first-fragment': '正在讀取並解密首段影片…'
  };
  function reportStartup(message, signal, attempt = 0) {
    if (!signal.aborted) setStatus(playbackAttemptMessage(message, attempt, retryError));
  }
  async function prepareNativeStream(args) {
    try {
      const stream = await openClearKeyStream(args);
      if (stream?.kind === 'cenc-remux') retryIncrementalCenc = true;
      return stream;
    }
    catch (error) {
      // This also covers the nativePending prefetch handoff, not just open().
      if (['CENC_SOURCE_FORBIDDEN', 'CENC_RANGE_HTTP'].includes(error?.code))
        retryIncrementalCenc = true;
      throw error;
    }
  }
  async function sourceForEpisode(episode, signal, attempt = 0, options = {}) {
    const series = getSeries();
    const quality = options.quality ?? qualitySelect.value;
    let codec = options.codec ?? codecSelect.value;
    const quiet = !!options.quiet;
    const report = message => { if (!quiet) reportStartup(message, signal, attempt); };
    const onStage = stage => { if (streamStages[stage]) report(streamStages[stage]); };
    const fallbackStatus = message => report(
      '⚠ 串流未就緒，改為整集下載備援；下載並處理完成後才能播放 · ' + message);
    const seriesId = options.seriesId ?? series?.seriesId;
    let key = episodeCacheKey(seriesId, episode.vid, quality, codec);
    const entry = attempt === 0 ? cache.getEntry(key) : null;
    if (entry?.blob) {
      report('正在讀取已快取的影片…');
      return { blob: entry.blob, source: entry.source || { codec, quality, source: 'cache' } };
    }
    report(attempt ? '正在選取其他 CDN／更新影片來源…' : '正在取得影片來源…');
    // Keep a short-lived source list to rotate through alternate CDNs on
    // retry without another upstream API call. Refresh on the next cycle.
    const sameList = !quiet && lastVariants && lastVariantsVid === episode.vid &&
      Date.now() - lastVariantsAt < 30000;
    const list = options.variants?.length ? { variants: options.variants }
      : episode.vid === 'direct'
      ? { variants: [{ url: episode.url, source: 'web', codec: 'unknown', contentKey: null }] }
      : sameList && attempt > 0 && attempt < lastVariants.length
        ? { variants: lastVariants }
        : await sourceFor(seriesId, episode.vid, 'auto', 'auto', signal);
    if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
    const variants = list.variants || [];
    // A standard browser VVC decoder is not a BVC2 decoder. Only advertise
    // this tier when the dedicated Librempeg WASM bundle is deployed.
    if (variants.some(v => codecId(v.codec) === 'bytevc2'))
      report('正在檢查 ByteVC2 播放工具…');
    canTranscodeBvc2 = variants.some(v => codecId(v.codec) === 'bytevc2')
      ? await bvc2BridgeAvailable() : false;
    if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
    if (!quiet) {
      lastVariants = variants;
      lastVariantsVid = episode.vid;
      lastVariantsAt = Date.now();
      updateCodecOptions(variants);
      // Persisted codec preferences can belong to another episode's tier.
      // Use the now-enabled selection, rather than rejecting a stale codec.
      if (codec !== codecSelect.value) {
        codec = codecSelect.value;
        key = episodeCacheKey(seriesId, episode.vid, quality, codec);
        persistPrefs();
      }
    }
    // A fixed tier is not a fixed codec: Nova's 720p is encrypted VVC, not
    // HEVC. Reject it before spending bandwidth and CPU on doomed FFmpeg work.
    const resolved = playbackRendition(variants,
      { quality, codec }, mimeSupport, attempt, canTranscodeBvc2, mseSupport);
    const source = resolved.source;
    if (!source?.url) {
      const tiers = availableRenditions(variants);
      const offered = tiers.qualities.map(q =>
        q + '：' + codecsAtQuality(variants, q).map(c => CODEC_NAMES[c] || c).join('/')).join('、');
      throw errorWith('PLAYBACK_UNSUPPORTED',
        '所選 ' + (quality === 'auto' ? '自動畫質' : quality) +
        ' 沒有可播放的編碼；可用來源：' + (offered || '未知') +
        '。ByteVC2 須部署 Librempeg WASM 轉碼器；HEVC 需瀏覽器支援。');
    }
    let fallbackNotice = '';
    if (resolved.fallback) {
      const original = quality;
      const actual = qualityId(source);
      const originalCodecs = codecsAtQuality(variants, original)
        .map(id => CODEC_NAMES[id] || id).join('/');
      fallbackNotice = original + ' 只有 ' + originalCodecs +
        '，已改用 ' + actual + ' ' + (CODEC_NAMES[codecId(source.codec)] || source.codec);
      if (!quiet && actual && Array.from(qualitySelect.options).some(o => o.value === actual)) {
        qualitySelect.value = actual;
        codecSelect.value = 'auto';
        updateCodecOptions(variants);
        persistPrefs();
      }
    }
    const profile = source.source === 'app' ? 'app' : 'web';
    if (codecId(source.codec) === 'bytevc2') {
      if (isHlsUrl(source.url)) throw errorWith('PLAYBACK_UNSUPPORTED',
        'ByteVC2 HLS 尚未支援；目前的 WASM 路徑只接受 MP4');
      // Do not transcode a whole second episode during playback. Prefetch
      // metadata now; take over when the user actually switches episodes.
      if (quiet) return { bvc2Pending: true, source, fallbackNotice, variants };
      const reportBvc2 = message => report(
        '⚠ 此 ByteVC2 模式需下載及轉碼整集，完成後才能播放 · ' + message);
      reportBvc2('讀取 ByteVC2 影片…');
      const started = performance.now();
      let received = 0;
      const raw = await fetchBytes(source.url, profile, signal, 260 * 1024 * 1024,
        (length, total) => {
          received += length;
          if (length > 0) markStartupStage('first-media-byte');
          if (total > 0) reportBvc2('讀取 ByteVC2 影片 ' +
            Math.min(100, Math.round(100 * received / total)) + '%（需整集下載）');
        });
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      reportBvc2('ByteVC2 整集已下載；準備 WASM 轉碼（此模式尚不能串流起播）');
      const bvc2Phases = {
        'wasm-loading': '載入 ByteVC2 WASM 解碼器…',
        'wasm-ready': 'ByteVC2 解碼器已就緒…',
        transcoding: 'ByteVC2 → H.264 正在轉碼整集；完成前無法顯示影格，請勿誤認為已起播',
        finalizing: 'ByteVC2 轉碼完成，正在輸出 MP4…'
      };
      const transcoded = await transcodeBvc2(raw, {
        contentKey: source.contentKey, signal,
        onProgress: phase => {
          if (!signal.aborted && bvc2Phases[phase]) reportBvc2(bvc2Phases[phase]);
        }
      });
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      console.info('[Hongguo playback] E' + episode.index + ' ByteVC2 解密轉碼：' +
        Math.round(performance.now() - started) + 'ms');
      const playable = new Blob([transcoded], { type: 'video/mp4' });
      const outputSource = { ...source, outputCodec: 'h264' };
      cache.put(key, playable, outputSource);
      return { blob: playable, source: outputSource, fallbackNotice, variants: null };
    }
    if (!isHlsUrl(source.url) && !source.contentKey)
      return { url: mediaProxyUrl(source.url, profile, getWorkerOrigin()),
        source, fallbackNotice, variants: quiet ? variants : null };
    // If the current episode already uses native EME, prepare only the next
    // episode's source metadata. Avoid downloading+remuxing the whole upcoming
    // episode with FFmpeg while the current one already streams natively.
    if (quiet && options.nativePrefetch && source.contentKey && !isHlsUrl(source.url)) {
      return { nativePending: true, source, fallbackNotice, variants };
    }
    // The browser's native CDM performs CENC-AES-CTR on its HTTP Range
    // stream: no full MP4 buffer, JS crypto loop, or FFmpeg virtual FS.
    // ByteVC2 still needs a dedicated decoder, which the CDM cannot supply.
    if (!quiet && (attempt === 0 || retryIncrementalCenc) &&
        source.contentKey && !isHlsUrl(source.url)) {
      await keyCleanup;
      const native = await prepareNativeStream({
        video, source, codec: codecId(source.codec),
        workerOrigin: getWorkerOrigin(), signal,
        startSeconds: savedResumeSeconds(episode, seriesId), onStage
      });
      if (native) {
        if (native.kind === 'cenc-remux') retryIncrementalCenc = true;
        return { url: native.url, native, source, fallbackNotice, variants: null };
      }
      if (retryIncrementalCenc)
        throw errorWith('CENC_UNAVAILABLE', '增量串流重試失敗，已禁止整檔備援下載');
    }
    let bytes;
    if (isHlsUrl(source.url)) {
      if (!quiet) report('⚠ 此影片需先下載並封裝整集，完成後才能播放 · 正在讀取分片清單…');
      bytes = await convertHls(source.url, {
        mode: 'copy', contentKey: source.contentKey, signal,
        fetchBytes: (uri, sig, max) => fetchBytes(uri, profile, sig, max),
        segmentProgress: x => report('⚠ 此影片需先下載並封裝整集，完成後才能播放 · 分片 ' + x.current + '/' + x.total)
      });
    } else {
      // Encrypted MP4s still require the complete source before decryption.
      // Initialize FFmpeg after the first media chunk, in parallel with the
      // remaining download, so the initial startup stages do not run serially.
      let warmup = !quiet ? prepareFfmpeg(signal).then(() => null, error => error) : null;
      let received = 0, lastUpdate = 0;
      const downloadStarted = performance.now();
      fallbackStatus('正在下載整集影片…');
      const raw = await fetchBytes(source.url, profile, signal,
        quiet ? Math.min(cache.limit, 32 * 1024 * 1024) : 260 * 1024 * 1024,
        (length, total) => {
          if (!warmup) warmup = prepareFfmpeg(signal).then(() => null, error => error);
          received += length;
          if (length > 0) markStartupStage('first-media-byte');
          const now = Date.now();
          if (!quiet && now - lastUpdate > 250) {
            lastUpdate = now;
            fallbackStatus(total ? '下載整集 ' + Math.min(100, Math.round(100 * received / total)) + '%'
              : '正在下載整集影片…');
          }
        });
      fallbackStatus('整集已下載，正在準備影片處理工具…');
      const warmupError = await (warmup || prepareFfmpeg(signal).then(() => null, error => error));
      if (warmupError) throw warmupError;
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (!quiet) {
        console.info('[Hongguo playback] E' + episode.index +
          ' 片源下載：' + Math.round(performance.now() - downloadStarted) +
          'ms，' + raw.byteLength + ' bytes');
        fallbackStatus('正在解密並重新封裝整集影片…');
      }
      const remuxStarted = performance.now();
      bytes = await convertBytes(raw, { mode: 'copy', contentKey: source.contentKey, signal });
      if (!quiet) console.info('[Hongguo playback] E' + episode.index +
        ' 解密封裝：' + Math.round(performance.now() - remuxStarted) + 'ms');
    }
    if (!bytes?.length) throw errorWith('EMPTY_MEDIA', '來源沒有媒體資料');
    const result = new Blob([bytes], { type: 'video/mp4' });
    if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
    cache.put(key, result, source);
    return { blob: result, source, fallbackNotice, fullFileFallback: true,
      variants: quiet ? variants : null };
  }
  async function load(episode, currentToken, signal, autoPlay, handoff = null) {
    const attempt = sourceAttempt++;
    // If the incoming episode is already being downloaded/decrypted, consume
    // that one promise rather than issuing a second expensive media request.
    if (handoff && attempt === 0)
      reportStartup('正在接續預取的影片來源…', signal, attempt);
    const prepared = handoff && attempt === 0 ? await handoff.promise : null;
    let resolved = prepared || await sourceForEpisode(episode, signal, attempt);
    if (resolved?.bvc2Pending) {
      resolved = await sourceForEpisode(episode, signal, attempt,
        { variants: resolved.variants });
    }
    if (resolved?.nativePending) {
      await keyCleanup;
      const native = await prepareNativeStream({
        video, source: resolved.source, codec: codecId(resolved.source.codec),
        workerOrigin: getWorkerOrigin(), signal,
        startSeconds: savedResumeSeconds(episode),
        onStage: stage => {
          if (streamStages[stage]) reportStartup(streamStages[stage], signal, attempt);
        }
      });
      resolved = native ? { ...resolved, native, url: native.url, nativePending: false }
        : await sourceForEpisode(episode, signal, attempt,
          { variants: prepared.variants });
    }
    if (signal.aborted || currentToken !== token) return;
    if (prepared?.variants?.length) {
      lastVariants = prepared.variants;
      lastVariantsVid = episode.vid;
      lastVariantsAt = Date.now();
      updateCodecOptions(prepared.variants);
      if (prepared.fallbackNotice) {
        const actual = qualityId(prepared.source);
        if (actual && Array.from(qualitySelect.options).some(o => o.value === actual)) {
          qualitySelect.value = actual;
          codecSelect.value = 'auto';
          updateCodecOptions(prepared.variants);
          persistPrefs();
        }
      }
    }
    sourceInfo.textContent = printableSource(resolved.source) || '來源資訊不完整';
    if (resolved.fallbackNotice) sourceInfo.textContent += ' · ' + resolved.fallbackNotice;
    if (resolved.native) sourceInfo.textContent +=
      resolved.native.kind === 'cenc-remux' ? ' · 增量解密轉封裝（MSE）'
      : resolved.native.kind === 'mse' ? ' · 原生串流解密（MSE）'
      : ' · 原生串流解密（MP4）';
    const containerCodec = resolved.source?.outputCodec || codecId(resolved.source?.codec);
    const decoder = containerCodec === 'hevc'
      ? 'video/mp4; codecs="hvc1"' : containerCodec === 'bytevc2'
      ? 'video/mp4; codecs="vvc1"' : 'video/mp4; codecs="avc1.42E01E"';
    // The actual complete hvcC profile was already accepted by MSE for a
    // remux stream; bare hvc1 canPlayType must not produce a false warning.
    if (containerCodec &&
        !(containerCodec === 'hevc' && resolved.native?.kind === 'cenc-remux') &&
        video.canPlayType(decoder) === '')
      sourceInfo.textContent += ' · 此編碼可能無法在本瀏覽器播放';
    await keyCleanup;
    if (signal.aborted || currentToken !== token) return;
    if (activeUrl) URL.revokeObjectURL(activeUrl);
    // The native key session belongs to this source and is released before
    // any subsequent selection, retry, or playback-mode transition.
    nativeStream = resolved.native || null;
    activeUrl = resolved.blob ? URL.createObjectURL(resolved.blob) : null;
    loading = true;
    // The callback reports a frame submitted for presentation, unlike
    // loadedmetadata/canplay which do not prove a picture was shown.
    if (typeof video.requestVideoFrameCallback === 'function') {
      const frameToken = currentToken;
      video.requestVideoFrameCallback(() => {
        if (frameToken === token && !signal.aborted) markStartupStage('first-video-frame');
      });
    }
    video.src = activeUrl || resolved.url;
    const selectedRate = Number(speedSelect.value) || 1;
    // HTMLMediaElement.load() may reset playbackRate to defaultPlaybackRate.
    // Keep the chosen speed across quality/codec changes, resume and next episode.
    video.defaultPlaybackRate = selectedRate;
    video.style.objectFit = fitSelect.value;
    video.load();
    video.playbackRate = selectedRate;
    reportStartup(resolved.fullFileFallback
      ? '整集下載備援處理完成，正在開啟影片…'
      : '正在等待影片資訊與首段緩衝…', signal, attempt);
    await waitMetadata(signal);
    markStartupStage('loadedmetadata');
    if (signal.aborted || currentToken !== token) return;
    const wanted = savedResumeSeconds(episode);
    if (wanted > 0.5) reportStartup('正在恢復觀看進度…', signal, attempt);
    await restoreTime(wanted, signal);
    await waitForCencResume(wanted, signal, resolved.native);
    if (signal.aborted || currentToken !== token) return;
    restoredTime = wanted;
    readyForHistory = true;
    loading = false;
    recoveryStart = video.currentTime;
    lastStartupSeconds = Math.max(0, (performance.now() - loadStartedAt) / 1000);
    console.info('[Hongguo playback] E' + episode.index + ' 可開始播放：' +
      Math.round(lastStartupSeconds * 1000) + 'ms' + (prepared ? '（使用預取）' : ''));
    setStatus(resolved.fallbackNotice || (wanted > 0 ? '已續播' : ''));
    onProgress?.();
    if (autoPlay) {
      try { await video.play(); }
      catch (error) {
        if (error.name === 'NotAllowedError') setStatus('點選影片即可開始播放');
        else throw errorWith('PLAYBACK_ERROR', error.message || '無法播放此片源');
      }
    }
  }
  async function run(episode, currentToken, signal, autoPlay, previous = null, handoff = null) {
    let errors = previous;
    while (!signal.aborted && currentToken === token) {
      try { await load(episode, currentToken, signal, autoPlay, handoff); return; }
      catch (error) {
        const parsed = classifyError(error);
        handoff = null;
        if (nativeStream) {
          video.pause();
          video.removeAttribute('src');
          video.load();
          disposeNativeKeys();
        }
        if (signal.aborted || currentToken !== token || parsed.code === 'CANCELED') return;
        if (parsed.code === 'PLAYBACK_UNSUPPORTED') {
          loading = false;
          setStatus('無法播放 · ' + parsed.message);
          return;
        }
        errors = recordFailure(errors, parsed, 5, 20, { retryForbidden: true });
        failure = errors;
        retryError = parsed;
        setStatus(playbackFailureMessage(errors, parsed, 5));
        if (!errors.retry) {
          loading = false;
          return;
        }
        await new Promise(resolve => setTimeout(resolve, errors.delay));
      }
    }
  }
  function cancelPrefetch(exceptVid = null) {
    if (prefetched && prefetched.vid !== exceptVid) {
      prefetched.controller.abort();
      prefetched = null;
    }
  }
  function maybePrefetchNext() {
    if (!current || !readyForHistory || !getSeries() || !video.duration) return;
    const next = nextEpisode(ordered(), current.vid);
    if (!shouldPrefetchNext({
      duration: video.duration, position: video.currentTime,
      startupSeconds: lastStartupSeconds, paused: video.paused,
      autoNext: autoNextInput.checked, saveData: !!navigator.connection?.saveData,
      hasNext: !!next
    })) return;
    const seriesId = getSeries().seriesId, quality = qualitySelect.value;
    const codec = codecSelect.value;
    const key = episodeCacheKey(seriesId, next.vid, quality, codec);
    if (prefetched?.key === key || cache.getEntry(key)) return;
    cancelPrefetch();
    const preloadController = new AbortController();
    // A prefetch is intentionally bounded to one episode and <=32 MiB of
    // incoming encrypted media. Failures remain silent until actually played.
    const promise = sourceForEpisode(next, preloadController.signal, 0, {
      quiet: true, quality, codec, seriesId,
      nativePrefetch: Boolean(nativeStream)
    }).catch(() => null);
    prefetched = { vid: next.vid, key, controller: preloadController, promise };
  }
  function open(episode, autoPlay = true, keepSettings = false) {
    if (!episode) return;
    const key = episodeCacheKey(getSeries()?.seriesId, episode.vid,
      qualitySelect.value, codecSelect.value);
    const handoff = prefetched?.vid === episode.vid && prefetched.key === key
      ? prefetched : null;
    if (handoff) prefetched = null;
    else cancelPrefetch();
    savePosition();
    disposeSource();
    current = episode;
    failure = null;
    sourceAttempt = 0;
    retryIncrementalCenc = false;
    retryError = null;
    if (lastVariantsVid !== episode.vid) {
      lastVariants = null;
      lastVariantsVid = null;
    }
    refreshButtons();
    label.textContent = '第 ' + episode.index + ' 集';
    sourceInfo.textContent = '';
    if (!keepSettings) showSettings(false);
    const signal = (controller = new AbortController()).signal;
    const currentToken = ++token;
    loadStartedAt = performance.now();
    startupStages = new Set();
    if (handoff) signal.addEventListener('abort', () => handoff.controller.abort(), { once: true });
    setStatus('正在準備播放…');
    void run(episode, currentToken, signal, autoPlay, null, handoff);
    onProgress?.();
  }
  function step(direction) {
    const list = ordered(), index = list.findIndex(ep => ep.vid === current?.vid);
    if (list[index + direction]) open(list[index + direction]);
  }
  video.addEventListener('canplay', () => markStartupStage('canplay'));
  video.addEventListener('timeupdate', () => {
    if (!current || !readyForHistory || !Number.isFinite(video.currentTime)) return;
    maybePrefetchNext();
    const now = Date.now();
    if (failure && video.currentTime - recoveryStart > 5) failure = null;
    if (now - lastUiPaint > 950) { lastUiPaint = now; onProgress?.(); }
    if (now - lastSaved > 1800) { lastSaved = now; savePosition(); }
  });
  video.addEventListener('pause', () => {
    if (readyForHistory && !video.ended) savePosition();
  });
  // A native fMP4 SourceBuffer cannot fetch a missing target timestamp by
  // assigning currentTime alone. Rebuild the remux at the preceding indexed
  // RAP, then restore the same global timeline after MSE becomes ready.
  video.addEventListener('seeking', () => {
    if (!current || loading || restartingRemoteSeek || !readyForHistory ||
        !nativeStream?.seekTo || !controller || controller.signal.aborted) return;
    const target = clampStreamSeek(video.currentTime,
      nativeStream.durationSeconds || video.duration);
    if (target === null || timeIsBuffered(video.buffered, target)) return;
    const seekToken = token, signal = controller.signal, oldStream = nativeStream;
    const wasPlaying = !video.paused;
    restartingRemoteSeek = true;
    readyForHistory = false; // Never overwrite saved position with temporary t=0.
    loading = true;
    setStatus('跳轉到 ' + Math.round(target) + ' 秒…');
    void (async () => {
      try {
        const nextStream = await oldStream.seekTo(target);
        if (signal.aborted || seekToken !== token) {
          await nextStream.close();
          return;
        }
        nativeStream = nextStream;
        // An unbuffered CENC seek replaces the whole MediaSource. load()
        // may reset the element speed, even though quality-switch loads now
        // preserve it. Keep the user's selected rate on both paths.
        const rate = Number(speedSelect.value) || 1;
        video.defaultPlaybackRate = rate;
        video.src = nextStream.url;
        video.load();
        video.playbackRate = rate;
        await waitMetadata(signal);
        if (signal.aborted || seekToken !== token) return;
        await restoreTime(target, signal);
        if (signal.aborted || seekToken !== token) return;
        restoredTime = target;
        readyForHistory = true;
        loading = false;
        savePosition();
        setStatus('已跳轉到 ' + Math.round(target) + ' 秒');
        if (wasPlaying) {
          try { await video.play(); }
          catch (error) {
            if (error.name === 'NotAllowedError')
              setStatus('點選影片即可繼續播放');
            else throw error;
          }
        }
      } catch (error) {
        if (!signal.aborted && seekToken === token) {
          loading = false;
          // Avoid logging a signed media URL, CENC key or source payload.
          setStatus('跳轉失敗：請重新選取本集（' +
            (error?.name === 'NotAllowedError' ? '自動播放受限' : '串流未就緒') + '）');
        }
      } finally {
        restartingRemoteSeek = false;
      }
    })();
  });
  video.addEventListener('seeked', () => {
    if (readyForHistory) savePosition();
    maybePrefetchNext();
  });
  video.addEventListener('ended', () => {
    if (!current || !readyForHistory) return;
    savePosition(true);
    const index = ordered().findIndex(ep => ep.vid === current.vid);
    const next = ordered()[index + 1];
    if (next && autoNextInput.checked) open(next);
    else setStatus('播放完成');
  });
  video.addEventListener('error', () => {
    if (!current || loading || !controller || controller.signal.aborted) return;
    const currentToken = token, signal = controller.signal;
    if (nativeStream) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      disposeNativeKeys();
    }
    const parsed = { code: 'PLAYBACK_ERROR', message: video.error?.message || '播放中斷' };
    retryError = parsed;
    failure = recordFailure(failure, parsed, 5, 20, { retryForbidden: true });
    setStatus(playbackFailureMessage(failure, parsed, 5));
    if (!failure.retry) return;
    const prior = failure;
    void new Promise(resolve => setTimeout(resolve, prior.delay)).then(() => {
      if (currentToken === token && !signal.aborted) void run(current, currentToken, signal, true, prior);
    });
  });
  function showSettings(visible) {
    settingsMenu.hidden = !visible;
    settingsToggle.setAttribute('aria-expanded', String(visible));
  }
  settingsToggle.addEventListener('click', () => showSettings(settingsMenu.hidden));
  settingsClose.addEventListener('click', () => showSettings(false));
  prevButton.addEventListener('click', () => step(-1));
  nextButton.addEventListener('click', () => step(1));
  qualitySelect.addEventListener('change', () => {
    if (lastVariants) updateCodecOptions(lastVariants);
    persistPrefs();
    if (current) open(current, true, true);
  });
  codecSelect.addEventListener('change', () => {
    persistPrefs();
    if (current) open(current, true, true);
  });
  speedSelect.addEventListener('change', () => {
    const rate = Number(speedSelect.value) || 1;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    persistPrefs();
  });
  fitSelect.addEventListener('change', () => { video.style.objectFit = fitSelect.value; persistPrefs(); });
  autoNextInput.addEventListener('change', () => {
    persistPrefs();
    if (!autoNextInput.checked) cancelPrefetch();
    else maybePrefetchNext();
  });
  video.style.objectFit = fitSelect.value;
  if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
    pipButton.hidden = false;
    pipButton.addEventListener('click', () => {
      video.requestPictureInPicture().catch(() => setStatus('目前無法啟用子母畫面'));
    });
  }
  // pagehide also fires when a document enters the back/forward cache.
  // Explicitly abort the active Range/Worker before suspension, rather than
  // relying on the browser to tear down a still-live CENC remux.
  let resumeAfterPageShow = false;
  window.addEventListener('pagehide', () => {
    savePosition();
    cancelPrefetch();
    resumeAfterPageShow = Boolean(current && controller && !controller.signal.aborted);
    if (resumeAfterPageShow) {
      disposeSource();
      token++; // invalidate late callbacks from the removed media source
    }
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !resumeAfterPageShow || !current) return;
    resumeAfterPageShow = false;
    // A bfcache restore must not retain a stale Worker or autoplay without
    // a new gesture. Restore the saved timestamp and current settings.
    open(current, false, true);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
  refreshButtons();
  return {
    open, current: () => current,
    resume() {
      const series = getSeries();
      if (series) open(suggestedEpisode(series, watchRecords(storage)));
    },
    stop() {
      cancelPrefetch();
      savePosition(); current = null; disposeSource(); token++;
      label.textContent = '尚未播放'; refreshButtons();
    },
    pause() { if (readyForHistory) savePosition(); video.pause(); },
    deactivate() {
      // Leaving the playback mode is not an ordinary pause: relinquish all
      // Range fetches, remux workers, MSE buffers and pending prefetch.
      // Keep current episode + history so returning to playback can resume.
      cancelPrefetch();
      savePosition();
      if (current) { disposeSource(); token++; }
    },
    activate() {
      // Reopen a previously selected episode without autoplay after the
      // playback panel was left. Ordinary in-player pause stays buffered.
      if (!current) this.resume();
      else if (!video.getAttribute('src')) open(current, false, true);
    },
    refresh: refreshButtons
  };
}
