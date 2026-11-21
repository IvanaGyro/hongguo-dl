// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaProcessor } from '../../../src/media-processor.js';
import { readWholeFile, createRetainedSources } from '../../../src/whole-file-read.js';
import { KEY, URL_A, faststart, cdn } from '../helpers/whole-file-media.mjs';

test('readWholeFile on a retained Worker continues its source without re-reading the prefix', async () => {
  const network = cdn(faststart);
  const processor = createMediaProcessor({ bridge: 'cenc', fetchImpl: network.fetchImpl });
  processor.onmetadata = () => {};
  processor.need({ source: { url: URL_A, bridge: 'cenc', key: KEY }, output: 'metadata' });
  await new Promise(resolve => { processor.onmetadata = resolve; });
  const progress = [];
  const bytes = await readWholeFile({ processor, maxBytes: 1024 * 1024,
    onProgress: (received, total) => progress.push([received, total]) });
  assert.deepEqual(bytes, faststart);
  assert.equal(network.ranges[0], 'bytes=0-');
  assert(network.ranges.slice(1).every(range => range !== 'bytes=0-'));
  assert.deepEqual(progress.at(-1), [faststart.length, faststart.length]);
});

test('readWholeFile rejects with a cancel error and closes its Worker on abort', async () => {
  const network = cdn(faststart, { delayMs: 10 });
  const controller = new AbortController();
  const pending = readWholeFile({ input: { url: URL_A }, maxBytes: 1024 * 1024,
    signal: controller.signal, fetchImpl: network.fetchImpl });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { code: 'CANCELED' });
});

test('retained sources hold one Worker per source and close what is not taken', () => {
  const closed = [];
  const worker = name => ({ name, close: options => closed.push([name, options]) });
  const retained = createRetainedSources();
  const a = {}, b = {};
  retained.keep(a, worker('first'));
  retained.keep(b, worker('second'));
  assert.deepEqual(closed, [['first', { discard: true }]], 'Only one retained Worker at a time');
  assert.equal(retained.take(a), null, 'Another source does not take this cache');
  assert.equal(retained.take(b).name, 'second');
  assert.equal(retained.size, 0);
  retained.keep(a, worker('third'));
  retained.clear();
  assert.deepEqual(closed.at(-1), ['third', { discard: true }]);
});
