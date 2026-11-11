import './styles.css';
import { safeName, mediaProxyUrl, formatBytes, classifyError, errorWith, isHlsUrl, displayStatus } from './logic.js';
import { convertBytes, convertHls } from './ffmpeg.js';

const $ = id => document.getElementById(id);
const STORE = 'hongguo-dl-queue-v1';
const MAX_BROWSER_BLOB = 300 * 1024 * 1024;
let series = null;
let selected = new Set();
let directory = null;
let jobs = restoreJobs();
const active = new Map();
let paintScheduled = false;
let lastPersisted = 0;

function restoreJobs() {
  try {
    return (JSON.parse(localStorage.getItem(STORE) || '[]')).slice(0, 300).map(item => ({
      ...item, directUrl: null, progress: null, segment: null, controller: null,
      status: ['queued', 'resolving', 'downloading', 'processing'].includes(item.status) ? 'failed' : item.status,
      errorCode: ['queued', 'resolving', 'downloading', 'processing'].includes(item.status) ? 'INTERRUPTED' : item.errorCode,
      error: ['queued', 'resolving', 'downloading', 'processing'].includes(item.status) ?
        '頁面已重新開啟；瀏覽器無法繼續未完成的串流，請重試本集' : item.error
    }));
  } catch { return []; }
}
function saveJobs() {
  lastPersisted = Date.now();
  try {
    localStorage.setItem(STORE, JSON.stringify(jobs.map(({ id, seriesId, vid, index, title,
      quality, codec, mode, status, bytes, totalBytes, error, errorCode, attempts, sourceCodec }) => ({
      id, seriesId, vid, index, title, quality, codec, mode, status, bytes, totalBytes, error, errorCode,
      attempts, sourceCodec
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
function renderQueue() {
  const counts = { completed: 0, failed: 0, downloading: 0, processing: 0, queued: 0 };
  for (const job of jobs) {
    if (job.status in counts) counts[job.status]++;
    else if (job.status === 'resolving') counts.downloading++;
  }
  $('queue-summary').textContent = jobs.length ?
    jobs.length + ' 項 · ' + (counts.downloading + counts.processing) + ' 進行中 · ' +
    counts.queued + ' 等待 · ' + counts.completed + ' 完成 · ' + counts.failed + ' 失敗' :
    '尚未加入任何下載';
  $('retry-failed').disabled = !jobs.some(j => j.status === 'failed' && j.vid !== 'direct');
  $('clear-finished').disabled = !jobs.some(j => ['completed', 'canceled'].includes(j.status));
  if (!jobs.length) {
    $('queue').innerHTML = '<div class="empty">佇列是空的。讀取劇集後即可選集下載。</div>';
    return;
  }
  $('queue').innerHTML = jobs.map(job => {
    const busy = ['resolving', 'downloading', 'processing'].includes(job.status);
    const progress = Number.isFinite(job.totalBytes) && job.totalBytes > 0
      ? Math.min(100, Math.round(100 * (job.bytes || 0) / job.totalBytes)) : null;
    const detail = job.segment
      ? ' · 分片 ' + job.segment.current + ' / ' + job.segment.total
      : (job.status === 'processing' && Number.isFinite(job.progress) ?
        ' · FFmpeg ' + Math.round(job.progress * 100) + '%' : '');
    const bytesText = formatBytes(job.bytes || 0) +
      (job.totalBytes ? ' / ' + formatBytes(job.totalBytes) : '') +
      (progress != null ? ' · ' + progress + '%' : '') + detail;
    const message = job.error ? '<div class="job-error"><strong>' + escapeHtml(job.errorCode || 'ERROR') +
      '</strong> · ' + escapeHtml(job.error) + '</div>' : '';
    const action = busy || job.status === 'queued'
      ? '<button data-action="cancel" data-id="' + escapeHtml(job.id) + '">取消</button>'
      : job.status === 'failed' || job.status === 'canceled'
        ? '<button data-action="retry" data-id="' + escapeHtml(job.id) + '"' +
          (job.vid === 'direct' && !job.directUrl ? ' disabled title="請重新輸入直接媒體網址"' : '') + '>重試</button>' : '';
    return '<div class="job" role="listitem"><div class="job-head"><div><b>' + escapeHtml(job.title) +
      '</b><div class="job-meta">' + escapeHtml(job.sourceCodec || job.codec) + ' · ' +
      escapeHtml(job.mode === 'h264' ? '轉 H.264' : job.mode === 'copy' ? '無損封裝' : '原始串流') +
      ' · 嘗試 ' + escapeHtml(job.attempts) + ' 次</div></div><div class="job-controls"><span class="status s-' +
      escapeHtml(job.status) + '">' + escapeHtml(displayStatus(job.status)) + '</span>' + action +
      '</div></div><div class="progress-track"><div class="progress-bar" style="width:' +
      (job.status === 'completed' ? 100 : progress || 0) + '%"></div></div><div class="job-meta">' +
      escapeHtml(job.status === 'resolving' ? '正在解析播放來源…' :
        job.status === 'queued' ? '等待可用下載通道' : bytesText) + '</div>' + message + '</div>';
  }).join('');
}
function renderEpisodes() {
  $('episodes').innerHTML = series.episodes.map(ep => {
    const checked = selected.has(ep.vid);
    return '<label class="episode ' + (checked ? 'selected' : '') + '"><input type="checkbox" data-vid="' +
      escapeHtml(ep.vid) + '"' + (checked ? ' checked' : '') + '><span>' +
      (series.kind === 'direct' ? '媒體直連' : '第 ' + ep.index + ' 集') + '</span>' +
      (ep.available === false ? '<small>官網可能限制</small>' : '') + '</label>';
  }).join('');
  $('series-count').textContent = series.total + ' 集 · 已選擇 ' + selected.size + ' 集' +
    (series.accessible != null ? ' · 官網標示可用 ' + series.accessible + ' 集' : '');
  $('add-queue').disabled = !selected.size;
}
async function apiJson(route) {
  const response = await fetch(route, { headers: { Accept: 'application/json' } });
  let data;
  try { data = await response.json(); } catch { throw errorWith('INVALID_JSON', 'Worker 沒有回傳有效 JSON'); }
  if (!response.ok) throw errorWith(data?.error?.code || 'HTTP_' + response.status,
    data?.error?.message || '請求失敗（HTTP ' + response.status + '）');
  return data;
}
async function lookup(event) {
  event.preventDefault();
  const input = $('input-url').value.trim();
  if (!input) return;
  $('lookup-button').disabled = true;
  $('lookup-error').hidden = true;
  try {
    const response = await apiJson('/api/series?input=' + encodeURIComponent(input));
    series = response;
    series.episodes = response.episodes.map(x => ({ ...x, url: x.url || null }));
    selected = new Set(series.episodes.filter(ep => ep.available !== false).map(ep => ep.vid));
    $('series-title').textContent = response.title || '未命名短劇';
    $('series').hidden = false;
    renderEpisodes();
  } catch (error) {
    $('lookup-error').textContent = classifyError(error).message;
    $('lookup-error').hidden = false;
  } finally { $('lookup-button').disabled = false; }
}
async function chooseFolder() {
  try {
    if (!window.showDirectoryPicker) throw errorWith('NO_DIRECTORY', '此瀏覽器沒有資料夾存取 API');
    directory = await window.showDirectoryPicker({ mode: 'readwrite' });
    $('folder-status').textContent = '已選擇：' + directory.name;
    $('browser-note').textContent = '可直接串流寫入資料夾，無須在記憶體保留整部影片。';
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
      !['failed', 'canceled', 'completed'].includes(j.status));
    if (same) continue;
    const name = series.kind === 'direct' ? '媒體直連' :
      series.title + ' · 第 ' + String(ep.index).padStart(3, '0') + ' 集';
    jobs.unshift({ id: crypto.randomUUID(), seriesId: series.seriesId || null, vid: ep.vid,
      directUrl: ep.url, index: ep.index, title: name, codec, quality, mode, status: 'queued',
      bytes: 0, totalBytes: 0, attempts: 0, error: '', errorCode: '', segment: null, progress: null });
  }
  saveJobs(); schedulePaint(); pump();
}
function queueRetry(job) {
  if (active.has(job.id)) return;
  if (job.vid === 'direct' && !job.directUrl) {
    update(job, { status: 'failed', errorCode: 'DIRECT_URL_EXPIRED',
      error: '重新載入後不會保留媒體直連網址；請重新輸入網址加入新工作' });
    return;
  }
  update(job, { status: 'queued', bytes: 0, totalBytes: 0, progress: null, segment: null,
    error: '', errorCode: '' });
  pump();
}
function cancel(job) {
  if (active.has(job.id)) active.get(job.id).abort();
  else if (job.status === 'queued') update(job, { status: 'canceled', error: '使用者取消', errorCode: 'CANCELED' });
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
  const title = safeName(job.title);
  let extension = '.mp4';
  if (!processed) {
    try {
      const ext = /\.(mp4|m4v|mov|mkv|ts|webm)(?:$|\?)/i.exec(new URL(source.url).pathname);
      if (ext) extension = '.' + ext[1].toLowerCase();
    } catch { /* filename defaults to mp4 */ }
  }
  return title + '_' + job.id.slice(0, 8) + extension;
}
function triggerSave(bytes, name) {
  const blob = new Blob(Array.isArray(bytes) ? bytes : [bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function saveProcessed(bytes, name) {
  if (directory) {
    const file = await directory.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    try { await stream.write(bytes); await stream.close(); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
  } else {
    if (bytes.length > MAX_BROWSER_BLOB) throw errorWith('MEMORY_LIMIT', '沒有選取資料夾，檔案超過 300 MiB Blob 保存限制');
    triggerSave(bytes, name);
  }
}
function assertOk(response) {
  if (!response.ok) return response.json().catch(() => null).then(data => {
    throw errorWith(data?.error?.code || 'HTTP_' + response.status,
      data?.error?.message || '媒體來源 HTTP ' + response.status);
  });
}
async function fetchBytes(url, profile, signal, max, onRead) {
  if (max <= 0) throw errorWith('MEMORY_LIMIT', '記憶體上限已達');
  const res = await fetch(mediaProxyUrl(url, profile), { signal });
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
  const res = await fetch(mediaProxyUrl(source.url, source.source === 'app' ? 'app' : 'web'), { signal });
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
    if (writer) await writer.close();
    else triggerSave(chunks, name);
    complete = true;
  } finally {
    if (writer && !complete) await writer.abort().catch(() => {});
  }
}
async function runJob(job, signal) {
  update(job, { status: 'resolving', attempts: job.attempts + 1, bytes: 0, totalBytes: 0, error: '', errorCode: '' });
  try {
    const data = job.vid === 'direct'
      ? { variants: [{ url: job.directUrl, source: 'web', codec: 'unknown', contentKey: null }] }
      : await apiJson('/api/source?sid=' + encodeURIComponent(job.seriesId) +
          '&vid=' + encodeURIComponent(job.vid) + '&quality=' + job.quality + '&codec=' + job.codec);
    if (signal.aborted) throw errorWith('CANCELED', '使用者取消');
    const source = data.variants?.[0];
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
      await saveProcessed(out, outputFileName(job, source, true));
    } else {
      const bytes = await fetchBytes(source.url, profile, signal, 320 * 1024 * 1024,
        (n, total) => update(job, { bytes: (job.bytes || 0) + n, totalBytes: total }));
      update(job, { status: 'processing', progress: 0 });
      const out = await convertBytes(bytes, {
        mode: job.mode === 'h264' ? 'h264' : 'copy', contentKey: source.contentKey, signal,
        progress: progress => update(job, { progress })
      });
      if (signal.aborted) throw errorWith('CANCELED', '使用者取消');
      await saveProcessed(out, outputFileName(job, source, true));
    }
    update(job, { status: 'completed', error: '', errorCode: '', progress: 1 });
  } catch (error) {
    const result = classifyError(error);
    update(job, { status: result.code === 'CANCELED' || signal.aborted ? 'canceled' : 'failed',
      errorCode: signal.aborted ? 'CANCELED' : result.code,
      error: signal.aborted ? '使用者已取消' : result.message });
  }
}

$('lookup-form').addEventListener('submit', lookup);
$('choose-folder').addEventListener('click', chooseFolder);
$('add-queue').addEventListener('click', queueSelected);
$('select-all').addEventListener('click', () => {
  if (!series) return;
  selected = new Set(series.episodes.map(e => e.vid)); renderEpisodes();
});
$('select-none').addEventListener('click', () => { selected.clear(); if (series) renderEpisodes(); });
$('episodes').addEventListener('change', e => {
  const checkbox = e.target.closest('input[data-vid]');
  if (!checkbox) return;
  if (checkbox.checked) selected.add(checkbox.dataset.vid);
  else selected.delete(checkbox.dataset.vid);
  renderEpisodes();
});
$('queue').addEventListener('click', e => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const job = jobs.find(j => j.id === button.dataset.id);
  if (!job) return;
  if (button.dataset.action === 'retry') queueRetry(job);
  if (button.dataset.action === 'cancel') cancel(job);
});
$('retry-failed').addEventListener('click', () => {
  for (const job of jobs.filter(j => j.status === 'failed' && j.vid !== 'direct')) queueRetry(job);
});
$('clear-finished').addEventListener('click', () => {
  jobs = jobs.filter(j => !['completed', 'canceled'].includes(j.status));
  saveJobs(); schedulePaint();
});
$('concurrency').addEventListener('change', pump);
if (!window.showDirectoryPicker) {
  $('choose-folder').disabled = true;
  $('folder-status').textContent = '目前瀏覽器不支援資料夾串流寫入';
  $('browser-note').textContent = '此瀏覽器會以 Blob 方式儲存單集，為避免記憶體耗盡，每集限 300 MiB。需要大型檔案時建議使用支援 File System Access API 的瀏覽器。';
} else {
  $('browser-note').textContent = '建議先選擇資料夾，讓大型原始影片直接寫入硬碟。轉檔仍需將媒體載入 FFmpeg.wasm 記憶體。';
}
renderQueue();
