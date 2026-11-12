import './styles.css';
import { safeName, mediaProxyUrl, apiUrl, normalizeWorkerOrigin, chooseWorkerOrigin, formatBytes, classifyError, errorWith, isHlsUrl, displayStatus } from './logic.js';
import { convertBytes, convertHls } from './ffmpeg.js';
import { MediaCache, episodeCacheKey } from './media-cache.js';
import { recentSeries, rememberSeries, watchRecords, playbackKey } from './library.js';
import { createPlayer } from './player.js';
import { exportQueue } from './queue-export.js';
import { readDownload, storeDownload, removeDownload } from './download-store.js';
import { episodeFileName, originalExtension } from './naming.js';
import { idsFromUrl, urlForSeriesIds } from './deep-link.js';
import { triggerArchiveDownload } from './archive-download.js';
import { recordFailure } from './retry.js';
import { renditionForAttempt } from './source-options.js';

const $ = id => {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing required UI control #' + id);
  return element;
};
const STORE = 'hongguo-dl-queue-v1';
const API_STORE = 'hongguo-dl-worker-origin-v1';
const EXPORT_STORE = 'hongguo-dl-queue-selected-v1';
const defaultWorkerOrigin = chooseWorkerOrigin('', import.meta.env.VITE_API_ORIGIN || '');
let workerOrigin = defaultWorkerOrigin;
try { workerOrigin = chooseWorkerOrigin(localStorage.getItem(API_STORE), defaultWorkerOrigin); }
catch { /* localStorage can be blocked; use the site-provided PROXY default */ }
function requireWorkerOrigin() {
  if (!workerOrigin && location.hostname.endsWith('.github.io'))
    throw errorWith('WORKER_NOT_CONFIGURED', '請先在「Cloudflare Worker API 設定」填入已部署的 Worker 網址');
  return workerOrigin;
}
function apiRoute(path) { return apiUrl(path, requireWorkerOrigin()); }
function updateApiSettings() {
  $('worker-origin').value = workerOrigin;
  $('worker-status').textContent = workerOrigin
    ? (workerOrigin === defaultWorkerOrigin ? '網站預設 API：' : '自訂 API：') + workerOrigin
    : location.hostname.endsWith('.github.io') ? '尚未設定 Cloudflare Worker 網址' : '同源 API：/api/';
  $('reset-worker-origin').hidden = !defaultWorkerOrigin || workerOrigin === defaultWorkerOrigin;
}
function saveApiSettings(event) {
  event.preventDefault();
  try {
    const value = normalizeWorkerOrigin($('worker-origin').value);
    if (!value && location.hostname.endsWith('.github.io')) throw new Error('GitHub Pages 必須填入 Cloudflare Worker 網址');
    workerOrigin = value;
    localStorage.setItem(API_STORE, workerOrigin);
    $('api-settings-error').hidden = true;
    updateApiSettings();
  } catch (error) {
    $('api-settings-error').textContent = error.message;
    $('api-settings-error').hidden = false;
  }
}
function resetApiSettings() {
  workerOrigin = defaultWorkerOrigin;
  try { localStorage.removeItem(API_STORE); } catch { /* privacy/storage restrictions */ }
  $('api-settings-error').hidden = true;
  updateApiSettings();
}
const MAX_BROWSER_BLOB = 300 * 1024 * 1024;
let series = null;
let selected = new Set();
let directory = null;
let jobs = restoreJobs();
const active = new Map();
let paintScheduled = false;
let lastPersisted = 0;
let currentMode = 'download';
let player = null;
let bulkController = null;
let loadingDeepLinks = false;
let lookupSequence = 0;
let exportSelected = new Set();
try { exportSelected = new Set(JSON.parse(localStorage.getItem(EXPORT_STORE) || '[]')); }
catch { /* browser restrictions */ }
const mediaCache = new MediaCache();
function persistExportSelection() {
  try { localStorage.setItem(EXPORT_STORE, JSON.stringify([...exportSelected])); }
  catch { /* no persistent selection */ }
}
const retryTimers = new Map();

function restoreJobs() {
  try {
    return (JSON.parse(localStorage.getItem(STORE) || '[]')).slice(0, 300).map(item => ({
      ...item, directUrl: null, progress: null, segment: null, controller: null,
      status: ['queued', 'resolving', 'downloading', 'processing', 'retrying'].includes(item.status) ? 'failed' : item.status,
      errorCode: ['queued', 'resolving', 'downloading', 'processing', 'retrying'].includes(item.status) ? 'INTERRUPTED' : item.errorCode,
      error: ['queued', 'resolving', 'downloading', 'processing', 'retrying'].includes(item.status) ?
        '頁面已重新開啟；瀏覽器無法繼續未完成的串流，請重試本集' : item.error
    }));
  } catch { return []; }
}
function saveJobs() {
  lastPersisted = Date.now();
  try {
    localStorage.setItem(STORE, JSON.stringify(jobs.map(({ id, seriesId, vid, index, title,
      quality, codec, mode, status, bytes, totalBytes, error, errorCode, attempts, sourceCodec,
      lastErrorKey, errorStreak, failureAttempts, fileName, seriesTitle,
      sourceWidth, sourceHeight, stored, onDisk }) => ({
      id, seriesId, vid, index, title, quality, codec, mode, status, bytes, totalBytes, error, errorCode,
      attempts, sourceCodec, lastErrorKey, errorStreak, failureAttempts,
      fileName, seriesTitle, sourceWidth, sourceHeight, stored, onDisk
    }))));
  } catch { /* Browser storage may be disabled. */ }
}
function update(job, fields) {
  Object.assign(job, fields);
  schedulePaint();
  if (Date.now() - lastPersisted > 900 || ['completed', 'failed', 'canceled'].includes(fields.status)) saveJobs();
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => { paintScheduled = false; renderQueue(); });
}
function formatTime(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
}
function renderQueue() {
  // Queue selections are independent of the currently opened series.
  const selectedJobs = jobs.filter(job => exportSelected.has(job.id));
  const running = jobs.filter(job =>
    ['queued', 'resolving', 'downloading', 'processing', 'retrying'].includes(job.status)).length;
  const complete = jobs.filter(job => job.status === 'completed').length;
  const failed = jobs.filter(job => job.status === 'failed').length;
  $('queue-summary').textContent = jobs.length
    ? jobs.length + ' 集 · ' + running + ' 進行中 · ' + complete + ' 完成 · ' + failed + ' 失敗'
    : '尚未加入下載';
  $('queue-selected-count').textContent = selectedJobs.length + ' 集已選擇';
  $('bulk-zip').disabled = !selectedJobs.length || !!bulkController;
  $('bulk-concat').disabled = !selectedJobs.length || !!bulkController;
  $('retry-failed').disabled = !failed;
  $('clear-finished').disabled = !!bulkController ||
    !jobs.some(job => ['completed', 'canceled'].includes(job.status));
  $('queue-select-all').disabled = !jobs.length;
  $('queue-select-none').disabled = !selectedJobs.length;
  if (!jobs.length) {
    $('queue').innerHTML = '<div class="empty">從上方勾選分集加入佇列，下載完成後再選擇儲存或打包。</div>';
    return;
  }
  $('queue').innerHTML = jobs.map(job => {
    const busy = ['queued', 'resolving', 'downloading', 'processing', 'retrying'].includes(job.status);
    const chosen = exportSelected.has(job.id);
    const progress = job.status === 'completed' ? 100 :
      job.totalBytes > 0 ? Math.min(100, Math.round(100 * (job.bytes || 0) / job.totalBytes)) : 0;
    const subtitle = job.status === 'completed'
      ? job.onDisk ? '✓ 已存入選定資料夾' : '✓ 已暫存於瀏覽器 · 可匯出'
      : job.status === 'retrying' ? '重試 · 連續相同錯誤 ' + (job.errorStreak || 1) + '/3'
      : job.status === 'resolving' ? '正在取得來源…'
      : job.status === 'queued' ? '等待下載'
      : formatBytes(job.bytes || 0) + (job.totalBytes ? ' / ' + formatBytes(job.totalBytes) : '');
    const detail = job.segment ? ' · 分片 ' + job.segment.current + '/' + job.segment.total
      : job.status === 'processing' && Number.isFinite(job.progress) ?
      ' · 媒體處理 ' + Math.round(job.progress * 100) + '%' : '';
    let action = '';
    if (job.status === 'completed')
      action = '<button class="save-one" data-action="save" data-id="' + escapeHtml(job.id) +
        '" title="儲存這一集到裝置">↓ 儲存</button>';
    else if (busy)
      action = '<button data-action="cancel" data-id="' + escapeHtml(job.id) + '">取消</button>';
    else if (job.status === 'failed' || job.status === 'canceled')
      action = '<button data-action="retry" data-id="' + escapeHtml(job.id) + '"' +
        (job.vid === 'direct' && !job.directUrl ? ' disabled' : '') + '>重試</button>';
    return '<article class="job ' + (chosen ? 'selected' : '') +
      '" role="listitem"><div class="job-layout"><input class="job-select" type="checkbox" ' +
      'data-export-id="' + escapeHtml(job.id) + '" aria-label="選取' + escapeHtml(job.title) +
      '以匯出"' + (chosen ? ' checked' : '') + '><div class="job-body">' +
      '<div class="job-topline"><div><b>' + escapeHtml(job.title) +
      '</b><div class="job-filename" title="輸出檔名">' +
      escapeHtml(job.fileName || episodeFileName(job)) + '</div>' +
      '<div class="job-meta">' + escapeHtml(job.sourceCodec || job.codec || '未知編碼') +
      ' · ' + escapeHtml(job.mode === 'h264' ? 'H.264' : job.mode === 'copy' ? '無損封裝' : '原始') +
      '</div></div><div class="job-controls"><span class="status s-' + escapeHtml(job.status) +
      '">' + escapeHtml(job.status === 'completed' ? '已備妥' : displayStatus(job.status)) +
      '</span>' + action + '</div></div>' +
      '<div class="progress-track"><div class="progress-bar" style="width:' + progress +
      '%"></div></div><div class="job-meta">' + escapeHtml(subtitle + detail) + '</div>' +
      (job.error ? '<div class="job-error">' + escapeHtml(job.error) + '</div>' : '') +
      '</div></div></article>';
  }).join('');
}
function renderEpisodes() {
  if (!series) return;
  const watch = watchRecords(localStorage);
  const current = player?.current()?.vid;
  $('episodes').innerHTML = series.episodes.map(ep => {
    const record = watch[playbackKey(series.seriesId, ep.vid)];
    const watched = !!record?.completed;
    const seconds = Number(record?.seconds) || 0;
    const duration = Number(record?.duration) || 0;
    const percent = watched ? 100 : duration > 0 ?
      Math.min(100, Math.max(0, Math.round(100 * seconds / duration))) : 0;
    if (currentMode === 'play') {
      const label = '第 ' + ep.index + ' 集' +
        (watched ? '，已看完' : percent ? '，已看 ' + percent + '%' : '');
      return '<button type="button" class="episode play-episode ' +
        (watched ? 'watched ' : seconds > 0.5 ? 'in-progress ' : '') +
        (ep.vid === current ? 'current' : '') +
        '" data-play-vid="' + escapeHtml(ep.vid) + '" aria-label="' +
        escapeHtml(label) + '"><span>' +
        (series.kind === 'direct' ? '媒體直連' : '第 ' + ep.index + ' 集') +
        '</span>' +
        (watched ? '<span class="watched-check" aria-hidden="true">✓</span>'
          : seconds > 0.5 ? '<small>' + formatTime(seconds) +
            (duration > 0 ? ' / ' + formatTime(duration) : '') + '</small>' : '') +
        '<span class="watch-track" aria-hidden="true"><span style="width:' + percent +
        '%"></span></span></button>';
    }
    const checked = selected.has(ep.vid);
    return '<label class="episode ' + (checked ? 'selected' : '') +
      '"><input type="checkbox" data-vid="' + escapeHtml(ep.vid) +
      '"' + (checked ? ' checked' : '') + '><span>' +
      (series.kind === 'direct' ? '媒體直連' : '第 ' + ep.index + ' 集') + '</span>' +
      (ep.available === false ? '<small>可能受限制</small>' : '') + '</label>';
  }).join('');
  const finished = series.episodes.filter(ep =>
    watch[playbackKey(series.seriesId, ep.vid)]?.completed).length;
  $('series-count').textContent = currentMode === 'play'
    ? series.total + ' 集 · 已看完 ' + finished + ' 集'
    : series.total + ' 集 · 已選擇 ' + selected.size + ' 集';
  $('add-queue').disabled = !selected.size;
  $('select-all').hidden = currentMode === 'play';
  $('select-none').hidden = currentMode === 'play';
}
function renderRecentSeries() {
  const items = recentSeries(localStorage);
  $('recent-series').innerHTML = items.length
    ? '<h3>最近查詢的影集（儲存在此瀏覽器）</h3><div class="recent-list">' +
      items.map(item => '<button type="button" data-recent-id="' +
        escapeHtml(item.seriesId) + '">' + escapeHtml(item.title) + ' · ' +
        item.total + ' 集</button>').join('') + '</div>'
    : '';
}
function showSeries(result, fromHistory = false) {
  player?.stop();
  series = { ...result, episodes: result.episodes.map(x => ({ ...x, url: x.url || null })) };
  selected = new Set(series.episodes.filter(ep => ep.available !== false).map(ep => ep.vid));
  $('series-title').textContent = series.title || '未命名短劇';
  document.title = (series.title || '短劇') + ' · Hongguo DL';
  $('series').hidden = false;
  if (series.kind === 'series') rememberSeries(localStorage, series);
  renderRecentSeries();
  renderEpisodes();
  setMode(currentMode);
}
function setMode(mode) {
  currentMode = mode === 'play' ? 'play' : 'download';
  $('mode-download').classList.toggle('selected', currentMode === 'download');
  $('mode-play').classList.toggle('selected', currentMode === 'play');
  $('mode-download').setAttribute('aria-pressed', String(currentMode === 'download'));
  $('mode-play').setAttribute('aria-pressed', String(currentMode === 'play'));
  $('queue-panel').hidden = currentMode === 'play';
  $('download-controls').hidden = currentMode === 'play';
  $('player-panel').hidden = currentMode !== 'play' || !series;
  if (series) renderEpisodes();
  if (currentMode === 'play' && series) player?.activate();
  else player?.pause();
}
async function apiJson(route) {
  const response = await fetch(apiRoute(route), { headers: { Accept: 'application/json' } });
  let data;
  try { data = await response.json(); } catch { throw errorWith('INVALID_JSON', 'Worker 沒有回傳有效 JSON'); }
  if (!response.ok) throw errorWith(data?.error?.code || 'HTTP_' + response.status,
    data?.error?.message || '請求失敗（HTTP ' + response.status + '）');
  return data;
}
async function getSource(seriesId, vid, quality = 'auto', codec = 'auto') {
  return apiJson('/api/source?sid=' + encodeURIComponent(seriesId) +
    '&vid=' + encodeURIComponent(vid) + '&quality=' + encodeURIComponent(quality) +
    '&codec=' + encodeURIComponent(codec));
}
async function lookupIds(ids) {
  const list = [...new Set(ids)].slice(0, 20);
  const currentRequest = ++lookupSequence;
  loadingDeepLinks = true;
  $('lookup-button').disabled = true;
  $('lookup-error').hidden = true;
  const area = $('linked-series');
  area.hidden = false;
  area.innerHTML = '<span class="subtle">讀取 ' + list.length + ' 部影集…</span>';
  const results = [];
  let shown = false;
  for (const [index, id] of list.entries()) {
    if (currentRequest !== lookupSequence) break;
    try {
      const result = await apiJson('/api/series?input=' + encodeURIComponent(id));
      if (result.kind !== 'series') throw errorWith('INVALID_SERIES', '無法辨識影集');
      rememberSeries(localStorage, result);
      results.push({ id, title: result.title, ok: true });
      if (!shown) {
        $('input-url').value = id;
        showSeries(result);
        shown = true;
      } else renderRecentSeries();
    } catch (error) {
      results.push({ id, title: classifyError(error).message, ok: false });
    }
    area.innerHTML = results.map(record => record.ok
      ? '<button type="button" class="series-chip" data-linked-id="' +
        escapeHtml(record.id) + '">✓ ' + escapeHtml(record.title) + '</button>'
      : '<span class="series-chip error" title="' + escapeHtml(record.title) +
        '">✕ ' + escapeHtml(record.id) + '</span>').join('');
  }
  loadingDeepLinks = false;
  $('lookup-button').disabled = false;
  area.hidden = !results.length;
  if (!shown) {
    $('lookup-error').textContent = '無法載入網址中的影集，請檢查 ID 或 Worker 連線';
    $('lookup-error').hidden = false;
  }
}
async function lookup(event) {
  event.preventDefault();
  const input = $('input-url').value.trim();
  if (!input) return;
  const ids = /^\d+(?:[\s,;，、]+\d+)+$/.test(input)
    ? input.split(/[\s,;，、]+/) : null;
  if (ids?.length) return lookupIds(ids);
  ++lookupSequence;
  $('linked-series').hidden = true;
  $('lookup-button').disabled = true;
  $('lookup-error').hidden = true;
  try {
    const response = await apiJson('/api/series?input=' + encodeURIComponent(input));
    showSeries(response);
  } catch (error) {
    $('lookup-error').textContent = classifyError(error).message;
    $('lookup-error').hidden = false;
  } finally { $('lookup-button').disabled = false; }
}
async function chooseFolder() {
  try {
    if (!window.showDirectoryPicker) throw errorWith('NO_DIRECTORY', '此瀏覽器沒有資料夾存取 API');
    directory = await window.showDirectoryPicker({ mode: 'readwrite' });
    $('folder-status').textContent = '✓ ' + directory.name;
    $('browser-note').textContent = '✓ 下載完成將自動寫入選擇的資料夾';
  } catch (e) {
    if (e.name !== 'AbortError') {
      $('browser-note').textContent = classifyError(e).message;
    }
  }
}
function queueSelected() {
  if (!series || !selected.size) return;
  const quality = $('quality').value, codec = $('codec').value, mode = $('output-mode').value;
  for (const ep of series.episodes.filter(e => selected.has(e.vid))) {
    const same = jobs.find(j => j.seriesId === series.seriesId && j.vid === ep.vid &&
      j.mode === mode && j.codec === codec && j.quality === quality &&
      !['failed', 'canceled'].includes(j.status));
    if (same) {
      exportSelected.add(same.id);
      continue;
    }
    const name = series.kind === 'direct' ? '媒體直連' :
      series.title + ' · 第 ' + String(ep.index).padStart(3, '0') + ' 集';
    const job = { id: crypto.randomUUID(), seriesId: series.seriesId || null,
      seriesTitle: series.title || '影集', vid: ep.vid,
      directUrl: ep.url, index: ep.index, title: name, codec, quality, mode, status: 'queued',
      bytes: 0, totalBytes: 0, attempts: 0, error: '', errorCode: '', segment: null, progress: null,
      lastErrorKey: '', errorStreak: 0, failureAttempts: 0, stored: false, onDisk: false };
    jobs.unshift(job);
    exportSelected.add(job.id);
  }
  persistExportSelection();
  saveJobs(); schedulePaint(); pump();
}
function queueRetry(job) {
  if (active.has(job.id)) return;
  if (job.vid === 'direct' && !job.directUrl) {
    update(job, { status: 'failed', errorCode: 'DIRECT_URL_EXPIRED',
      error: '重新載入後不會保留媒體直連網址；請重新輸入網址加入新工作' });
    return;
  }
  const timer = retryTimers.get(job.id);
  if (timer) { clearTimeout(timer); retryTimers.delete(job.id); }
  update(job, { status: 'queued', bytes: 0, totalBytes: 0, progress: null, segment: null,
    error: '', errorCode: '', lastErrorKey: '', errorStreak: 0, failureAttempts: 0,
    fileName: null, stored: false, onDisk: false });
  pump();
}
function cancel(job) {
  const timer = retryTimers.get(job.id);
  if (timer) { clearTimeout(timer); retryTimers.delete(job.id); }
  if (active.has(job.id)) active.get(job.id).abort();
  else if (['queued', 'retrying'].includes(job.status))
    update(job, { status: 'canceled', error: '使用者取消', errorCode: 'CANCELED' });
}
function pump() {
  const concurrency = Number($('concurrency').value) || 2;
  while (active.size < concurrency) {
    const job = jobs.find(j => j.status === 'queued' && !active.has(j.id));
    if (!job) break;
    const controller = new AbortController();
    active.set(job.id, controller);
    runJob(job, controller.signal).finally(() => {
      active.delete(job.id);
      saveJobs(); schedulePaint(); pump();
    });
  }
}
function outputFileName(job, source, processed) {
  return episodeFileName(job, processed ? '.mp4' : originalExtension(source.url));
}
function triggerSave(bytes, name) {
  const blob = bytes instanceof Blob ? bytes :
    new Blob(Array.isArray(bytes) ? bytes : [bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function saveProcessed(bytes, name, job = null, source = null) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'video/mp4' });
  if (!directory && blob.size > MAX_BROWSER_BLOB)
    throw errorWith('MEMORY_LIMIT', '單集超過 300 MiB，請改用支援資料夾儲存的瀏覽器');
  if (directory) {
    const file = await directory.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    try { await stream.write(blob); await stream.close(); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
  } else if (!job) {
    // Explicit export action: one user gesture produces one Save dialog.
    triggerSave(blob, name);
  } else {
    // Ordinary queued download: *no* dialog. Firefox stores completed
    // episodes in IndexedDB until the user chooses Save or ZIP/MP4 export.
    try {
      await storeDownload(job.id, name, blob, {
        codec: source?.codec || job.sourceCodec,
        width: source?.width, height: source?.height, seriesId: job.seriesId
      });
    } catch (error) {
      throw errorWith('STORAGE_QUOTA', '瀏覽器儲存空間不足或不可用：' +
        (error.message || '請清除舊佇列，或選擇儲存資料夾'));
    }
  }
  if (job) update(job, {
    fileName: name, stored: !directory, onDisk: !!directory,
    sourceCodec: source?.codec || job.sourceCodec,
    sourceWidth: source?.width || null, sourceHeight: source?.height || null
  });
}
async function readQueuedFile(jobId) {
  const entry = await readDownload(jobId).catch(() => null);
  if (entry?.blob) return entry;
  const job = jobs.find(j => j.id === jobId);
  if (directory && job?.onDisk && job.fileName) {
    try {
      const handle = await directory.getFileHandle(job.fileName);
      const blob = await handle.getFile();
      return { id: job.id, filename: job.fileName, blob,
        codec: job.sourceCodec, width: job.sourceWidth, height: job.sourceHeight };
    } catch { /* directory permission was revoked */ }
  }
  return null;
}
async function saveOne(job) {
  if (job.status !== 'completed') return;
  const file = await readQueuedFile(job.id);
  if (!file?.blob) {
    update(job, { status: 'failed', stored: false,
      error: '瀏覽器暫存已失效；請按「重試」重新下載此集', errorCode: 'STORAGE_MISSING' });
    return;
  }
  triggerSave(file.blob, file.filename || job.fileName || episodeFileName(job));
}
function assertOk(response) {
  if (!response.ok) return response.json().catch(() => null).then(data => {
    throw errorWith(data?.error?.code || 'HTTP_' + response.status,
      data?.error?.message || '媒體來源 HTTP ' + response.status);
  });
}
async function fetchBytes(url, profile, signal, max, onRead) {
  if (max <= 0) throw errorWith('MEMORY_LIMIT', '記憶體上限已達');
  const res = await fetch(mediaProxyUrl(url, profile, requireWorkerOrigin()), { signal });
  if (!res.ok) { await assertOk(res); }
  const advertised = Number(res.headers.get('content-length') || 0);
  if (advertised > max) throw errorWith('MEMORY_LIMIT', '媒體超過下載／記憶體安全限制');
  if (!res.body) throw errorWith('EMPTY_MEDIA', '來源未回傳資料串流');
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw errorWith('CANCELED', '使用者取消');
      size += value.byteLength;
      if (size > max) throw errorWith('MEMORY_LIMIT', '單次讀取超過記憶體限制');
      chunks.push(value);
      onRead?.(value.byteLength, advertised);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw errorWith('EMPTY_MEDIA', '媒體回傳零位元組');
  if (advertised && size !== advertised) throw errorWith('INCOMPLETE', '已收 ' + size + '，預期 ' + advertised + ' 位元組');
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function streamToDestination(job, source, signal) {
  const res = await fetch(mediaProxyUrl(source.url, source.source === 'app' ? 'app' : 'web', requireWorkerOrigin()), { signal });
  if (!res.ok) { await assertOk(res); }
  if (!res.body) throw errorWith('EMPTY_MEDIA', '伺服器沒有回傳影片串流');
  const length = Number(res.headers.get('content-length') || 0);
  const name = outputFileName(job, source, false);
  const writer = directory ? await (await directory.getFileHandle(name, { create: true })).createWritable() : null;
  const chunks = [];
  let bytes = 0, complete = false;
  try {
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw errorWith('CANCELED', '使用者取消');
        bytes += value.byteLength;
        if (writer) await writer.write(value);
        else {
          if (bytes > MAX_BROWSER_BLOB) throw errorWith('MEMORY_LIMIT', '此瀏覽器沒有目錄串流寫入，影片超過 300 MiB');
          chunks.push(value);
        }
        update(job, { bytes, totalBytes: length });
      }
    } finally { reader.releaseLock(); }
    if (!bytes) throw errorWith('EMPTY_MEDIA', '影片回傳零位元組');
    if (length && length !== bytes) throw errorWith('INCOMPLETE', 'Content-Length：預期 ' + length + '，實收 ' + bytes);
    if (writer) {
      await writer.close();
      update(job, { fileName: name, stored: false, onDisk: true,
        sourceCodec: source.codec, sourceWidth: source.width, sourceHeight: source.height });
    } else {
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      try {
        await storeDownload(job.id, name, blob, {
          codec: source.codec, width: source.width, height: source.height, seriesId: job.seriesId
        });
      } catch (error) {
        throw errorWith('STORAGE_QUOTA', '瀏覽器暫存空間不足：' + error.message);
      }
      if (/\.mp4$/i.test(name) && job.mode !== 'h264')
        mediaCache.put(episodeCacheKey(job.seriesId, job.vid, job.quality, job.codec), blob);
      update(job, { fileName: name, stored: true, onDisk: false,
        sourceCodec: source.codec, sourceWidth: source.width, sourceHeight: source.height });
    }
    complete = true;
  } finally {
    if (writer && !complete) await writer.abort().catch(() => {});
  }
}
async function runJob(job, signal) {
  update(job, { status: 'resolving', attempts: job.attempts + 1, bytes: 0, totalBytes: 0, error: '', errorCode: '' });
  try {
    const cached = job.mode === 'h264' ? null :
      mediaCache.get(episodeCacheKey(job.seriesId, job.vid, job.quality, job.codec));
    if (cached) {
      update(job, { status: 'downloading', bytes: cached.size, totalBytes: cached.size });
      await saveProcessed(cached, episodeFileName(job, '.mp4'), job);
      update(job, { status: 'completed', error: '', errorCode: '', progress: 1 });
      return;
    }
    const data = job.vid === 'direct'
      ? { variants: [{ url: job.directUrl, source: 'web', codec: 'unknown', contentKey: null }] }
      : await getSource(job.seriesId, job.vid, 'auto', 'auto');
    if (signal.aborted) throw errorWith('CANCELED', '使用者取消');
    // Retry with another advertised URL while preserving the selected tier.
    const source = renditionForAttempt(data.variants,
      { quality: job.quality, codec: job.codec }, job.attempts - 1);
    if (!source?.url) throw errorWith('SOURCE_UNAVAILABLE', '沒有可用來源');
    update(job, { status: 'downloading', sourceCodec: source.codec || 'unknown' });
    const hls = isHlsUrl(source.url);
    const profile = source.source === 'app' ? 'app' : 'web';
    const requiresFfmpeg = hls || !!source.contentKey || job.mode !== 'original';
    if (!requiresFfmpeg) {
      await streamToDestination(job, source, signal);
    } else if (hls) {
      update(job, { status: 'processing' });
      const out = await convertHls(source.url, {
        mode: job.mode === 'h264' ? 'h264' : 'copy', contentKey: source.contentKey, signal,
        fetchBytes: (url, signal, max) => fetchBytes(url, profile, signal, max,
          n => update(job, { bytes: (job.bytes || 0) + n })),
        segmentProgress: segment => update(job, { segment }),
        progress: progress => update(job, { progress })
      });
      if (signal.aborted) throw errorWith('CANCELED', '使用者取消');
      if (job.mode !== 'h264') {
        mediaCache.put(episodeCacheKey(job.seriesId, job.vid, job.quality, job.codec),
          new Blob([out], { type: 'video/mp4' }));
      }
      await saveProcessed(out, outputFileName(job, source, true), job, source);
    } else {
      const bytes = await fetchBytes(source.url, profile, signal, 320 * 1024 * 1024,
        (n, total) => update(job, { bytes: (job.bytes || 0) + n, totalBytes: total }));
      update(job, { status: 'processing', progress: 0 });
      const out = await convertBytes(bytes, {
        mode: job.mode === 'h264' ? 'h264' : 'copy', contentKey: source.contentKey, signal,
        progress: progress => update(job, { progress })
      });
      if (signal.aborted) throw errorWith('CANCELED', '使用者取消');
      if (job.mode !== 'h264') {
        mediaCache.put(episodeCacheKey(job.seriesId, job.vid, job.quality, job.codec),
          new Blob([out], { type: 'video/mp4' }));
      }
      await saveProcessed(out, outputFileName(job, source, true), job, source);
    }
    update(job, { status: 'completed', error: '', errorCode: '', progress: 1 });
  } catch (error) {
    const result = classifyError(error);
    if (result.code === 'CANCELED' || signal.aborted) {
      update(job, { status: 'canceled', errorCode: 'CANCELED', error: '使用者已取消' });
      return;
    }
    const failure = recordFailure({
      key: job.lastErrorKey, streak: job.errorStreak || 0, attempts: job.failureAttempts || 0
    }, result, 3);
    update(job, { status: failure.retry ? 'retrying' : 'failed',
      errorCode: result.code, error: result.message,
      lastErrorKey: failure.key, errorStreak: failure.streak, failureAttempts: failure.attempts });
    if (failure.retry) {
      const timer = setTimeout(() => {
        retryTimers.delete(job.id);
        if (job.status === 'retrying') {
          update(job, { status: 'queued' });
          pump();
        }
      }, failure.delay);
      retryTimers.set(job.id, timer);
    }
  }
}

async function startBulk(type) {
  if (bulkController) return;
  const items = jobs.filter(job => exportSelected.has(job.id));
  if (!items.length) return;
  bulkController = new AbortController();
  const signal = bulkController.signal;
  $('bulk-cancel').hidden = false;
  renderQueue();
  $('bulk-status').textContent = type === 'zip'
    ? '正在建立 ZIP 下載…' : '正在準備已選擇的 MP4…';
  try {
    await exportQueue({
      type, jobs: items,
      readFile: readQueuedFile,
      currentStatus: id => jobs.find(j => j.id === id)?.status || 'missing',
      signal,
      saveArchive: (stream, filename) => triggerArchiveDownload(stream, filename, {
        onFallback: () => {
          $('bulk-status').textContent = '改用記憶體 ZIP 模式（上限 240 MiB）';
        }
      }),
      saveMp4: (bytes, filename) => saveProcessed(bytes, filename),
      onStatus: text => { $('bulk-status').textContent = text; }
    });
  } catch (error) {
    const failure = classifyError(error);
    $('bulk-status').textContent = (signal.aborted ? '已取消' : '無法匯出') +
      ' · ' + failure.message;
  } finally {
    bulkController = null;
    $('bulk-cancel').hidden = true;
    renderQueue();
  }
}
$('api-settings-form').addEventListener('submit', saveApiSettings);
$('reset-worker-origin').addEventListener('click', resetApiSettings);
updateApiSettings();
player = createPlayer({
  video: $('player-video'), status: $('player-status'), label: $('player-episode'),
  prevButton: $('player-prev'), nextButton: $('player-next'),
  qualitySelect: $('player-quality'), codecSelect: $('player-codec'),
  speedSelect: $('player-speed'), fitSelect: $('player-fit'), autoNextInput: $('player-autonext'),
  settingsToggle: $('player-settings-toggle'), settingsMenu: $('player-settings'),
  settingsClose: $('player-settings-close'), pipButton: $('player-pip'),
  sourceInfo: $('player-source-info'),
  getSeries: () => series, sourceFor: getSource,
  fetchBytes, getWorkerOrigin: requireWorkerOrigin,
  cache: mediaCache, storage: localStorage,
  onProgress: () => { if (series && currentMode === 'play') renderEpisodes(); }
});
$('mode-download').addEventListener('click', () => setMode('download'));
$('mode-play').addEventListener('click', () => setMode('play'));
$('bulk-zip').addEventListener('click', () => { void startBulk('zip'); });
$('bulk-concat').addEventListener('click', () => { void startBulk('mp4'); });
$('bulk-cancel').addEventListener('click', () => {
  if (bulkController) bulkController.abort();
});
$('recent-series').addEventListener('click', event => {
  const button = event.target.closest('button[data-recent-id]');
  if (!button) return;
  const record = recentSeries(localStorage).find(r => r.seriesId === button.dataset.recentId);
  if (!record) return;
  $('input-url').value = record.seriesId;
  showSeries(record, true);
});
$('linked-series').addEventListener('click', event => {
  const button = event.target.closest('button[data-linked-id]');
  if (!button) return;
  const entry = recentSeries(localStorage).find(x => x.seriesId === button.dataset.linkedId);
  if (entry) showSeries(entry, true);
});
$('share-series').addEventListener('click', async () => {
  if (!series?.seriesId) return;
  const url = urlForSeriesIds(location.href, [series.seriesId]);
  try {
    await navigator.clipboard.writeText(url);
    $('share-series').textContent = '✓ 已複製';
    setTimeout(() => { $('share-series').textContent = '分享連結'; }, 2200);
  } catch {
    $('share-series').textContent = '複製失敗';
  }
});
renderRecentSeries();
$('lookup-form').addEventListener('submit', lookup);
$('choose-folder').addEventListener('click', chooseFolder);
$('add-queue').addEventListener('click', queueSelected);
$('select-all').addEventListener('click', () => {
  if (!series) return;
  selected = new Set(series.episodes.map(e => e.vid)); renderEpisodes();
});
$('select-none').addEventListener('click', () => { selected.clear(); if (series) renderEpisodes(); });
$('episodes').addEventListener('click', e => {
  if (currentMode !== 'play' || !series) return;
  const control = e.target.closest('button[data-play-vid]');
  if (!control) return;
  const ep = series.episodes.find(item => item.vid === control.dataset.playVid);
  if (ep) player.open(ep);
});
$('episodes').addEventListener('change', e => {
  if (currentMode !== 'download') return;
  const checkbox = e.target.closest('input[data-vid]');
  if (!checkbox) return;
  if (checkbox.checked) selected.add(checkbox.dataset.vid);
  else selected.delete(checkbox.dataset.vid);
  renderEpisodes();
});
$('queue').addEventListener('change', event => {
  const box = event.target.closest('input[data-export-id]');
  if (!box) return;
  if (box.checked) exportSelected.add(box.dataset.exportId);
  else exportSelected.delete(box.dataset.exportId);
  persistExportSelection();
  renderQueue();
});
$('queue-select-all').addEventListener('click', () => {
  exportSelected = new Set(jobs.map(job => job.id));
  persistExportSelection(); renderQueue();
});
$('queue-select-none').addEventListener('click', () => {
  exportSelected.clear();
  persistExportSelection(); renderQueue();
});
$('queue').addEventListener('click', e => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const job = jobs.find(j => j.id === button.dataset.id);
  if (!job) return;
  if (button.dataset.action === 'retry') queueRetry(job);
  if (button.dataset.action === 'cancel') cancel(job);
  if (button.dataset.action === 'save')
    void saveOne(job).catch(error => update(job, {
      errorCode: 'SAVE_ERROR', error: error.message || '儲存失敗'
    }));
});
$('retry-failed').addEventListener('click', () => {
  for (const job of jobs.filter(j => j.status === 'failed' && j.vid !== 'direct')) queueRetry(job);
});
$('clear-finished').addEventListener('click', () => {
  const remove = jobs.filter(j => ['completed', 'canceled'].includes(j.status));
  if (!remove.length) return;
  if (!window.confirm('清除 ' + remove.length +
    ' 個佇列項目？這會同時刪除瀏覽器內的暫存影片，但不會刪除已儲存到資料夾的影片。')) return;
  jobs = jobs.filter(j => !remove.includes(j));
  for (const job of remove) {
    exportSelected.delete(job.id);
    void removeDownload(job.id).catch(() => {});
  }
  persistExportSelection(); saveJobs(); schedulePaint();
});
$('concurrency').addEventListener('change', pump);
if (!window.showDirectoryPicker) {
  $('choose-folder').hidden = true;
  $('folder-status').textContent = '本機暫存';
  $('browser-note').textContent = '✓ 影片完成後存入瀏覽器 · 請從佇列儲存或打包匯出';
} else {
  $('browser-note').textContent = '✓ 已完成的影片可逐集儲存，或用佇列 ZIP／MP4 匯出';
}
if (navigator.storage?.estimate) {
  navigator.storage.estimate().then(estimate => {
    if (estimate.quota && !directory)
      $('browser-note').title = '瀏覽器暫存用量 ' + formatBytes(estimate.usage) +
        ' / ' + formatBytes(estimate.quota);
  }).catch(() => {});
}
renderQueue();
setMode('download');
const initialIds = idsFromUrl(new URL(location.href));
if (initialIds.length) {
  $('input-url').value = initialIds.join(', ');
  void lookupIds(initialIds);
}
