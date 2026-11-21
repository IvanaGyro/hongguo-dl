// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSidx,
  parseMfra,
  trackTimescales,
  mfraSizeFromMfro,
  fragmentStartOffset
} from '../../../src/fmp4-index.js';
import { box, ftyp, moov, withSidx, withMfra } from '../helpers/fragmented-cenc.mjs';

test('sidx: subsegment offsets, times and the sync start for a seek', () => {
  const file = withSidx();
  const sidxOffset = ftyp.length + moov.length;
  const sidxSize = new DataView(file.buffer, sidxOffset, 4).getUint32(0);
  const index = parseSidx(file.subarray(sidxOffset, sidxOffset + sidxSize), sidxOffset);
  assert.equal(index.entries.length, 4);
  assert.equal(index.entries[0].offset, sidxOffset + sidxSize);
  assert.deepEqual(index.entries.map(e => e.time), [0, 1, 2, 3]);
  assert(index.entries.every(e => e.sap));
  assert.equal(fragmentStartOffset(index, 2.5), index.entries[2].offset);
  assert.equal(fragmentStartOffset(index, 0), index.entries[0].offset);
});

test('mfra: tfra points use each track timescale; mfro locates the box', () => {
  const file = withMfra();
  const size = mfraSizeFromMfro(file.subarray(file.length - 16));
  assert(size > 16);
  const index = parseMfra(file.subarray(file.length - size), trackTimescales(moov));
  const points = index.tracks.get(1);
  assert.deepEqual(points.map(p => p.time), [0, 1, 2, 3]);
  assert.equal(points[0].offset, ftyp.length + moov.length);
  assert.equal(fragmentStartOffset(index, 3.2), points[3].offset);
  assert.equal(mfraSizeFromMfro(new Uint8Array(16)), null);
});
