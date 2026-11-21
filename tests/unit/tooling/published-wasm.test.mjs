import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyManifest } from '../../../scripts/cenc-wasm-bundle.mjs';
import { verifyBvc2Manifest } from '../../../scripts/bvc2-wasm-bundle.mjs';

// Test the actual checkout: a Windows line-ending conversion must not make a
// passing release unusable by the browser's byte-for-byte manifest verifier.

test('published CENC runtime and build inputs match the pinned release', () => {
  assert.doesNotThrow(() => verifyManifest());
});

test('published ByteVC2 runtime and build inputs match the pinned release', () => {
  assert.doesNotThrow(() => verifyBvc2Manifest());
});
