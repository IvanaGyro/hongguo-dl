import test from 'node:test';
import assert from 'node:assert/strict';
import { orderQueueSelection, exportQueue } from '../../../src/queue-export.js';

test('queue export chooses queue entries sorted by series and episode, not current page selection', () => {
  const entries = [
    { id: 'b', seriesId: '9', index: 10 },
    { id: 'a', seriesId: '9', index: 2 },
    { id: 'c', seriesId: '8', index: 1 }
  ];
  assert.deepEqual(orderQueueSelection(entries).map(x => x.id), ['c', 'a', 'b']);
});

test('MP4 queue export of one staged file does not re-fetch or transcode', async () => {
  const job = { id: 'abc', vid: '123', seriesId: '42', index: 1, seriesTotal: 100,
    seriesTitle: '短劇', mode: 'original', codec: 'h264', quality: 'auto' };
  const file = { id: 'abc', filename: '短劇_第001集.mp4',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' }), codec: 'h264' };
  let result;
  const report = await exportQueue({
    jobs: [job], type: 'mp4',
    readFile: async id => id === 'abc' ? file : null,
    currentStatus: () => 'completed',
    saveMp4: async (bytes, filename) => { result = { bytes, filename }; }
  });
  assert.equal(report.completed, 1);
  assert.equal(result.filename, '短劇.E001.mp4');
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
});
