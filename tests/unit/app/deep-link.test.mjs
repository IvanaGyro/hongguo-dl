import test from 'node:test';
import assert from 'node:assert/strict';
import { idsFromUrl, urlForSeriesIds } from '../../../src/deep-link.js';

test('GitHub Pages URL IDs remain exact 19-digit strings, deduplicated and capped', () => {
  const id = '7699513062054710296';
  assert.deepEqual(idsFromUrl('https://ivanagyro.github.io/hongguo-dl/?id=' + id), [id]);
  assert.deepEqual(idsFromUrl('https://example.com/?id=42,60&id=42&ids=5%3B6&series_id=7'),
    ['42', '60', '5', '6', '7']);
  assert.deepEqual(idsFromUrl('https://example.com/?id=-1&id=abc&id=1e6'), []);
  assert.deepEqual(idsFromUrl('https://example.com/?id=1,2,3', 2), ['1', '2']);
  assert.equal(new URL(urlForSeriesIds('https://example.com/?id=old&keep=yes',
    [id, '60'])).searchParams.getAll('id')[0], id);
});
