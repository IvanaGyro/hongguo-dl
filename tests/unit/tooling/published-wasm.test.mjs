import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMediaCoreManifest } from '../../../scripts/media-core-bundle.mjs';

// Test the actual checkout: a Windows line-ending conversion must not make a
// passing release unusable by the browser's byte-for-byte manifest verifier.
test('published media core and build inputs match the pinned release', () => {
  assert.doesNotThrow(() => verifyMediaCoreManifest());
});
