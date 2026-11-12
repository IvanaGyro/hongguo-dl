// Private browser-only viewing library. We keep episode identifiers/titles and
// playback positions, never signed media URLs, cookies, DRM keys, or video data.
const SERIES_KEY = 'hongguo-dl-series-history-v1';
const WATCH_KEY = 'hongguo-dl-playback-history-v1';
function read(storage, key, fallback) {
  try { const value = JSON.parse(storage.getItem(key) || 'null'); return value || fallback; }
  catch { return fallback; }
}
function put(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* quota/privacy */ }
}
export function recentSeries(storage) {
  const records = read(storage, SERIES_KEY, []);
  return Array.isArray(records) ? records.filter(x => x?.seriesId && Array.isArray(x.episodes)).slice(0, 35) : [];
}
export function rememberSeries(storage, response) {
  if (!response || response.kind !== 'series' || !/^[0-9]{1,30}$/.test(String(response.seriesId))) return;
  const record = {
    kind: 'series', seriesId: String(response.seriesId),
    title: String(response.title || '未命名短劇').slice(0, 160),
    total: response.total, accessible: response.accessible ?? null,
    episodes: response.episodes.map(ep => ({
      vid: String(ep.vid), index: Number(ep.index), available: ep.available
    })),
    opened: Date.now()
  };
  const next = [record, ...recentSeries(storage).filter(r => r.seriesId !== record.seriesId)].slice(0, 30);
  put(storage, SERIES_KEY, next);
}
export function forgetSeries(storage, seriesId) {
  put(storage, SERIES_KEY, recentSeries(storage).filter(r => r.seriesId !== String(seriesId)));
}
export function watchRecords(storage) {
  const value = read(storage, WATCH_KEY, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
export function playbackKey(seriesId, vid) {
  return String(seriesId || 'direct') + ':' + String(vid);
}
export function rememberPlayback(storage, seriesId, vid, position, duration, completed = false) {
  if (!Number.isFinite(position) || position < 0) return;
  const history = watchRecords(storage);
  const key = playbackKey(seriesId, vid);
  const old = history[key] || {};
  const finished = completed || (duration > 0 && position / duration > 0.95);
  // A newly loaded or paused player sometimes reports time 0 during a
  // source swap. Do not erase an earlier valid position on that event.
  const seconds = !finished && position < 0.5 && old.seconds > 1
    ? old.seconds : position;
  history[key] = {
    seconds: finished ? (Number.isFinite(duration) && duration > 0 ? duration : position) : seconds,
    duration: Number.isFinite(duration) && duration > 0 ? duration : old.duration || 0,
    completed: finished || !!old.completed,
    viewedAt: Date.now()
  };
  const keys = Object.keys(history);
  if (keys.length > 2000) {
    for (const k of keys.sort((a, b) => (history[a].viewedAt || 0) - (history[b].viewedAt || 0)).slice(0, keys.length - 1800))
      delete history[k];
  }
  put(storage, WATCH_KEY, history);
}
export function suggestedEpisode(series, records) {
  const episodes = series?.episodes || [];
  const unfinished = episodes.filter(ep => !records[playbackKey(series.seriesId, ep.vid)]?.completed);
  const partlyViewed = unfinished
    .filter(ep => records[playbackKey(series.seriesId, ep.vid)]?.seconds > 1)
    .sort((a, b) => (records[playbackKey(series.seriesId, b.vid)].viewedAt || 0) -
      (records[playbackKey(series.seriesId, a.vid)].viewedAt || 0));
  return partlyViewed[0] || unfinished[0] || episodes[0] || null;
}
