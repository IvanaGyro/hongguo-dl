// SPDX-License-Identifier: GPL-3.0-only
// Temporary structured diagnostics: refuse arbitrary free-form messages.
const MAX_ROWS = 400;
const SAFE_FIELD = /^[a-zA-Z][a-zA-Z0-9]{0,35}$/;
const SAFE_TOKEN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,47}$/;

export function createDiagnosticBuffer(now = () => performance.now()) {
  const started = now();
  let rows = [];
  const value = input => {
    // Only numeric interval pairs are accepted, never arbitrary object JSON.
    if (Array.isArray(input)) {
      if (input.length <= 2048 && input.every(pair => Array.isArray(pair) && pair.length === 2 &&
          pair.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) && pair[1] >= pair[0]))
        return JSON.stringify(input.map(pair => pair.map(n => Math.round(n * 100) / 100)));
      return '[redacted]';
    }
    if (typeof input === 'boolean') return String(input);
    if (typeof input === 'number')
      return Number.isFinite(input) ? String(Math.round(input * 100) / 100) : '?';
    if (typeof input === 'string' && /^\d{3,4}p$/.test(input)) return input;
    if (typeof input !== 'string' || !SAFE_TOKEN.test(input) ||
        /^(?:https?|bearer|cookie|authorization|token)$/i.test(input) ||
        /[a-f0-9]{24,}/i.test(input)) return '[redacted]';
    return input;
  };
  function log(event, fields = {}) {
    if (!SAFE_TOKEN.test(event)) return;
    const params = Object.entries(fields || {}).slice(0, 24)
      .filter(([key, item]) => SAFE_FIELD.test(key) && item !== undefined && item !== null)
      .map(([key, item]) => key + '=' + value(item));
    const elapsed = Math.max(0, Math.round(now() - started));
    rows.push('+' + elapsed + 'ms ' + event + (params.length ? ' ' + params.join(' ') : ''));
    if (rows.length > MAX_ROWS) rows = rows.slice(-MAX_ROWS);
  }
  return { log, clear: () => { rows = []; }, text: () => rows.join('\n'),
    size: () => rows.length };
}

export function createPlaybackDiagnostics({ output, copyButton, clearButton,
  now = () => performance.now(), clipboard = globalThis.navigator?.clipboard }) {
  const buffer = createDiagnosticBuffer(now);
  const refresh = () => {
    output.value = buffer.text();
    output.scrollTop = output.scrollHeight;
  };
  const log = (event, fields) => { buffer.log(event, fields); refresh(); };
  copyButton.addEventListener('click', async () => {
    try {
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
      await clipboard.writeText(buffer.text());
      copyButton.textContent = '已複製';
    } catch {
      output.focus();
      output.select();
      copyButton.textContent = '請手動複製已選取的紀錄';
    }
  });
  clearButton.addEventListener('click', () => {
    buffer.clear();
    refresh();
    copyButton.textContent = '複製 Log';
  });
  log('diagnostics.ready', { version: 2 });
  return { log, text: buffer.text, clear: () => { buffer.clear(); refresh(); } };
}
