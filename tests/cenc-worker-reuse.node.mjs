// Actual pinned WASM + production worker, synthetic media only. No CDN traffic.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
const input = new Uint8Array(await readFile(process.argv[2]));
const temporary = await mkdtemp(join(tmpdir(), 'cenc-worker-reuse-'));
const stages = [], packets = [], requests = [];
let seekSent = false, finishedResolve, reject;
const finished = new Promise((res, rej) => { finishedResolve = res; reject = rej; });
const timer = setTimeout(() => reject(new Error('Persistent worker proof timed out')), 20000);
const generationCounts = new Map();
globalThis.self = {
  location: { origin: 'https://fixture.test', href: 'https://fixture.test/worker.js' },
  postMessage(data) {
    if (data.type === 'stage') stages.push(data);
    if (data.type === 'error') return reject(new Error(JSON.stringify(data)));
    if (data.type === 'init' || data.type === 'media') {
      packets.push(data);
      if (data.type === 'media') {
        const count = (generationCounts.get(data.generation) || 0) + 1;
        generationCounts.set(data.generation, count);
        if (data.generation === 0 && count === 2 && !seekSent) {
          seekSent = true;
          self.onmessage({ data: { type: 'seek', seconds: 20, generation: 1 } });
          return;
        }
      }
      queueMicrotask(() => self.onmessage({ data: { type: 'ack', id: data.id } }));
    }
    if (data.type === 'done') {
      if (data.generation === 1) self.onmessage({ data: { type: 'seek', seconds: 5, generation: 2 } });
      if (data.generation === 2) finishedResolve();
    }
  }
};
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith('file:')) return new Response(await readFile(new URL(url)));
  const start = Number(/^bytes=(\d+)-$/.exec(options.headers.Range)[1]);
  requests.push(start);
  let position = start;
  return new Response(new ReadableStream({ pull(c) {
    if (position === input.length) return c.close();
    const end = Math.min(position + 32768, input.length);
    c.enqueue(input.slice(position, end)); position = end;
  } }), { status: 206, headers: {
    'Content-Range': `bytes ${start}-${input.length - 1}/${input.length}`,
    'Content-Length': String(input.length - start)
  } });
};
try {
  const bundle = join(temporary, 'worker.mjs');
  await build({ entryPoints: [resolve('src/cenc-remux-worker.js')], bundle: true,
    format: 'esm', platform: 'node', outfile: bundle,
    define: { 'import.meta.env.BASE_URL': JSON.stringify(pathToFileURL(resolve('public') + '/').href) } });
  await import(pathToFileURL(bundle));
  self.onmessage({ data: { type: 'start', url: 'https://fixture.test/api/media',
    key: '00112233445566778899aabbccddeeff', fileSize: input.length, retrySameSource: true } });
  await finished;
  assert.equal(stages.filter(s => s.stage === 'wasm-start').length, 1);
  assert.deepEqual(stages.filter(s => s.stage === 'seek.run').map(s => s.generation), [0, 1, 2]);
  assert(generationCounts.get(1) > 0 && generationCounts.get(2) > 0);
  assert.equal(packets.filter(p => p.type === 'init').length, 3);
  assert(stages.some(s => s.stage === 'media.cache' && s.cacheHits > 0));
  for (const generation of [1, 2]) {
    const clear = join(temporary, `generation-${generation}.mp4`);
    await writeFile(clear, Buffer.concat(packets.filter(p => p.generation === generation)
      .map(p => Buffer.from(p.bytes))));
    execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', clear, '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  console.log('PASS production CENC worker reuses WASM and cached bytes for interrupted/EOF forward/back seeks',
    JSON.stringify({ requests, generations: [...generationCounts] }));
} finally {
  self.onmessage?.({ data: { type: 'cancel' } });
  clearTimeout(timer); await rm(temporary, { recursive: true, force: true });
}
