// Export only the entries selected in the *download queue*. All bytes come
// from the locally staged episode files, not a second network-fetch pipeline.
import { zipReadableStream } from './zip.js';
import { concatLosslessly } from './ffmpeg.js';
import { collectionFileName, episodeFileName } from './naming.js';
import { errorWith, classifyError } from './logic.js';

export function orderQueueSelection(jobs) {
  return [...jobs].sort((a, b) =>
    String(a.seriesId || '').localeCompare(String(b.seriesId || '')) ||
    Number(a.index) - Number(b.index) ||
    String(a.id).localeCompare(String(b.id)));
}
async function waitUntilStaged(job, readFile, currentStatus, signal, onStatus) {
  for (;;) {
    if (signal?.aborted) throw errorWith('CANCELED', '已取消匯出');
    const item = await readFile(job.id);
    if (item?.blob) return item;
    const status = currentStatus(job.id);
    if (!['queued', 'resolving', 'downloading', 'processing', 'retrying'].includes(status))
      throw errorWith('MISSING_DOWNLOAD', '第 ' + job.index + ' 集尚未下載完成，或暫存已被清除');
    onStatus?.('等待第 ' + job.index + ' 集下載完成…');
    await new Promise(resolve => setTimeout(resolve, 600));
  }
}
export async function exportQueue({
  jobs, type, readFile, currentStatus, signal, saveArchive, saveMp4, onStatus
}) {
  if (!jobs?.length) throw errorWith('NO_SELECTION', '請勾選要匯出的佇列項目');
  const ordered = orderQueueSelection(jobs);
  if (type === 'mp4') {
    if (new Set(ordered.map(j => j.seriesId)).size !== 1)
      throw errorWith('INCOMPATIBLE_MEDIA', 'MP4 無損合併僅限同一部影集，跨影集請使用 ZIP');
    const inputs = [];
    let prior = null;
    for (const [index, job] of ordered.entries()) {
      const stored = await waitUntilStaged(job, readFile, currentStatus, signal, onStatus);
      if (!/\.mp4$/i.test(stored.filename))
        throw errorWith('INCOMPATIBLE_MEDIA', '第 ' + job.index + ' 集不是 MP4，無法無損合併');
      const signature = [stored.codec || '', stored.width || '', stored.height || ''].join(':');
      if (prior && signature !== prior && signature !== '::' && prior !== '::')
        throw errorWith('INCOMPATIBLE_MEDIA', '分集編碼或解析度不同，請使用 ZIP');
      prior = signature;
      onStatus?.('準備 MP4 · ' + (index + 1) + '/' + ordered.length);
      if (inputs.reduce((n, x) => n + x.length, 0) + stored.blob.size > 160 * 1024 * 1024)
        throw errorWith('FFMPEG_LIMIT', '無損合併限 160 MiB；大量分集請使用 ZIP');
      inputs.push(new Uint8Array(await stored.blob.arrayBuffer()));
    }
    const bytes = inputs.length === 1 ? inputs[0] : await concatLosslessly(inputs, { signal,
      progress: p => onStatus?.('無損合併 · ' + Math.round(100 * p) + '%') });
    const filename = inputs.length === 1 ? episodeFileName(ordered[0], '.mp4') :
      collectionFileName(ordered, 'mp4');
    await saveMp4(bytes, filename);
    onStatus?.('MP4 已匯出 · ' + ordered.length + ' 集');
    return { completed: ordered.length, failed: 0 };
  }
  if (type !== 'zip') throw new TypeError('Unsupported queue export');
  let success = 0, failed = 0;
  async function* items() {
    for (const [index, job] of ordered.entries()) {
      onStatus?.('打包 ZIP · ' + (index + 1) + '/' + ordered.length);
      try {
        const item = await waitUntilStaged(job, readFile, currentStatus, signal, onStatus);
        success++;
        yield { name: item.filename, open: async () => item.blob.stream() };
      } catch (err) {
        if (signal?.aborted || err.code === 'CANCELED') throw err;
        failed++;
        const text = '第 ' + job.index + ' 集：' + classifyError(err).message;
        yield { name: '第' + String(job.index).padStart(3, '0') + '集_未完成.txt',
          open: async () => new Blob([text]).stream() };
      }
    }
  }
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const stream = zipReadableStream(items(), { signal, onComplete: resolveDone, onError: rejectDone });
  await saveArchive(stream, collectionFileName(ordered, 'zip'));
  await done;
  onStatus?.('ZIP 完成 · ' + success + ' 集' + (failed ? ' · ' + failed + ' 集未完成' : ''));
  return { completed: success, failed };
}
