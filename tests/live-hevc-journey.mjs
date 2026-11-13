// SPDX-License-Identifier: GPL-3.0-only
// Real public HEVC episode lifecycle: 120s remote seek -> saved position ->
// full document reload -> indexed resume -> playback to the actual media EOF.
// Never log signed source URLs, content keys, media bytes or decoded samples.
import assert from 'node:assert/strict';

const WATCH_KEY = 'hongguo-dl-playback-history-v1';
const readCurrent = () => {
  const video = document.querySelector('#player-video');
  const currentButton = document.querySelector('#episodes button.current[data-play-vid]');
  const history = JSON.parse(localStorage.getItem('hongguo-dl-playback-history-v1') || '{}');
  const videoId = currentButton?.dataset.playVid || null;
  const entry = Object.entries(history).find(([key]) => key.endsWith(':' + videoId));
  return {
    videoId, historyKey: entry?.[0] || null,
    savedSeconds: entry?.[1]?.seconds || 0, completed: Boolean(entry?.[1]?.completed),
    currentTime: Number((video?.currentTime || 0).toFixed(3)),
    duration: Number.isFinite(video?.duration) ? Number(video.duration.toFixed(3)) : null,
    totalFrames: video?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
    mediaError: video?.error?.code ?? null, ended: Boolean(video?.ended),
    paused: Boolean(video?.paused)
  };
};

export async function verifyRealHevcReloadAndEof(page) {
  // Video has just passed the unbuffered indexed seek to ~120 s. The player
  // records watch progress on timeupdate; do not inject saved timestamps.
  await page.waitForFunction(() => {
    const button = document.querySelector('#episodes button.current[data-play-vid]');
    const history = JSON.parse(localStorage.getItem('hongguo-dl-playback-history-v1') || '{}');
    const entry = Object.entries(history).find(([key]) =>
      key.endsWith(':' + button?.dataset.playVid))?.[1];
    return entry?.seconds > 115 && !entry?.completed;
  }, null, { timeout: 20000 });
  const before = await page.evaluate(readCurrent);
  assert(before.videoId && before.historyKey && before.savedSeconds > 115);
  assert(before.duration > before.savedSeconds + 5,
    'Episode is too short or already completed for reload / EOF acceptance');
  console.log('macOS WebKit reload lifecycle before:', JSON.stringify({
    savedSeconds: before.savedSeconds, currentTime: before.currentTime,
    duration: before.duration, completed: before.completed
  }));

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() =>
    document.querySelector('#series-title')?.textContent?.includes('nova'),
  null, { timeout: 30000 });
  await page.locator('#mode-play').click();
  await page.locator('#player-panel').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(({ expected, episode }) => {
    const video = document.querySelector('#player-video');
    const active = document.querySelector('#episodes button.current[data-play-vid]');
    const frames = video?.getVideoPlaybackQuality?.().totalVideoFrames || 0;
    const status = document.querySelector('#player-status')?.textContent || '';
    return (active?.dataset.playVid === episode &&
      video?.readyState >= 2 && video?.currentTime >= expected - 4 &&
      video?.currentTime < expected + 25 && frames > 2) ||
      /已停止播放|無法播放|失敗/.test(status);
  }, { expected: before.savedSeconds, episode: before.videoId },
  { timeout: 80000 }).catch(() => {});
  const after = await page.evaluate(readCurrent);
  console.log('macOS WebKit reload lifecycle after:', JSON.stringify({
    sameEpisode: after.videoId === before.videoId,
    currentTime: after.currentTime, savedSeconds: after.savedSeconds,
    totalFrames: after.totalFrames, mediaError: after.mediaError
  }));
  assert.equal(after.videoId, before.videoId, 'Reload resumed the wrong episode');
  assert(after.currentTime >= before.savedSeconds - 4 &&
    after.currentTime < before.savedSeconds + 25 &&
    after.totalFrames > 2 && after.mediaError == null,
  'Real HEVC reloaded CENC stream did not resume with newly decoded frames');
  console.log('PASS real Hongguo HEVC reload + indexed resume');

  // Let the actual media reach EOF (no synthetic ended event, no direct
  // currentTime = duration jump). This exercises final fragments and Worker
  // end-of-stream propagation rather than only metadata.
  await page.waitForFunction(() => {
    const v = document.querySelector('#player-video');
    const status = document.querySelector('#player-status')?.textContent || '';
    return v?.ended || /播放完成|已停止播放|無法播放/.test(status);
  }, null, { timeout: 135000 }).catch(() => {});
  const finished = await page.evaluate(readCurrent);
  console.log('macOS WebKit real HEVC EOF:', JSON.stringify({
    sameEpisode: finished.videoId === before.videoId,
    atEnd: finished.ended, currentTime: finished.currentTime,
    duration: finished.duration, completedRecord: finished.completed,
    mediaError: finished.mediaError
  }));
  assert(finished.ended && finished.completed &&
    finished.mediaError == null && finished.currentTime >= finished.duration - 2,
    'Real HEVC playback did not reach EOF and persist completed watch progress');
  console.log('PASS real Hongguo HEVC actual EOF and persisted completion');
}
