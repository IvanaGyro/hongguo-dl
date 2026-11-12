// Native HTML video player. Quality/codec/playspeed/fit/next/PiP controls
// live inside the video surface. Only the *current episode* is active.
// Both progress recording and restoration are guarded against the common
// reload race: a 0-second metadata load must never erase a saved position.
import { errorWith, classifyError, isHlsUrl, mediaProxyUrl } from './logic.js';
import { watchRecords, playbackKey, rememberPlayback, suggestedEpisode } from './library.js';
import { episodeCacheKey } from './media-cache.js';
import { recordFailure, playbackFailureMessage } from './retry.js';
import { convertBytes, convertHls } from './ffmpeg.js';
import { availableRenditions, renditionForAttempt, codecId } from './source-options.js';

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
  async function sourceForEpisode(episode, signal, attempt = 0) {
    const series = getSeries();
    const quality = qualitySelect.value, codec = codecSelect.value;
    const key = episodeCacheKey(series?.seriesId, episode.vid, quality, codec);
    const blob = attempt === 0 ? cache.get(key) : null;
    if (blob) return { blob, source: { codec, quality, source: 'cache' } };
    // Ask the Worker for all available variants once. Filtering inside the
    // player supports source-specific renditions (e.g. 540p/480p/360p) instead
    // of claiming every episode has the same quality/codec options.
    const list = episode.vid === 'direct'
      ? { variants: [{ url: episode.url, source: 'web', codec: 'unknown', contentKey: null }] }
      : await sourceFor(series.seriesId, episode.vid, 'auto', 'auto');
    const variants = list.variants || [];
    const available = availableRenditions(variants);
    for (const option of qualitySelect.options) {
      if (option.value !== 'auto')
        option.disabled = available.qualities.length > 0 &&
          !available.qualities.includes(option.value);
    }
    for (const option of codecSelect.options) {
      if (option.value !== 'auto')
        option.disabled = available.codecs.length > 0 &&
          !available.codecs.includes(option.value);
    }
    // Rotate through the advertised CDNs on retry rather than repeatedly
    // fetching a failing signed URL from one upstream edge.
    const source = renditionForAttempt(variants, { quality, codec }, attempt);
    if (!source?.url) throw errorWith('SOURCE_UNAVAILABLE',
      '此集沒有選擇的畫質／編碼，請改為自動或其他可用選項');
    const profile = source.source === 'app' ? 'app' : 'web';
    if (!isHlsUrl(source.url) && !source.contentKey)
      return { url: mediaProxyUrl(source.url, profile, getWorkerOrigin()), source };
    let bytes;
    if (isHlsUrl(source.url)) {
      setStatus('準備串流中…');
      bytes = await convertHls(source.url, {
        mode: 'copy', contentKey: source.contentKey, signal,
        fetchBytes: (uri, sig, max) => fetchBytes(uri, profile, sig, max),
        segmentProgress: x => setStatus('準備串流 ' + x.current + '/' + x.total)
      });
    } else {
      setStatus('解密並封裝影片…');
      const raw = await fetchBytes(source.url, profile, signal, 260 * 1024 * 1024);
      bytes = await convertBytes(raw, { mode: 'copy', contentKey: source.contentKey, signal });
    }
    if (!bytes?.length) throw errorWith('EMPTY_MEDIA', '來源沒有媒體資料');
    const result = new Blob([bytes], { type: 'video/mp4' });
    cache.put(key, result);
    return { blob: result, source };
  }
  async function load(episode, currentToken, signal, autoPlay) {
    const resolved = await sourceForEpisode(episode, signal, sourceAttempt++);
    if (signal.aborted || currentToken !== token) return;
    sourceInfo.textContent = printableSource(resolved.source) || '來源資訊不完整';
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
    setStatus('第 ' + episode.index + ' 集' + (wanted > 0 ? ' · 已續播' : ''));
    onProgress?.();
    if (autoPlay) {
      try { await video.play(); }
      catch (error) {
        if (error.name === 'NotAllowedError') setStatus('點選影片即可開始播放');
        else throw errorWith('PLAYBACK_ERROR', error.message || '無法播放此片源');
      }
    }
  }
  async function run(episode, currentToken, signal, autoPlay, previous = null) {
    let errors = previous;
    while (!signal.aborted && currentToken === token) {
      try { await load(episode, currentToken, signal, autoPlay); return; }
      catch (error) {
        const parsed = classifyError(error);
        if (signal.aborted || currentToken !== token || parsed.code === 'CANCELED') return;
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
  function open(episode, autoPlay = true) {
    if (!episode) return;
    savePosition();
    disposeSource();
    current = episode;
    failure = null;
    sourceAttempt = 0;
    refreshButtons();
    label.textContent = '第 ' + episode.index + ' 集';
    sourceInfo.textContent = '';
    const signal = (controller = new AbortController()).signal;
    const currentToken = ++token;
    setStatus('載入第 ' + episode.index + ' 集…');
    void run(episode, currentToken, signal, autoPlay);
    onProgress?.();
  }
  function step(direction) {
    const list = ordered(), index = list.findIndex(ep => ep.vid === current?.vid);
    if (list[index + direction]) open(list[index + direction]);
  }
  video.addEventListener('timeupdate', () => {
    if (!current || !readyForHistory || !Number.isFinite(video.currentTime)) return;
    const now = Date.now();
    if (failure && video.currentTime - recoveryStart > 5) failure = null;
    if (now - lastUiPaint > 950) { lastUiPaint = now; onProgress?.(); }
    if (now - lastSaved > 1800) { lastSaved = now; savePosition(); }
  });
  video.addEventListener('seeked', () => { if (readyForHistory) savePosition(); });
  video.addEventListener('pause', () => { if (readyForHistory && !video.ended) savePosition(); });
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
  for (const selector of [qualitySelect, codecSelect]) {
    selector.addEventListener('change', () => {
      persistPrefs();
      if (current) open(current);
    });
  }
  speedSelect.addEventListener('change', () => { video.playbackRate = Number(speedSelect.value) || 1; persistPrefs(); });
  fitSelect.addEventListener('change', () => { video.style.objectFit = fitSelect.value; persistPrefs(); });
  autoNextInput.addEventListener('change', persistPrefs);
  video.style.objectFit = fitSelect.value;
  if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
    pipButton.hidden = false;
    pipButton.addEventListener('click', () => {
      video.requestPictureInPicture().catch(() => setStatus('目前無法啟用子母畫面'));
    });
  }
  window.addEventListener('pagehide', () => savePosition());
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
  refreshButtons();
  return {
    open, current: () => current,
    resume() {
      const series = getSeries();
      if (series) open(suggestedEpisode(series, watchRecords(storage)));
    },
    stop() {
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
