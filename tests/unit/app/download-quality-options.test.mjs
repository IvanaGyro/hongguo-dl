import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialDownloadQualityEpisode,
  downloadQualityOptions,
  hasExactDownloadQuality
} from '../../../src/download-quality-options.js';

test('sample first restricted episode and never invent unobserved tiers', () => {
  assert.equal(initialDownloadQualityEpisode([{vid:'a',available:true},{vid:'b',available:false}]).vid,'b');
  const variants=[{quality:'720p'},{quality:'1080p'},{quality:'720p'},{quality:'public'}];
  assert.deepEqual(downloadQualityOptions(variants),['1080p','720p']);
  assert.equal(hasExactDownloadQuality(variants,'540p'),false);
});
