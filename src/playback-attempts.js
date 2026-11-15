export const PLAYBACK_ATTEMPT_LIMIT = 20;
export const playbackStepNames = {
  'device-register': '裝置註冊', 'source-web': '網頁片源候選查詢', 'source-app': 'App 片源候選查詢',
  'source-auto': '片源候選查詢', 'cdn-probe': 'CDN 探測', metadata: 'MP4 播放資訊讀取',
  'media-download': '影片資料下載', processing: '解密／轉碼', playback: '播放器載入／解碼'
};
export function createPlaybackAttempts() {
  const counts = new Map();
  const count = step => counts.get(step) || 0;
  const decorate = (error, step) => Object.assign(error, { retryStep: step, stepAttempt: count(step) });
  const check = step => {
    if (count(step) >= PLAYBACK_ATTEMPT_LIMIT) throw decorate(Object.assign(
      new Error((playbackStepNames[step] || step) + '已達 20 次嘗試上限，請稍後重新整理頁面再試'),
      { code: 'PLAYBACK_STEP_LIMIT' }), step);
  };
  return {
    count, decorate, check,
    next(step) { counts.set(step, count(step) + 1); return count(step); },
    begin(step) {
      check(step);
      counts.set(step, count(step) + 1);
      return count(step);
    }
  };
}
