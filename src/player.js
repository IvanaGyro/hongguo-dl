// Native HTML5 playback with persisted per-episode resume, selectable source
// quality/codec, consecutive-error retries and automatic next episode.
// Firefox does not universally support native HLS, so this module falls back
// to local FFmpeg.wasm remux for supported on-demand HLS sources.
import { errorWith, classifyError, isHlsUrl, mediaProxyUrl } from './logic.js';
import { watchRecords, playbackKey, rememberPlayback, suggestedEpisode } from './library.js';
import { episodeCacheKey } from './media-cache.js';
import { recordFailure } from './retry.js';
import { convertBytes, convertHls } from './ffmpeg.js';

export function createPlayer({
  video, status, label, prevButton, nextButton, qualitySelect, codecSelect,
  getSeries, sourceFor, fetchBytes, getWorkerOrigin, cache, storage, onProgress
}) {
  let current = null, controller = null, lastSaved = 0, playToken = 0;
  let activeBlobUrl = null, loading = false, failure = null;
  function setStatus(text) { status.textContent = text; }
  function episodes() {
    return [...(getSeries()?.episodes || [])].sort((a, b) => Number(a.index) - Number(b.index));
  }
  function savePosition(completed = false) {
    if (!current || !Number.isFinite(video.currentTime)) return;
    rememberPlayback(storage, getSeries()?.seriesId, current.vid,
      video.currentTime, video.duration, completed);
    onProgress?.();
  }
  function clearSource() {
    if (controller) { controller.abort(); controller = null; }
    if (loading) { video.pause(); video.removeAttribute('src'); video.load(); }
    else video.pause();
    if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }
  }
  function buttons() {
    const list = episodes(), at = list.findIndex(ep => ep.vid === current?.vid);
    prevButton.disabled = at <= 0;
    nextButton.disabled = at < 0 || at >= list.length - 1;
  }
  async function waitMetadata(signal) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', succeed);
        video.removeEventListener('error', fail);
        signal.removeEventListener('abort', abort);
      };
      const succeed = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(errorWith('PLAYBACK_ERROR',
        video.error?.message || '瀏覽器無法解碼此影片')); };
      const abort = () => { cleanup(); reject(errorWith('CANCELED', '已切換播放內容')); };
      timer = setTimeout(() => { cleanup(); reject(errorWith('PLAYBACK_TIMEOUT', '影片載入逾時')); }, 25000);
      video.addEventListener('loadedmetadata', succeed, { once: true });
      video.addEventListener('error', fail, { once: true });
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function resolveSource(ep, signal) {
    const series = getSeries();
    const quality = qualitySelect.value, codec = codecSelect.value;
    const key = episodeCacheKey(series?.seriesId, ep.vid, quality, codec);
    const cached = cache.get(key);
    if (cached) return { blob: cached };
    const variants = ep.vid === 'direct'
      ? { variants: [{ url: ep.url, source: 'web', codec: 'unknown', contentKey: null }] }
      : await sourceFor(series.seriesId, ep.vid, quality, codec);
    const source = variants.variants?.[0];
    if (!source?.url) throw errorWith('SOURCE_UNAVAILABLE', '找不到此集可播放的來源');
    const profile = source.source === 'app' ? 'app' : 'web';
    const hls = isHlsUrl(source.url);
    // Direct progressive streams use the browser's HTTP Range buffer and
    // require no large JS allocation. That browser-managed buffer is private
    // and cannot automatically be reused by a separate download operation.
    if (!hls && !source.contentKey)
      return { url: mediaProxyUrl(source.url, profile, getWorkerOrigin()) };
    setStatus(hls ? '正在準備 HLS 分片；Firefox 需先無損封裝才可播放…'
      : '正在解密媒體並準備播放…');
    let bytes;
    if (hls) {
      bytes = await convertHls(source.url, {
        mode: 'copy', contentKey: source.contentKey, signal,
        fetchBytes: (uri, s, max) => fetchBytes(uri, profile, s, max),
        segmentProgress: x => setStatus('準備 HLS：' + x.current + ' / ' + x.total + ' 分片')
      });
    } else {
      const raw = await fetchBytes(source.url, profile, signal, 260 * 1024 * 1024);
      bytes = await convertBytes(raw, { mode: 'copy', contentKey: source.contentKey, signal });
    }
    if (!bytes?.length) throw errorWith('EMPTY_MEDIA', '影片處理後沒有任何資料');
    const blob = new Blob([bytes], { type: 'video/mp4' });
    cache.put(key, blob);
    return { blob };
  }
  async function load(ep, token, signal, autoplay) {
    const playable = await resolveSource(ep, signal);
    if (token !== playToken || signal.aborted) throw errorWith('CANCELED', '已切換播放內容');
    if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);
    activeBlobUrl = playable.blob ? URL.createObjectURL(playable.blob) : null;
    video.src = activeBlobUrl || playable.url;
    loading = true;
    video.load();
    await waitMetadata(signal);
    loading = false;
    const prior = watchRecords(storage)[playbackKey(getSeries()?.seriesId, ep.vid)];
    if (!prior?.completed && prior?.seconds > 1 && prior.seconds < video.duration - 2) {
      try { video.currentTime = prior.seconds; } catch { /* nonseekable */ }
    }
    failure = null;
    setStatus('第 ' + ep.index + ' 集 · ' + (video.duration > 0 ? Math.round(video.duration / 60) + ' 分鐘' : '串流播放'));
    if (autoplay) {
      try { await video.play(); }
      catch (e) {
        if (e.name === 'NotAllowedError') setStatus('瀏覽器限制自動播放，請點擊播放器的播放鍵');
        else throw errorWith('PLAYBACK_ERROR', e.message || '播放失敗');
      }
    }
  }
  async function run(ep, token, signal, autoplay, previous = null) {
    let errors = previous;
    while (token === playToken && !signal.aborted) {
      try { await load(ep, token, signal, autoplay); return; }
      catch (error) {
        const parsed = classifyError(error);
        if (signal.aborted || parsed.code === 'CANCELED') return;
        errors = recordFailure(errors, parsed, 5);
        failure = errors;
        if (!errors.retry) {
          setStatus('第 ' + ep.index + ' 集停止重試：' + parsed.message +
            '（同樣錯誤連續 ' + errors.streak + ' 次）');
          loading = false;
          return;
        }
        setStatus('第 ' + ep.index + ' 集重試 ' + errors.streak + '/5：' + parsed.message);
        await new Promise(resolve => setTimeout(resolve, errors.delay));
      }
    }
  }
  function open(ep, autoplay = true) {
    if (!ep) return;
    savePosition();
    clearSource();
    current = ep; buttons(); failure = null;
    label.textContent = '第 ' + ep.index + ' 集';
    const signal = (controller = new AbortController()).signal;
    const token = ++playToken;
    setStatus('正在取得第 ' + ep.index + ' 集片源…');
    void run(ep, token, signal, autoplay);
    onProgress?.();
  }
  function step(direction) {
    const list = episodes();
    const at = list.findIndex(ep => ep.vid === current?.vid);
    const next = list[at + direction];
    if (next) open(next);
  }
  video.addEventListener('timeupdate', () => {
    if (!current || !Number.isFinite(video.currentTime) || Date.now() - lastSaved < 4000) return;
    lastSaved = Date.now();
    savePosition();
  });
  video.addEventListener('pause', () => { if (!video.ended) savePosition(); });
  video.addEventListener('ended', () => {
    savePosition(true);
    const at = episodes().findIndex(ep => ep.vid === current?.vid);
    const next = episodes()[at + 1];
    if (next) { setStatus('此集已播畢，接續第 ' + next.index + ' 集'); open(next); }
    else setStatus('已播放至最後一集');
  });
  // The source can fail after metadata is loaded. Retry the same episode
  // without clearing the consecutive-error history for that episode.
  video.addEventListener('error', () => {
    if (!current || loading || !controller || controller.signal.aborted) return;
    const token = playToken, signal = controller.signal;
    const parsed = { code: 'PLAYBACK_ERROR', message: video.error?.message || '媒體播放發生錯誤' };
    const next = recordFailure(failure, parsed, 5);
    failure = next;
    if (!next.retry) {
      setStatus('第 ' + current.index + ' 集連續 5 次相同播放錯誤，已停止重試'); return;
    }
    setStatus('媒體中斷，正在重試第 ' + current.index + ' 集（' + next.streak + '/5）');
    void new Promise(resolve => setTimeout(resolve, next.delay)).then(() => {
      if (token === playToken && !signal.aborted) void run(current, token, signal, true, failure);
    });
  });
  prevButton.addEventListener('click', () => step(-1));
  nextButton.addEventListener('click', () => step(1));
  qualitySelect.addEventListener('change', () => { if (current) open(current); });
  codecSelect.addEventListener('change', () => { if (current) open(current); });
  return {
    open,
    current: () => current,
    resume() {
      const s = getSeries();
      if (s) open(suggestedEpisode(s, watchRecords(storage)));
    },
    stop() { savePosition(); clearSource(); current = null; playToken++; label.textContent = '尚未播放'; buttons(); },
    pause() { video.pause(); savePosition(); },
    activate() {
      if (!current) this.resume();
      else if (video.paused && video.src) {
        video.play().catch(() => setStatus('請按播放器的播放鍵繼續'));
      }
    },
    refresh: buttons
  };
}
