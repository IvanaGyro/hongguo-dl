import test from 'node:test';
import assert from 'node:assert/strict';
import { withRangeDeadline } from '../../../src/range-deadline.js';

test('metadata progress cannot keep its hard total cap alive forever', async () => {
  let canceled = false;
  await assert.rejects(withRangeDeadline(async (signal, progress) => {
    signal.addEventListener('abort', () => { canceled = true; });
    const timer = setInterval(progress, 10);
    try { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
    finally { clearInterval(timer); }
  }, undefined, 40, { maxDurationMs: 100 }), { code: 'CENC_RANGE_TIMEOUT' });
  assert.equal(canceled, true);
});
