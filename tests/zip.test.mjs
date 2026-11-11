import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { crc32, zipChunks, zipReadableStream } from '../src/zip.js';

test('streaming ZIP64 has correct CRC and Python ZipFile reads Unicode filenames', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const entries = [
    { name: '第001集.mp4', open: async () => new Blob([new TextEncoder().encode('hello')]).stream() },
    { name: '第002集.mp4', open: async () => new Blob([Uint8Array.from([0, 1, 255, 128])]).stream() },
  ];
  const parts = [];
  for await (const chunk of zipChunks(entries)) parts.push(chunk);
  const zip = Buffer.concat(parts);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])));
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])));
  const folder = mkdtempSync(join(tmpdir(), 'hongguo-zip-'));
  const filename = join(folder, 'demo.zip');
  try {
    writeFileSync(filename, zip);
    const script = `import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
  assert archive.namelist() == ['第001集.mp4', '第002集.mp4'], archive.namelist()
  assert archive.read('第001集.mp4') == b'hello'
  assert archive.read('第002集.mp4') == bytes([0, 1, 255, 128])
  assert archive.testzip() is None
`;
    const result = spawnSync('python3', ['-c', script, filename], { encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') return; // Python optional for local installs
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('ZIP stream rejects unsafe entry names and propagates failure', async () => {
  await assert.rejects(async () => {
    for await (const chunk of zipChunks([
      { name: '../unsafe', open: async () => new Blob(['bad']).stream() }
    ])) { void chunk; }
  }, /Unsafe ZIP entry filename/);
  const stream = zipReadableStream([
    { name: 'a.txt', open: async () => new Blob(['ok']).stream() }
  ]);
  const out = await new Response(stream).arrayBuffer();
  assert.ok(out.byteLength > 100);
});
