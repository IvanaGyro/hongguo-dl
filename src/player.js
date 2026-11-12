// Video.js 10 controls with a native <video> media element.
// Source resolution, encryption, resume and episode navigation stay app-owned.
// Only the current episode is active.
// Both progress recording and restoration are guarded against the common
// reload race: a 0-second metadata load must never erase a saved position.
import { errorWith, classifyError, isHlsUrl, mediaProxyUrl } from './logic.js';
import { watchRecords, playbackKey, rememberPlayback, suggestedEpisode } from './library.js';
import { episodeCacheKey } from './media-cache.js';
import { recordFailure, playbackFailureMessage } from './retry.js';
import { convertBytes, convertHls, prepareFfmpeg } from './ffmpeg.js';
import { availableRenditions, codecsAtQuality, playbackRendition, codecId, qualityId } from './source-options.js';
import { nextEpisode, shouldPrefetchNext } from './player-prefetch.js';

const PREF_KEY = 'hongguo-dl-player-preferences-v1';
const SESSION_TIMEOUT = 25000;
function loadPrefs(storage) {
  try { return JSON.parse(storage.getItem(PREF_KEY) || '{}') || {}; }
  catch { return {}; }
}
function printableSource(source) {
  const names = { h264: 'H.264', hevc: 'HEVC', bytevc2: 'ByteVC2' };
  return [
    names[source.codec] || source.codec || '',
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
  const mimeSupport = mime => video.canPlayType(mime);
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
          !(atQuality.length ? atQuality : available.codecs).includes(option.value);
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
          candidates.every(v => codecId(v.codec) === 'bytevc2' && v.contentKey)
            ? '（VVC，無法解密播放）' : '');
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
  function disposeSource() {
    controller?.abort();
    controller = null;
    readyForHistory = false;
    loading = false;
    video.pause();
    video.removeAttribute('src');
    video.load();
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
  async function sourceForEpisode(episode, signal, attempt = 0, options = {}) {
    const series = getSeries();
    const quality = options.quality ?? qualitySelect.value;
    const codec = options.codec ?? codecSelect.value;
    const quiet = !!options.quiet;
    const seriesId = options.seriesId ?? series?.seriesId;
    const key = episodeCacheKey(seriesId, episode.vid, quality, codec);
    const entry = attempt === 0 ? cache.getEntry(key) : null;
    if (entry?.blob) return { blob: entry.blob,
      source: entry.source || { codec, quality, source: 'cache' } };
    // Keep a short-lived source list to rotate through alternate CDNs on
    // retry without another upstream API call. Refresh on the next cycle.
    const sameList = !quiet && lastVariants && lastVariantsVid === episode.vid &&
      Date.now() - lastVariantsAt < 30000;
    const list = episode.vid === 'direct'
      ? { variants: [{ url: episode.url, source: 'web', codec: 'unknown', contentKey: null }] }
      : sameList && attempt > 0 && attempt < lastVariants.length
        ? { variants: lastVariants }
        : await sourceFor(seriesId, episode.vid, 'auto', 'auto', signal);
    if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
    const variants = list.variants || [];
    if (!quiet) {
      lastVariants = variants;
      lastVariantsVid = episode.vid;
      lastVariantsAt = Date.now();
      updateCodecOptions(variants);
    }
    // A fixed tier is not a fixed codec: Nova's 720p is encrypted VVC, not
    // HEVC. Reject it before spending bandwidth and CPU on doomed FFmpeg work.
    const resolved = playbackRendition(variants,
      { quality, codec }, mimeSupport, attempt);
    const source = resolved.source;
    if (!source?.url) {
      const tiers = availableRenditions(variants);
      const offered = tiers.qualities.map(q =>
        q + '：' + codecsAtQuality(variants, q).map(c => CODEC_NAMES[c] || c).join('/')).join('、');
      throw errorWith('PLAYBACK_UNSUPPORTED',
        '所選 ' + (quality === 'auto' ? '自動畫質' : quality) +
        ' 沒有可播放的編碼；可用來源：' + (offered || '未知') +
        '。加密 VVC 無法由目前的 FFmpeg.wasm 解密封裝，HEVC 也需要瀏覽器支援。');
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
    if (!isHlsUrl(source.url) && !source.contentKey)
      return { url: mediaProxyUrl(source.url, profile, getWorkerOrigin()),
        source, fallbackNotice, variants: quiet ? variants : null };
    let bytes;
    if (isHlsUrl(source.url)) {
      if (!quiet) setStatus('準備串流中…');
      bytes = await convertHls(source.url, {
        mode: 'copy', contentKey: source.contentKey, signal,
        fetchBytes: (uri, sig, max) => fetchBytes(uri, profile, sig, max),
        segmentProgress: x => { if (!quiet) setStatus('準備串流 ' + x.current + '/' + x.total); }
      });
    } else {
      // Encrypted MP4s still require the complete source before decryption.
      // Initialize FFmpeg after the first media chunk, in parallel with the
      // remaining download, so the initial startup stages do not run serially.
      let warmup = null, received = 0, lastUpdate = 0;
      if (!quiet) setStatus('載入影片…');
      const raw = await fetchBytes(source.url, profile, signal,
        quiet ? Math.min(cache.limit, 32 * 1024 * 1024) : 260 * 1024 * 1024,
        (length, total) => {
          if (!warmup) warmup = prepareFfmpeg(signal).then(() => null, error => error);
          received += length;
          const now = Date.now();
          if (!quiet && now - lastUpdate > 250) {
            lastUpdate = now;
            setStatus(total ? '載入影片 ' + Math.min(100, Math.round(100 * received / total)) + '%'
              : '載入影片…');
          }
        });
      const warmupError = await (warmup || prepareFfmpeg(signal).then(() => null, error => error));
      if (warmupError) throw warmupError;
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (!quiet) setStatus('解密並封裝影片…');
      bytes = await convertBytes(raw, { mode: 'copy', contentKey: source.contentKey, signal });
    }
    if (!bytes?.length) throw errorWith('EMPTY_MEDIA', '來源沒有媒體資料');
    const result = new Blob([bytes], { type: 'video/mp4' });
    if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
    cache.put(key, result, source);
    return { blob: result, source, fallbackNotice, variants: quiet ? variants : null };
  }
  async function load(episode, currentToken, signal, autoPlay, handoff = null) {
    const attempt = sourceAttempt++;
    // If the incoming episode is already being downloaded/decrypted, consume
    // that one promise rather than issuing a second expensive media request.
    const prepared = handoff && attempt === 0 ? await handoff.promise : null;
    const resolved = prepared || await sourceForEpisode(episode, signal, attempt);
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
    const containerCodec = codecId(resolved.source?.codec);
    const decoder = containerCodec === 'hevc'
      ? 'video/mp4; codecs="hvc1"' : containerCodec === 'bytevc2'
      ? 'video/mp4; codecs="vvc1"' : 'video/mp4; codecs="avc1.42E01E"';
    if (containerCodec && video.canPlayType(decoder) === '')
      sourceInfo.textContent += ' · 此編碼可能無法在本瀏覽器播放';
    if (activeUrl) URL.revokeObjectURL(activeUrl);
    activeUrl = resolved.blob ? URL.createObjectURL(resolved.blob) : null;
    loading = true;
    video.src = activeUrl || resolved.url;
    video.playbackRate = Number(speedSelect.value) || 1;
    video.style.objectFit = fitSelect.value;
    video.load();
    await waitMetadata(signal);
    if (signal.aborted || currentToken !== token) return;
    const old = watchRecords(storage)[playbackKey(getSeries()?.seriesId, episode.vid)];
    const wanted = !old?.completed && old?.seconds > 0.5 ? old.seconds : 0;
    await restoreTime(wanted, signal);
    if (signal.aborted || currentToken !== token) return;
    restoredTime = wanted;
    readyForHistory = true;
    loading = false;
    recoveryStart = video.currentTime;
    lastStartupSeconds = Math.max(0, (performance.now() - loadStartedAt) / 1000);
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
        if (signal.aborted || currentToken !== token || parsed.code === 'CANCELED') return;
        if (parsed.code === 'PLAYBACK_UNSUPPORTED') {
          loading = false;
          setStatus('無法播放 · ' + parsed.message);
          return;
        }
        errors = recordFailure(errors, parsed, 5);
        failure = errors;
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
      quiet: true, quality, codec, seriesId
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
    if (handoff) signal.addEventListener('abort', () => handoff.controller.abort(), { once: true });
    setStatus('載入中…');
    void run(episode, currentToken, signal, autoPlay, null, handoff);
    onProgress?.();
  }
  function step(direction) {
    const list = ordered(), index = list.findIndex(ep => ep.vid === current?.vid);
    if (list[index + direction]) open(list[index + direction]);
  }
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
    const parsed = { code: 'PLAYBACK_ERROR', message: video.error?.message || '播放中斷' };
    failure = recordFailure(failure, parsed, 5);
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
  speedSelect.addEventListener('change', () => { video.playbackRate = Number(speedSelect.value) || 1; persistPrefs(); });
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
  window.addEventListener('pagehide', () => { savePosition(); cancelPrefetch(); });
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
    activate() {
      // Selecting play mode opens the episode suggested by history once.
      // Do not force an unwanted autoplay on repeated tab switches.
      if (!current) this.resume();
    },
    refresh: refreshButtons
  };
}
