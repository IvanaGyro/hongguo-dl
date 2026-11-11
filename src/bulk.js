// Batch orchestration, independent of the browser UI. A ZIP is emitted as a
// single ZIP64 stream; a lossless concat uses FFmpeg and is memory-limited.
import { isHlsUrl, safeName, errorWith, classifyError } from './logic.js';
import { recordFailure } from './retry.js';
import { episodeCacheKey } from './media-cache.js';
import { zipReadableStream } from './zip.js';
import { convertHls, convertBytes, concatLosslessly } from './ffmpeg.js';

const PER_EPISODE_LIMIT = 260 * 1024 * 1024;
const CONCAT_INPUT_LIMIT = 160 * 1024 * 1024;
export function orderedEpisodes(episodes) {
  return [...episodes].sort((a, b) => Number(a.index) - Number(b.index));
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(errorWith('CANCELED', '使用者取消'));
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(errorWith('CANCELED', '使用者取消')); };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
export async function withDownloadRetries(task, { signal, onRetry } = {}) {
  let previous;
  while (true) {
    if (signal?.aborted) throw errorWith('CANCELED', '使用者取消');
    try { return await task(); }
    catch (error) {
      const { code, message } = classifyError(error);
      if (code === 'CANCELED' || signal?.aborted) throw errorWith('CANCELED', '使用者取消');
      previous = recordFailure(previous, { code, message }, 3);
      if (!previous.retry) throw errorWith(code, message);
      onRetry?.({ code, message, streak: previous.streak, attempts: previous.attempts });
      await delay(previous.delay, signal);
    }
  }
}
function extensionFor(source, processed) {
  if (processed) return '.mp4';
  try { return /\.(mp4|m4v|mov|mkv|ts|webm)(?:$|\?)/i.exec(new URL(source.url).pathname)?.[0]?.replace(/\?.*/, '')?.toLowerCase() || '.mp4'; }
  catch { return '.mp4'; }
}
export async function getEpisodeBytes({
  series, episode, type, quality, codec, outputMode, sourceFor, fetchBytes,
  cache, signal, onUpdate
}) {
  const key = episodeCacheKey(series.seriesId, episode.vid, quality, codec);
  const cached = outputMode === 'h264' ? null : cache.get(key);
  if (cached) {
    onUpdate?.('第 ' + episode.index + ' 集：共用記憶體快取');
    return { bytes: new Uint8Array(await cached.arrayBuffer()), ext: '.mp4', codec: null };
  }
  const sources = episode.vid === 'direct'
    ? { variants: [{ url: episode.url, codec: 'unknown', source: 'web', contentKey: null }] }
    : await sourceFor(series.seriesId, episode.vid, quality, codec);
  const source = sources.variants?.[0];
  if (!source?.url) throw errorWith('SOURCE_UNAVAILABLE', '找不到第 ' + episode.index + ' 集的媒體來源');
  const profile = source.source === 'app' ? 'app' : 'web';
  const hls = isHlsUrl(source.url);
  const process = type === 'concat' || hls || !!source.contentKey || outputMode !== 'original';
  let bytes;
  if (hls) {
    bytes = await convertHls(source.url, {
      mode: outputMode === 'h264' ? 'h264' : 'copy', contentKey: source.contentKey, signal,
      fetchBytes: (uri, sig, max) => fetchBytes(uri, profile, sig, Math.min(max, PER_EPISODE_LIMIT)),
      segmentProgress: p => onUpdate?.('第 ' + episode.index + ' 集：分片 ' + p.current + '/' + p.total)
    });
  } else {
    const raw = await fetchBytes(source.url, profile, signal, PER_EPISODE_LIMIT);
    bytes = process ? await convertBytes(raw, {
      mode: outputMode === 'h264' ? 'h264' : 'copy', contentKey: source.contentKey, signal
    }) : raw;
  }
  if (!bytes?.length) throw errorWith('EMPTY_MEDIA', '第 ' + episode.index + ' 集下載結果為空');
  const ext = extensionFor(source, process);
  if (ext === '.mp4' && outputMode !== 'h264')
    cache.put(key, new Blob([bytes], { type: 'video/mp4' }));
  return { bytes, ext, codec: source.codec, width: source.width, height: source.height };
}
export async function runBulk({
  type, series, episodes, quality, codec, outputMode, sourceFor, fetchBytes, cache,
  signal, saveZip, saveOutput, onStatus
}) {
  if (!episodes.length) throw errorWith('NO_SELECTION', '請至少選擇一集');
  const ordered = orderedEpisodes(episodes);
  const title = safeName(series.title || '影片');
  const request = ep => withDownloadRetries(() => getEpisodeBytes({
    series, episode: ep, type, quality, codec, outputMode, sourceFor, fetchBytes,
    cache, signal, onUpdate: onStatus
  }), { signal, onRetry: x => onStatus?.('第 ' + ep.index + ' 集重試：' +
    x.message + '（連續相同錯誤 ' + x.streak + '/3）') });

  if (type === 'concat') {
    if (ordered.length < 2) throw errorWith('FFMPEG_ERROR', '無損合併至少需要兩集');
    const inputs = [];
    let total = 0, previous;
    for (let i = 0; i < ordered.length; i++) {
      if (signal?.aborted) throw errorWith('CANCELED', '使用者取消');
      onStatus?.('無損合併：準備第 ' + (i + 1) + ' / ' + ordered.length + ' 集');
      const episode = await request(ordered[i]);
      // Concat demuxer cannot safely stream-copy files with mismatched codecs
      // or frame dimensions. Prefer a clear error over a corrupt final video.
      const format = [episode.codec || '', episode.width || '', episode.height || ''].join(':');
      if (previous && format !== previous && format !== '::' && previous !== '::')
        throw errorWith('INCOMPATIBLE_MEDIA', '分集的編碼或畫面尺寸不同，無法無損合併；請使用 ZIP');
      previous = format;
      total += episode.bytes.length;
      if (total > CONCAT_INPUT_LIMIT) throw errorWith('FFMPEG_LIMIT',
        '合併輸入超過 160 MiB 的瀏覽器 FFmpeg 記憶體上限；多集請使用串流 ZIP');
      inputs.push(episode.bytes);
    }
    onStatus?.('正在用 FFmpeg 無損接合 ' + inputs.length + ' 集（不包含字幕）');
    const result = await concatLosslessly(inputs, { signal,
      progress: x => onStatus?.('無損接合：' + Math.round(x * 100) + '%') });
    await saveOutput(result, title + '_第' + ordered[0].index + '-' +
      ordered[ordered.length - 1].index + '集_無損合併.mp4');
    onStatus?.('完成：' + ordered.length + ' 集已無損合併');
    return;
  }
  if (type !== 'zip') throw new TypeError('Unknown batch operation');
  let completed = 0, failed = 0;
  async function* entries() {
    for (const ep of ordered) {
      if (signal?.aborted) throw errorWith('CANCELED', '使用者取消');
      onStatus?.('ZIP：準備第 ' + ep.index + ' 集，' + (completed + failed) + '/' + ordered.length);
      try {
        const result = await request(ep);
        const filename = safeName(title + '_第' + String(ep.index).padStart(3, '0') + '集') + result.ext;
        yield { name: filename, open: async () => new Blob([result.bytes]).stream() };
        completed++;
      } catch (error) {
        if (signal?.aborted || error.code === 'CANCELED') throw error;
        failed++;
        // Report skipped episodes inside a valid archive rather than silently
        // exporting an incomplete or corrupt ZIP.
        const reason = '第 ' + ep.index + ' 集失敗：' + classifyError(error).message;
        onStatus?.(reason + '；繼續其餘分集');
        yield { name: '第' + String(ep.index).padStart(3, '0') + '集_下載失敗.txt',
          open: async () => new Blob([reason], { type: 'text/plain' }).stream() };
      }
    }
  }
  let resolveDone, rejectDone;
  const finished = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const stream = zipReadableStream(entries(), { signal,
    onEntry: () => onStatus?.('ZIP：' + (completed + failed) + '/' + ordered.length + ' 集已寫入'),
    onComplete: resolveDone,
    onError: rejectDone
  });
  await saveZip(stream, title + '_第' + ordered[0].index + '-' + ordered[ordered.length - 1].index + '集.zip');
  onStatus?.('ZIP 串流已啟動；正在依集數順序寫入 ZIP…');
  await finished;
  onStatus?.('ZIP 已完成：' + completed + ' 集成功' +
    (failed ? '、' + failed + ' 集失敗（ZIP 內含原因說明）' : '') + '。');
}
