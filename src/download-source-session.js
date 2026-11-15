// Layer 1 owns source discovery, candidate URLs, failure history and refresh.
// One session represents requested media, independently of how it is consumed.
import { errorWith, isHlsUrl } from './logic.js';
import { codecId, qualityId, playbackRendition, untriedPlaybackRendition, sourceQueryForPlayback } from './source-options.js';
import { sameTierPlaybackCandidates, isRecoverableMediaSourceError } from './cenc-source-fallback.js';

const sources = new WeakMap();
const handles = new WeakMap();
export const downloadSource = handle => sources.get(handle) || handle;
function handleFor(source) {
  if (handles.has(source)) return handles.get(source);
  const { url, userAgent, ...metadata } = source;
  const handle = Object.freeze({ ...metadata, hls: isHlsUrl(url) });
  sources.set(handle, source);
  handles.set(source, handle);
  return handle;
}

export function createDownloadSourceSession({ sourceFor, seriesId, episode, log = () => {}, ageMs = () => 0 }) {
  let variants = null, winners = null, view = null, tier = null, current = null, expansion = null;
  let refreshes = 0, selected = 0, unavailable = false;
  const tried = new Set(), ids = new Map();
  const remaining = preferences => tier ? sameTierPlaybackCandidates(variants || [], preferences, tier)
    .filter(source => !tried.has(source.url)) : (variants || []).filter(source => !tried.has(source.url));
  const merge = extras => {
    const seen = new Set((variants || []).map(source => source.url));
    let added = 0;
    for (const source of extras || []) if (source?.url && !seen.has(source.url)) {
      seen.add(source.url); variants.push(source); view?.push(handleFor(source)); added++;
    }
    return added;
  };
  return {
    async list({ quality, codec, signal, onStage, report = () => {}, refresh = false, onUpdate = () => {} }) {
      log('source.resolve.begin', { attempt: selected + 1, quality, codec, elapsedMs: ageMs() });
      if (selected && !tier && expansion) await expansion;
      const sameList = Boolean(variants && selected && remaining({ quality, codec }).length && !refresh);
      const refreshing = Boolean(selected && !sameList);
      if (refreshing && refreshes >= 20) throw Object.assign(errorWith('PLAYBACK_STEP_LIMIT',
        '同畫質片源刷新已達 20 次上限；請稍後重新整理頁面再試。'), { retryStep: 'source-auto', stepAttempt: 20 });
      if (refreshing) {
        log('source.list.refresh', { attempt: selected + 1, tier: tier?.quality || quality, refreshed: refreshes });
        report('正在重新取得同畫質影片來源…');
      }
      const query = sourceQueryForPlayback(quality);
      let list;
      if (sameList) list = { variants, winnerVariants: winners };
      else if (episode.vid === 'direct') list = { variants: [{ url: episode.url, source: 'web', codec: 'unknown', contentKey: null }] };
      else {
        try { list = await sourceFor(seriesId, episode.vid, query.quality, query.codec, signal,
          { refresh: Boolean(refresh || selected), onStage }); }
        catch (error) { throw Object.assign(error, { stage: 'source-api' }); }
      }
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (variants !== list.variants) {
        variants = list.variants || [];
        view = variants.map(handleFor);
      }
      winners = list.winnerVariants || variants.slice();
      if (list.lateVariants && (refreshing || (quality !== 'auto' || codec !== 'auto') &&
          !variants.some(source => (quality === 'auto' || qualityId(source) === quality) &&
            (codec === 'auto' || codecId(source.codec) === codec)))) {
        report('等待另一條片源查詢補齊所選畫質（網頁／App API）…');
        merge(await list.lateVariants);
        if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      }
      if (refreshing) {
        const fresh = remaining({ quality, codec });
        if (!fresh.length) {
          log('source.list.stale', { variants: variants.length });
          throw errorWith('CENC_SOURCE_EXHAUSTED', '刷新未取得同畫質／編碼的新候選網址，已停止重試失敗來源。');
        }
        refreshes++;
        log('source.list.refreshed', { variants: variants.length, freshCandidates: fresh.length, refreshed: refreshes });
      }
      log('source.list.ready', { variants: variants.length, fromCache: sameList || Boolean(list.fromCache),
        sharedRequest: Boolean(list.shared), elapsedMs: ageMs() });
      if (list.lateVariants) {
        const currentVariants = variants;
        expansion = Promise.resolve(list.lateVariants).then(extras => {
          if (signal.aborted || currentVariants !== variants) return;
          const added = merge(extras);
          if (added) { log('source.list.extended', { added, variants: variants.length }); onUpdate(view); }
        }).catch(() => {});
      } else expansion = null;
      return { variants: view, winnerVariants: winners.map(handleFor), attempts: list.attempts };
    },
    acquire(preferences, { mimeSupport, mseSupport, canTranscodeBvc2 }) {
      if (current && !unavailable) return current;
      const candidates = tier ? remaining(preferences) : preferences.quality === 'auto' ? winners : variants;
      let resolved = playbackRendition(candidates, preferences, mimeSupport, 0, canTranscodeBvc2, mseSupport);
      if (tried.size) resolved = untriedPlaybackRendition(candidates, preferences, mimeSupport, tried, canTranscodeBvc2, mseSupport) || resolved;
      const source = resolved.source;
      if (!source?.url || tried.has(source.url)) {
        if (tier) throw errorWith('CENC_SOURCE_EXHAUSTED', '已無與原本畫質／編碼相同的可用官方影片來源。');
        return { ...resolved, source: null, candidate: 0 };
      }
      selected++; unavailable = false;
      if (!ids.has(source.url)) ids.set(source.url, ids.size + 1);
      if (!tier && ['bytevc2', 'h264', 'hevc'].includes(codecId(source.codec)) && !isHlsUrl(source.url))
        tier = { codec: codecId(source.codec), quality: qualityId(source) };
      current = { ...resolved, source: handleFor(source), candidate: ids.get(source.url) };
      log('source.selected', { candidate: current.candidate, episode: Number(episode.index) || 0,
        quality: qualityId(source) || 'unknown', codec: codecId(source.codec) || 'unknown',
        encrypted: Boolean(source.contentKey), hls: current.source.hls,
        fallback: resolved.fallback, attempt: selected, elapsedMs: ageMs() });
      return current;
    },
    failed(code) {
      if (!isRecoverableMediaSourceError(code) || !current) return false;
      tried.add(downloadSource(current.source).url); unavailable = true;
      return episode.vid !== 'direct' && refreshes < 20;
    },
    get current() { return current; },
    get tier() { return tier; },
    get failedCount() { return tried.size; },
    get refreshCount() { return refreshes; },
    get variants() { return view; }
  };
}
