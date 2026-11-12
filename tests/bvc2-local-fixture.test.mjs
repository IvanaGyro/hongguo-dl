import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('local BVC2 positive fixture verifier requires a real file', () => {
  const p = spawnSync(process.execPath, ['scripts/verify-bvc2-fixture.mjs'],
    {encoding: 'utf8'});
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /Usage: node scripts\/verify-bvc2-fixture\.mjs/);
});
test('BVC2 fixture verifier rejects malformed CENC keys before linking WASM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bvc2-fixture-'));
  try {
    const path = join(dir, 'placeholder.mp4');
    writeFileSync(path, new Uint8Array(16));
    const p = spawnSync(process.execPath, [
      'scripts/verify-bvc2-fixture.mjs', path
    ], {
      encoding: 'utf8',
      env: {...process.env, BVC2_CENC_KEY: 'malformed'}
    });
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /Invalid local CENC key format/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
