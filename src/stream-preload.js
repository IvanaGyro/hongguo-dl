// One next episode: download independently, gate CPU work, and retain a bounded
// prefix of clear fMP4 until the visible player takes ownership of its MSE.
export function createStreamPreload({ enabled = false, post, onStage = () => {},
  budget = 4 * 1024 * 1024 } = {}) {
  let staging = enabled, processing = !enabled, started = !enabled;
  let units = [], bytes = 0, held = null, closed = false;
  const release = () => {
    if (held && processing && (!staging || bytes < budget)) {
      post({ type: 'ack', id: held }); held = null;
    }
  };
  return {
    get active() { return staging; },
    capture(data) {
      if (!staging || closed || !['init', 'media', 'done'].includes(data.type)) return false;
      units.push(data);
      if (data.type !== 'done') {
        bytes += data.bytes.byteLength;
        held = data.id;
        release();
      }
      onStage('preload.buffer', { bytes, units: units.length,
        ready: units.some(unit => unit.type === 'media') });
      return true;
    },
    startProcessing() {
      if (closed) return;
      processing = true;
      if (!started) { started = true; post({ type: 'process' }); }
      release();
    },
    pauseProcessing() { if (staging) processing = false; },
    activate() {
      if (closed) throw Object.assign(new Error('Preload canceled'), { code: 'CANCELED' });
      const pending = units; units = []; bytes = 0;
      staging = false;
      // The retained final ACK belongs to the last staged unit. Its replay
      // must append that unit before releasing the worker again.
      held = null;
      this.startProcessing();
      return pending;
    },
    close() { closed = true; units = []; bytes = 0; held = null; }
  };
}
