// Enforce the independent CENC demux experiment as a regression test.
// A green workflow must mean MSE actually rendered frames, not merely that
// the diagnostic harness finished collecting JSON.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function assertCencMatrix(results) {
  const summaries = [];
  for (const engine of ['chromium', 'firefox']) {
    const rows = results.filter(r => r.engine === engine);
    assert(rows.some(r => typeof r.version === 'string'), engine + ': missing browser version');
    const find = (file, mode) => {
      const item = rows.find(r => r.file === file && r.mode === mode);
      assert(item, engine + ': missing ' + file + '/' + mode);
      return item;
    };
    const plays = (file, mode) => {
      const item = find(file, mode);
      assert(!item.error, engine + ': ' + file + '/' + mode + ': ' + item.error);
      assert(item.time > 0.25 && item.width === 480 && item.frames > 0,
        engine + ': ' + file + '/' + mode + ' must render frames, got ' +
        JSON.stringify({ time: item.time, width: item.width, frames: item.frames }));
      return item;
    };
    // Clear controls prove the browser decoder works and MSE is functional.
    plays('clear.mp4', 'direct');
    plays('clear-fragmented.mp4', 'direct');
    plays('clear-fragmented.mp4', 'mse');
    // Same synthetic key, same encrypted fragmented input, two demux paths.
    const encrypted = plays('shaka-cenc.mp4', 'mse');
    assert(encrypted.events?.some(e => e.keyStatus?.includes('usable')),
      engine + ': encrypted MSE playback did not have a usable CDM key');
    for (const [file, mode] of [
      ['shaka-cenc.mp4', 'direct'], ['ffmpeg-cenc.mp4', 'direct'],
      ['ffmpeg-cenc.mp4', 'mse'], ['clear.mp4', 'mse']
    ]) {
      const item = find(file, mode);
      assert(!(item.time > 0.25 && item.frames > 0),
        engine + ': unexpected playback of ' + file + '/' + mode +
        '; revisit the documented browser matrix instead of ignoring it');
    }
    summaries.push({ engine, encryptedMseFrames: encrypted.frames,
      encryptedMseSeconds: encrypted.time });
  }
  return summaries;
}

function parseJsonl(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4,
    'Usage: node diagnostics/assert-cenc-matrix.mjs chromium.jsonl firefox.jsonl');
  console.log('CENC native MSE matrix PASSED:',
    JSON.stringify(assertCencMatrix([
      ...parseJsonl(process.argv[2]), ...parseJsonl(process.argv[3])
    ])));
}
