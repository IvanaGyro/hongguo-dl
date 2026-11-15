import { playbackStage, processingMessage } from './playback-stage.js';
import { createPlaybackStatus } from './playback-status.js';
// Video.js 10 controls with a native <video> media element.
// Layer 3: media presentation, controls, resume and episode navigation.
// Playable-media preparation and lookahead belong to media-session.js.
// Only the current episode is active.
// Both progress recording and restoration are guarded against the common
// reload race: a 0-second metadata load must never erase a saved position.
import { errorWith, classifyError } from './logic.js';
import { watchRecords, playbackKey, rememberPlayback, suggestedEpisode } from './library.js';
import { recordFailure, playbackFailureMessage, playbackErrorSummary } from './retry.js';
import { renditionOptions, parseRenditionValue, matchingRenditionValue, codecId, playableVariants } from './source-options.js';
import { createMediaSession } from './media-session.js';
import { timeIsBuffered, clampStreamSeek } from './cenc-seek.js';
import { bufferedIntervals, bufferedAround } from './stream-buffer-policy.js';
import { bvc2PlaybackMode } from './playback-policy.js';

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
  video, status, label, prevButton, nextButton, qualitySelect,
  speedSelect, settingsToggle, settingsMenu,
  settingsClose, sourceInfo,
  getSeries, sourceFor, fetchBytes, getWorkerOrigin, cache, storage, onProgress,
  diagnostics = () => {}
}) {
  let current = null;
  let controller = null, token = 0, activeUrl = null;
  let loading = false, readyForHistory = false, restoredTime = 0;
  let lastSaved = 0, lastUiPaint = 0, failure = null, recoveryStart = 0;
  let lastStartupSeconds = 0, loadStartedAt = 0;
  let nativeStream = null, keyCleanup = Promise.resolve();
  let directNativeProxyFallback = null;
  let restartingRemoteSeek = false;
  // All measurements refer to the same selected-episode click, not the start
  // of an individual fetch or decoder stage. Never log signed URLs or keys.
  let startupStages = new Set();
  const log = (event, fields = {}) => diagnostics(event, fields);
  const waitStatus = createPlaybackStatus({ render: value => { status.textContent = value; }, log });
  let metadataRead = {};
  const ageMs = () => loadStartedAt ? Math.round(performance.now() - loadStartedAt) : 0;
  function markStartupStage(stage) {
    if (!current || startupStages.has(stage) || !loadStartedAt) return;
    startupStages.add(stage);
    log('startup.stage', { phase: stage, elapsedMs: ageMs() });
    console.info('[Hongguo startup] E' + current.index + ' ' + stage + ': ' +
      Math.round(performance.now() - loadStartedAt) + 'ms');
  }
  const bvc2Mode = bvc2PlaybackMode(location.search);
  const mimeSupport = mime => video.canPlayType(mime);
  // Source selection uses a provisional HEVC probe; openClearKeyStream later
  // parses bounded hvcC metadata and checks the exact MSE SourceBuffer MIME.
  const mseSupport = mime => typeof MediaSource !== 'undefined' &&
    Boolean(MediaSource.isTypeSupported?.(mime));
  const media = createMediaSession({
    video, getSeries, sourceFor, fetchBytes, getWorkerOrigin, cache,
    selection: () => selection(),
    context: () => ({ episode: current, ready: readyForHistory, stream: nativeStream,
      startupSeconds: lastStartupSeconds, duration: video.duration,
      position: video.currentTime, paused: video.paused, seeking: video.seeking || restartingRemoteSeek }),
    savedResumeSeconds, waitForOutputCleanup: () => keyCleanup,
    mimeSupport, mseSupport, bvc2Mode, log, ageMs, markStartupStage,
    reportStartup,
    reportStage: (stage, signal, attempt, fields = {}) => {
      if (signal.aborted) return;
      if (!loading && readyForHistory && !video.paused && !video.seeking && video.readyState >= 3) waitStatus.playing();
      if (stage === 'media.request') { waitStatus.downloadAttempt(fields); return; }
      if (stage === 'media.wait') { waitStatus.mediaRead(fields.pending, fields); return; }
      if (stage === 'range.request') metadataRead = fields;
      if (['range.retry', 'range.response', 'range.progress'].includes(stage)) fields = { ...metadataRead, ...fields };
      const detailed = playbackStage(stage, fields);
      if (detailed) { waitStatus.update(detailed.layer, detailed.message, detailed.phase); return; }
      if (stage === 'first-fragment') { waitStatus.update(2, processingMessage(fields.codec) + (fields.attempt ? ' · 第 ' + fields.attempt + '/20 次' : ''), 'processing'); return; }
      if (['mse.media-appended', 'mse.done', 'seek.buffer-ready'].includes(stage)) {
        waitStatus.update(3, '正在等待影片顯示畫面…', 'frame'); return;
      }
      if (streamStages[stage]) {
        const layer = ['metadata', 'range.retry', 'media-range-retry'].includes(stage) ? 1 : 2;
        reportStartup(streamStages[stage] + (fields.attempt ? ' · 第 ' + fields.attempt + '/20 次' : ''), signal, attempt, layer, stage);
      }
    },
    onVariants: (variants, requested) => { updateRenditionOptions(variants, requested); persistPrefs(); },
    onSelection: selectRendition
  });
  video.controls = false;
  const preferences = loadPrefs(storage);
  for (const [select, value] of [
    [speedSelect, preferences.speed]
  ]) {
    if (value && Array.from(select.options).some(o => o.value === value)) select.value = value;
  }
  let pendingQuality = null;
  const selection = () => pendingQuality !== null
    ? { quality: pendingQuality, codec: 'auto' } : parseRenditionValue(qualitySelect.value);
  function selectRendition(quality, codec = 'auto') {
    const options = renditionOptions(media.variants || []);
    qualitySelect.value = matchingRenditionValue(options, { quality, codec }) || 'auto';
  }
  qualitySelect.replaceChildren(new Option('自動最佳', 'auto'));
  function persistPrefs() {
    try {
      storage.setItem(PREF_KEY, JSON.stringify({
        speed: speedSelect.value
      }));
    } catch { /* storage might be disabled */ }
  }
  persistPrefs(); // Migrate legacy stored quality/codec; only speed persists.
  function setStatus(value) { waitStatus.reset(); status.textContent = value; }
  function updateRenditionOptions(variants, requested = selection()) {
    pendingQuality = null;
    const options = renditionOptions(playableVariants(variants, mimeSupport, media.bvc2Available, mseSupport));
    let value = matchingRenditionValue(options, requested);
    qualitySelect.replaceChildren(new Option('自動最佳', 'auto'),
      ...options.map(option => new Option(option.label, option.value)));
    qualitySelect.value = value || 'auto';
    updateSettingsSummaries();
    if (!settingsMenu.hidden && settingsViews.some(view =>
      view.dataset.settingsView === 'quality' && !view.hidden)) showSettingsView('quality');
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
    directNativeProxyFallback = null;
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
  function streamPlaybackError(message) {
    return media.failure?.code?.startsWith('CENC_')
      ? Object.assign(errorWith(media.failure.code, playbackErrorSummary(media.failure)), media.failure)
      : media.decoratePlaybackError(errorWith('PLAYBACK_ERROR', message));
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
      const failed = () => { clear(); reject(streamPlaybackError(
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
  // Keep startup in 'loading' until the requested instant has media data,
  // including zero-start playback. Metadata alone does not prove readiness.
  // A delayed seeking event must not start a second Worker during this wait.
  async function waitForCencStartup(seconds, signal, stream) {
    if (!['cenc-remux', 'bvc2-transcode'].includes(stream?.kind)) return;
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
      const failed = () => finish(streamPlaybackError('CENC 首段影片載入失敗'));
      const check = () => {
        if (signal.aborted) return canceled();
        if (video.error) return failed();
        const bufferedTarget = seconds > 0.5 ? target : video.currentTime;
        if (!timeIsBuffered(video.buffered, bufferedTarget, 0.15)) return;
        // Some browsers keep currentTime at zero during MSE startup even
        // after we first assigned the target in restoreTime().
        if (seconds > 0.5 && Math.abs(video.currentTime - target) > 0.6) {
          try { video.currentTime = target; } catch { /* retry on canplay */ }
        }
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            (seconds <= 0.5 || Math.abs(video.currentTime - target) <= 0.6)) finish();
      };
      const timeout = setTimeout(() =>
        finish(errorWith('PLAYBACK_TIMEOUT', 'CENC 首段影片未在時限內準備完成')),
      SESSION_TIMEOUT);
      for (const event of events) video.addEventListener(event, check);
      video.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', canceled, { once: true });
      check();
    });
  }
  const streamStages = {
    metadata: '正在讀取影片播放資訊…',
    'remux-check': '正在檢查增量串流支援…',
    'eme-access': '正在檢查瀏覽器串流解密支援…',
    'eme-session': '正在初始化串流解密…',
    'wasm-download': '正在載入增量串流工具…',
    'wasm-verify': '正在驗證串流工具…',
    'wasm-start': '正在初始化串流工具…',
    'first-fragment': '正在解密、解碼或轉碼影片…',
    'range.retry': '正在重新讀取影片播放資訊…',
    'media-range-retry': '影片下載暫時失敗，正在重試…'
  };
  function reportStartup(message, signal, attempt = 0, layer = 3, phase = 'prepare') {
    if (!signal.aborted) waitStatus.update(layer, message, phase);
  }
  async function load(episode, currentToken, signal, autoPlay, handoff = null) {
    const { resolved, prepared, attempt } = await media.request(episode, signal, handoff);
    if (signal.aborted || currentToken !== token) return;
    sourceInfo.textContent = printableSource(resolved.source) || '來源資訊不完整';
    if (resolved.fallbackNotice) sourceInfo.textContent += ' · ' + resolved.fallbackNotice;
    log('playback.media.selected', {
      codec: codecId(resolved.source?.codec) || 'unknown',
      path: resolved.native?.kind || (resolved.fullFileFallback ? 'whole-file' : 'direct'),
      elapsedMs: ageMs()
    });
    if (resolved.native) sourceInfo.textContent +=
      resolved.native.kind === 'bvc2-transcode' ? ' · ByteVC2 → H.264 增量轉碼（MSE，實驗性）'
      : resolved.native.kind === 'cenc-remux' ? ' · 增量解密轉封裝（MSE）'
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
    directNativeProxyFallback = resolved.directProxyFallback || null;
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
    video.style.objectFit = 'contain';
    const presentationAttempt = media.beginPlayback();
    video.load();
    log('presentation.attempt', { attempt: presentationAttempt });
    video.playbackRate = selectedRate;
    reportStartup(resolved.fullFileFallback
      ? '整集下載備援處理完成，正在開啟影片…'
      : '正在等待影片資訊與首段緩衝…', signal, attempt);
    try {
      await waitMetadata(signal);
    } catch (error) {
      if (!directNativeProxyFallback || signal.aborted) throw error;
      log('media.transport.fallback', { reason: 'native-metadata-failed' });
      video.src = directNativeProxyFallback;
      directNativeProxyFallback = null;
      video.load();
      await waitMetadata(signal);
    }
    markStartupStage('loadedmetadata');
    log('playback.metadata', {
      duration: video.duration, width: video.videoWidth, height: video.videoHeight,
      readyState: video.readyState, elapsedMs: ageMs()
    });
    if (signal.aborted || currentToken !== token) return;
    const wanted = savedResumeSeconds(episode);
    if (wanted > 0.5) reportStartup('正在恢復觀看進度…', signal, attempt);
    await restoreTime(wanted, signal);
    await waitForCencStartup(wanted, signal, resolved.native);
    if (signal.aborted || currentToken !== token) return;
    restoredTime = wanted;
    readyForHistory = true;
    loading = false;
    recoveryStart = video.currentTime;
    lastStartupSeconds = Math.max(0, (performance.now() - loadStartedAt) / 1000);
    console.info('[Hongguo playback] E' + episode.index + ' 可開始播放：' +
      Math.round(lastStartupSeconds * 1000) + 'ms' + (prepared ? '（使用預取）' : ''));
    log('playback.ready', { elapsedMs: ageMs(), resumed: wanted > 0 });
    setStatus(resolved.fallbackNotice || (wanted > 0 ? '已續播' : ''));
    onProgress?.();
    if (autoPlay) {
      try { await video.play(); }
      catch (error) {
        if (error.name === 'NotAllowedError') setStatus('點選影片即可開始播放');
        else throw streamPlaybackError(error.message || '無法播放此片源');
      }
    }
  }
  async function waitForRetry(state, error, signal, currentToken) {
    const until = Date.now() + state.delay;
    await new Promise(resolve => {
      let timer;
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const tick = () => {
        if (signal.aborted || currentToken !== token) return finish();
        const remaining = Math.max(0, until - Date.now());
        if (!remaining) return finish();
        setStatus(playbackFailureMessage({ ...state, delay: remaining }, error, 20));
        timer = setTimeout(tick, Math.min(1000, remaining));
      };
      signal.addEventListener('abort', finish, { once: true }); tick();
    });
  }
  async function run(episode, currentToken, signal, autoPlay, previous = null, handoff = null) {
    let errors = previous;
    while (!signal.aborted && currentToken === token) {
      try { await load(episode, currentToken, signal, autoPlay, handoff); return; }
      catch (error) {
        if (signal.aborted || currentToken !== token) return;
        const parsed = classifyError(error.retryStep ? error : media.decoratePlaybackError(error));
        log('playback.attempt.failed', {
          code: parsed.code || 'UNKNOWN', attempt: media.attempt, elapsedMs: ageMs(),
          stage: parsed.stage || 'media', status: parsed.status
        });
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
        // A CDN may deny or stall one HEVC candidate while another official
        // source at the same resolution still returns usable media.
        // Limit retries to distinct candidates at the SAME quality and codec;
        // never broaden to ByteVC2, lower quality, or unlimited 403 retries.
        if ((parsed.stepAttempt || 0) < 20 && media.canRetrySource(parsed.code, episode)) {
          log('playback.cdn.rotate', { attempt: media.attempt, elapsedMs: ageMs() });
          setStatus('目前媒體來源無法使用，嘗試同畫質／編碼其他候選來源…');
          continue;
        }
        if (['CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED'].includes(parsed.code)) media.retryAfterRateLimit();
        errors = recordFailure(errors, parsed, 20, 20, { retryForbidden: true, retryRateLimited: true });
        failure = errors;
        setStatus(playbackFailureMessage(errors, parsed, 20));
        if (!errors.retry) {
          log('playback.retry.stopped', { code: parsed.code || 'UNKNOWN' });
          loading = false;
          return;
        }
        log('playback.retry.scheduled', {
          attempt: media.attempt, delayMs: errors.delay, code: parsed.code || 'UNKNOWN'
        });
        await waitForRetry(errors, parsed, signal, currentToken);
      }
    }
  }
  function open(episode, autoPlay = true, keepSettings = false) {
    // Mode activation already opens its suggested episode. A repeated click
    // must not cancel/restart that selection, even if it became ready while
    // the pointer action was settling. Settings changes explicitly restart.
    if (current?.vid === episode.vid && controller && !controller.signal.aborted && !keepSettings &&
        (loading || readyForHistory && !failure && !media.failure && !video.error &&
          !video.ended && video.getAttribute('src'))) {
      if (!loading && autoPlay && video.paused) {
        try { void Promise.resolve(video.play()).catch(() => {}); } catch { /* controls can resume */ }
      }
      return;
    }
    if (current?.vid !== episode.vid) {
      const quality = selection().quality;
      qualitySelect.replaceChildren(new Option('自動最佳', 'auto'));
      pendingQuality = quality;
    }
    if (!episode) return;
    const handoff = media.takePrefetch(episode);
    savePosition();
    disposeSource();
    current = episode;
    failure = null;
    media.begin(episode);
    log('playback.open', {
      episode: Number(episode.index) || 0, quality: selection().quality,
      codec: selection().codec, resumeSeconds: savedResumeSeconds(episode)
    });
    refreshButtons();
    label.textContent = '第 ' + episode.index + ' 集';
    sourceInfo.textContent = '';
    if (!keepSettings) showSettings(false);
    const signal = (controller = new AbortController()).signal;
    loading = true; // Source discovery and WASM preparation are part of loading too.
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
  // Passive media telemetry: no source URLs, samples, keys, or media payloads.
  const mediaSnapshot = () => {
    let bufferedEnd = 0;
    try {
      const n = video.buffered?.length || 0;
      if (n) bufferedEnd = video.buffered.end(n - 1);
    } catch { /* switching MediaSource */ }
    const raw = nativeStream?.snapshot?.() || {};
    return {
      rawCachedBytes: raw.cachedBytes, rawComplete: raw.complete, requests: raw.requests,
      time: video.currentTime, bufferedEnd, bufferedRanges: bufferedIntervals(video.buffered),
      ...bufferedAround(video.buffered, video.currentTime), readyState: video.readyState,
      networkState: video.networkState,
      frames: video.getVideoPlaybackQuality?.().totalVideoFrames || 0
    };
  };
  let seekMeasurement = null;
  for (const eventName of ['loadstart', 'loadedmetadata', 'loadeddata',
    'playing', 'waiting', 'stalled', 'suspend', 'seeking', 'seeked',
    'error', 'ended', 'emptied']) {
    video.addEventListener(eventName, () => {
      if (!current) return;
      if (eventName === 'playing') waitStatus.playing();
      if (['waiting', 'stalled'].includes(eventName) && readyForHistory && !loading) waitStatus.waiting();
      log('media.' + eventName, {
        ...mediaSnapshot(), elapsedMs: ageMs(),
        ...(eventName === 'error' ? { errorCode: video.error?.code || 0 } : {})
      });
      if (eventName === 'seeked' && seekMeasurement) {
        log('media.seek.complete', { target: seekMeasurement.target,
          seekMs: performance.now() - seekMeasurement.started, ...mediaSnapshot() });
        seekMeasurement = null;
      }
    });
  }
  let lastMediaSnapshotAt = 0;
  video.addEventListener('canplay', () => markStartupStage('canplay'));
  video.addEventListener('timeupdate', () => {
    if (!current || !readyForHistory) return;
    const now = performance.now();
    if (now - lastMediaSnapshotAt >= 5000) {
      lastMediaSnapshotAt = now;
      log('media.progress', { ...mediaSnapshot(), elapsedMs: ageMs() });
    }
  });
  video.addEventListener('timeupdate', () => {
    if (!current || !readyForHistory || !Number.isFinite(video.currentTime)) return;
    media.updateContext();
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
    if (target === null) return;
    if (timeIsBuffered(video.buffered, target)) {
      log('media.seek.buffered', { target, ...mediaSnapshot(), elapsedMs: ageMs() });
      return;
    }
    const seekToken = token, signal = controller.signal, oldStream = nativeStream;
    const wasPlaying = !video.paused;
    restartingRemoteSeek = true;
    readyForHistory = false; // Never overwrite saved position with temporary t=0.
    loading = true;
    const seekStarted = performance.now();
    log('media.remote-seek', { target, ...mediaSnapshot(), elapsedMs: ageMs() });
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
        if (!nextStream.inPlaceSeek) {
          video.src = nextStream.url;
          video.load();
        }
        video.playbackRate = rate;
        await waitMetadata(signal);
        if (signal.aborted || seekToken !== token) return;
        await restoreTime(target, signal);
        if (signal.aborted || seekToken !== token) return;
        restoredTime = target;
        readyForHistory = true;
        loading = false;
        savePosition();
        log('media.remote-seek.ready', { target, ...mediaSnapshot(),
          seekMs: performance.now() - seekStarted, workerReused: Boolean(nextStream.inPlaceSeek), elapsedMs: ageMs() });
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
          log('media.remote-seek.failed', { code: error?.code || 'UNKNOWN', elapsedMs: ageMs() });
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
    media.updateContext();
  });
  video.addEventListener('ended', () => {
    if (!current || !readyForHistory) return;
    savePosition(true);
    const index = ordered().findIndex(ep => ep.vid === current.vid);
    const next = ordered()[index + 1];
    if (next) open(next);
    else setStatus('播放完成');
  });
  video.addEventListener('error', () => {
    if (!current || loading || !controller || controller.signal.aborted) return;
    if (directNativeProxyFallback) {
      const proxyUrl = directNativeProxyFallback;
      directNativeProxyFallback = null;
      const resume = video.currentTime, wasPlaying = !video.paused;
      log('media.transport.fallback', { reason: 'native-playback-failed' });
      setStatus('CDN 直連中斷，改由代理接續影片…');
      video.src = proxyUrl;
      video.load();
      video.addEventListener('loadedmetadata', () => {
        if (resume > 0 && Number.isFinite(video.duration))
          video.currentTime = Math.min(resume, Math.max(0, video.duration - 0.1));
        if (wasPlaying) void video.play().catch(() => {});
      }, { once: true });
      return;
    }
    const currentToken = token, signal = controller.signal;
    if (nativeStream) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      disposeNativeKeys();
    }
    // endOfStream('decode') maps even an upstream 403/429 to MediaError 3.
    // Use the sanitized Worker classification for correct retry policy.
    const transport = media.takeFailure();
    const knownCodes = [
      'CENC_SOURCE_FORBIDDEN', 'CENC_RATE_LIMITED', 'CENC_RANGE_INVALID',
      'CENC_RANGE_UNSUPPORTED', 'CENC_RANGE_HTTP', 'CENC_RANGE_TIMEOUT', 'CENC_SOURCE_SLOW', 'CENC_REMUX_FAILED'
    ];
    const parsed = transport && knownCodes.includes(transport.code)
      ? { ...transport, message: playbackErrorSummary(transport) }
      : media.decoratePlaybackError({ code: 'PLAYBACK_ERROR', message: '影片解碼或串流中斷' });
    log('media.error.cause', {
      code: parsed.code, status: transport?.status || 0, elapsedMs: ageMs()
    });
    if (['CENC_RATE_LIMITED', 'MEDIA_RATE_LIMITED'].includes(parsed.code)) media.retryAfterRateLimit();
    failure = recordFailure(failure, parsed, 20, 20, { retryForbidden: true, retryRateLimited: true });
    log('media.error.recovery', {
      code: parsed.code, retries: failure.attempts, enabled: failure.retry
    });
    setStatus(playbackFailureMessage(failure, parsed, 20));
    if (!failure.retry) return;
    const prior = failure;
    void waitForRetry(prior, parsed, signal, currentToken).then(() => {
      if (currentToken === token && !signal.aborted) void run(current, currentToken, signal, true, prior);
    });
  });
  // Two-level Video.js settings, only video quality and playback rate.
  // The native selects remain the single source of truth for stored preferences.
  const settingsStage = video.closest?.('media-container');
  const settingsViews = [...(settingsMenu.querySelectorAll?.('[data-settings-view]') || [])];
  const backButton = settingsMenu.querySelector?.('#player-settings-back');
  const settingsHeading = settingsMenu.querySelector?.('#player-settings-heading');
  function updateSettingsSummaries() {
    if (!settingsViews.length) return; // Test stubs do not implement DOM queries.
    settingsMenu.querySelector('#player-quality-summary').textContent =
      qualitySelect.selectedOptions[0]?.textContent || '自動最佳';
    settingsMenu.querySelector('#player-speed-summary').textContent =
      speedSelect.selectedOptions[0]?.textContent || '1×';
  }
  function showSettingsView(view = 'root') {
    if (!settingsViews.length) return;
    for (const element of settingsViews) element.hidden = element.dataset.settingsView !== view;
    backButton.hidden = view === 'root';
    settingsHeading.textContent = view === 'quality' ? '畫質' :
      view === 'speed' ? '播放速度' : '播放設定';
    updateSettingsSummaries();
    if (view === 'root') return;
    const select = view === 'quality' ? qualitySelect : speedSelect;
    const list = settingsMenu.querySelector(view === 'quality' ?
      '#player-quality-options' : '#player-speed-options');
    list.replaceChildren(...Array.from(select.options).map(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'player-settings-choice';
      button.dataset.choiceFor = view;
      button.dataset.choiceValue = option.value;
      button.setAttribute('aria-pressed', String(option.value === select.value));
      button.textContent = option.textContent;
      if (option.value === select.value) {
        const mark = document.createElement('span');
        mark.textContent = '✓';
        mark.className = 'player-choice-check';
        mark.setAttribute('aria-hidden', 'true');
        button.append(mark);
      }
      return button;
    }));
  }
  function showSettings(visible) {
    if (visible) showSettingsView('root');
    settingsMenu.hidden = !visible;
    if (settingsStage?.dataset) settingsStage.dataset.settingsOpen = String(visible);
    settingsToggle.setAttribute('aria-expanded', String(visible));
  }
  settingsToggle.addEventListener('click', () => showSettings(settingsMenu.hidden));
  settingsClose.addEventListener('click', () => showSettings(false));
  settingsMenu.addEventListener('click', event => {
    const target = event.target?.closest?.('button[data-settings-target], button[data-choice-for]');
    if (!target) return;
    if (target.dataset.settingsTarget) {
      showSettingsView(target.dataset.settingsTarget);
      return;
    }
    const select = target.dataset.choiceFor === 'quality' ? qualitySelect : speedSelect;
    if (select.value !== target.dataset.choiceValue) {
      select.value = target.dataset.choiceValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    showSettingsView('root');
  });
  document.addEventListener('pointerdown', event => {
    if (!settingsMenu.hidden && !settingsMenu.contains(event.target) &&
        !settingsToggle.contains(event.target)) showSettings(false);
  });
  prevButton.addEventListener('click', () => step(-1));
  nextButton.addEventListener('click', () => step(1));
  qualitySelect.addEventListener('change', () => {
    pendingQuality = null;
    if (media.variants) updateRenditionOptions(media.variants);
    persistPrefs();
    updateSettingsSummaries();
    if (current) open(current, true, true);
  });
  speedSelect.addEventListener('change', () => {
    const rate = Number(speedSelect.value) || 1;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    persistPrefs();
    updateSettingsSummaries();
  });
  video.style.objectFit = 'contain';
  updateSettingsSummaries();
  // pagehide also fires when a document enters the back/forward cache.
  // Explicitly abort the active Range/Worker before suspension, rather than
  // relying on the browser to tear down a still-live CENC remux.
  let resumeAfterPageShow = false;
  window.addEventListener('pagehide', () => {
    savePosition();
    media.cancelPrefetch();
    resumeAfterPageShow = Boolean(current && controller && !controller.signal.aborted);
    if (resumeAfterPageShow) {
      disposeSource();
      token++; // invalidate late callbacks from the removed media source
    }
    media.releaseEngines();
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
      media.cancelPrefetch();
      savePosition(); current = null; disposeSource(); token++;
      media.releaseEngines();
      media.clear();
      pendingQuality = null;
      qualitySelect.replaceChildren(new Option('自動最佳', 'auto'));
      updateSettingsSummaries(); showSettings(false);
      label.textContent = '尚未播放'; refreshButtons();
    },
    pause() { if (readyForHistory) savePosition(); video.pause(); },
    deactivate() {
      // Leaving the playback mode is not an ordinary pause: relinquish all
      // Range fetches, remux workers, MSE buffers and pending prefetch.
      // Keep current episode + history so returning to playback can resume.
      media.cancelPrefetch();
      savePosition();
      if (current) { disposeSource(); token++; }
      media.releaseEngines();
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
