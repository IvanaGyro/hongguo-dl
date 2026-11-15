// Beta status: name the operation and its own attempt, never a previous failure.
const attemptText = fields => fields.attempt ? ` · 第 ${fields.attempt}/20 次` : '';
const candidateText = fields => fields.candidate ? ` · CDN #${fields.candidate}` : '';
const rangeText = fields => Number.isSafeInteger(fields.offset) && fields.bytes > 0
  ? ` · bytes ${fields.offset}–${fields.offset + fields.bytes - 1}` : '';
const sourceNames = {
  'worker-capabilities': '確認 Worker API 能力（/api/health）',
  'device-register': '初始化播放裝置／等待註冊（POST /api/device）',
  'source-web': '查詢網頁片源候選（/api/source）',
  'source-app': '查詢 App 片源／畫質候選（/api/source）',
  'source-auto': '查詢片源／畫質候選（/api/source）'
};
export function playbackStage(stage, fields = {}) {
  if (stage === 'source.wait') {
    const tasks = (fields.tasks || []).filter(task => sourceNames[task.phase]);
    if (!tasks.length) return null;
    return { layer: 1, phase: tasks.length > 1 ? 'source-parallel' : tasks[0].phase,
      message: tasks.map(task => sourceNames[task.phase] + attemptText(task)).join('；同時：') };
  }
  const part = fields.part === 'moov' ? 'moov 索引／加密資訊'
    : fields.part === 'locate-moov' ? 'MP4 box 標頭、定位 moov' : 'MP4 檔頭／格式資訊';
  const http = fields.status ? ` · HTTP ${fields.status}` : '';
  const names = {
    'cdn.selected': '準備探測 CDN 候選',
    'cdn.probe': fields.mode === 'whole-file' ? '準備從 CDN 下載整集／分片' : '探測 CDN 可讀性（Range bytes=0–15）',
    metadata: '開始讀取 MP4 檔案資訊（不是查詢片源 API）',
    'range.request': '讀取 ' + part + rangeText(fields),
    'range.response': '已收到 CDN HTTP 回應，正在下載 ' + part + rangeText(fields) + http,
    'range.progress': '正在下載 ' + part + rangeText(fields) + ` · 已收到 ${fields.receivedBytes || 0} bytes`,
    'range.retry': '重試讀取 ' + part + rangeText(fields) + http,
    'media-range-retry': '重試下載影片內容' + rangeText(fields) + http,
    'media.transport.fallback': 'CDN 直連失敗，改由 Worker 代理讀取' + http,
  };
  return names[stage] ? { layer: 1, phase: stage, message: names[stage] + candidateText(fields) + attemptText(fields) } : null;
}
export function processingMessage(codec) {
  return codec === 'bytevc2' ? 'CENC 解密、ByteVC2 解碼並轉碼為 H.264…' : 'CENC 解密並重新封裝 fMP4…';
}
export function mediaReadMessage(fields) {
  return '下載影片內容，等待必要位元組' + rangeText(fields) + candidateText(fields) + attemptText(fields) + '…';
}
