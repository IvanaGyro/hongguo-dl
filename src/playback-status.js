import { mediaReadMessage, processingMessage } from './playback-stage.js';
// Current foreground wait only. Error/retry history remains in diagnostics.
export function createPlaybackStatus({ render, log = () => {} }) {
  const names = { 1: '下載', 2: '解密／解碼', 3: '播放' };
  let base = null, reads = 0, readFields = {}, visible = true, last = '';
  const paint = () => {
    const explicitDownload = ['media-range-retry', 'media.transport.fallback'].includes(base?.phase);
    const state = reads > 0 && !explicitDownload ? { layer: 1, phase: 'media-bytes', message: mediaReadMessage(readFields), ...readFields } : base;
    const text = visible && state ? names[state.layer] + '｜' + state.message : '';
    if (text === last) return;
    last = text;
    log('playback.wait', { layer: state && visible ? state.layer : 0, phase: state && visible ? state.phase : 'none',
      ...(state && visible ? { candidate: state.candidate, attempt: state.attempt, offset: state.offset, bytes: state.bytes } : {}) });
    render(text);
  };
  return {
    update(layer, message, phase = 'prepare') { base = { layer, message, phase }; paint(); },
    downloadAttempt(fields) {
      readFields = { ...readFields, candidate: fields.candidate, codec: fields.codec, attempt: fields.attempt };
      if (base?.phase === 'media-range-retry') base = { layer: 2, phase: 'processing', message: processingMessage(fields.codec) };
      paint();
    },
    mediaRead(pending, fields = {}) {
      readFields = fields;
      reads = Math.max(0, Number(pending) || 0);
      if (!reads) base = { layer: 2, phase: 'processing', message: processingMessage(fields.codec) + (fields.processingAttempt ? ' · 第 ' + fields.processingAttempt + '/20 次' : '') };
      paint();
    },
    waiting() { visible = true; base ||= { layer: 3, phase: 'buffer', message: '正在等待影片緩衝與畫面…' }; paint(); },
    playing() { visible = false; paint(); },
    reset() { base = null; reads = 0; readFields = {}; visible = true; last = ''; }
  };
}
