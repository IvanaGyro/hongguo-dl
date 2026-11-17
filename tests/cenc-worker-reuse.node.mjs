// Actual pinned WASM + production worker, synthetic media only. No CDN traffic.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
const input = new Uint8Array(await readFile(process.argv[2]));
const bvc2 = process.env.PROOF_BRIDGE === 'bvc2';
const shortProof = process.env.PROOF_SHORT === '1';
const key = process.env.BVC2_CENC_KEY || (bvc2 ? '' : '00112233445566778899aabbccddeeff');
const temporary = await mkdtemp(join(tmpdir(), 'cenc-worker-reuse-'));
const stages = [], packets = [], requests = [];
let downloadedResolve;
const downloaded = new Promise(resolve => { downloadedResolve = resolve; });
let seekSent = false, finishedResolve, reject;
const finished = new Promise((res, rej) => { finishedResolve = res; reject = rej; });
const timer = setTimeout(() => reject(new Error('Persistent worker proof timed out')), bvc2 ? 120000 : 20000);
const generationCounts = new Map();
globalThis.self = {
  location: { origin: 'https://fixture.test', href: 'https://fixture.test/worker.js' },
  postMessage(data) {
    if (data.type === 'stage') {
      stages.push(data);
      if (data.stage === 'media.cache' && data.complete) downloadedResolve();
    }
    if (data.type === 'error') return reject(new Error(JSON.stringify(data)));
    if (data.type === 'capability-request') return queueMicrotask(() => self.onmessage({ data: {
      type: 'capabilities', capabilities: { types: Object.fromEntries(data.types.map(type => [type, true])) } } }));
    if (data.type === 'init' || data.type === 'media') {
      packets.push(data);
      if (data.type === 'media') {
        const count = (generationCounts.get(data.generation) || 0) + 1;
        generationCounts.set(data.generation, count);
        if (data.generation === 1 && count === 2 && !seekSent) {
          seekSent = true;
          need({ revision: 3, processing: true, positionSeconds: 20 });
          return;
        }
      }
      if (shortProof && data.type === 'media' && (generationCounts.get(data.generation) || 0) >= 3) {
        if (data.generation === 3) need({ revision: 4, processing: true, positionSeconds: 5 });
        if (data.generation === 4) { finishedResolve(); return; }
      } else queueMicrotask(() => self.onmessage({ data: { type: 'ack', id: data.id } }));
    }
    if (data.type === 'done') {
      if (data.generation === 3) need({ revision: 4, processing: true, positionSeconds: 5 });
      if (data.generation === 4) finishedResolve();
    }
  }
};
const need = fields => self.onmessage({ data: { type: 'need', demand: {
  id: 'proof', output: 'playable-media', codec: 'h264', priority: 'speculative',
  source: { url: 'https://fixture.test/api/media', bridge: bvc2 ? 'bvc2' : 'cenc', key }, ...fields } } });
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith('file:')) return new Response(await readFile(new URL(url)));
  const [, a, b] = /^bytes=(\d+)-(\d*)$/.exec(options.headers.Range);
  const start = Number(a), last = b ? Math.min(Number(b), input.length - 1) : input.length - 1;
  requests.push(options.headers.Range);
  let position = start;
  return new Response(new ReadableStream({ pull(c) {
    if (position > last) return c.close();
    const end = Math.min(position + 32768, last + 1);
    c.enqueue(input.slice(position, end)); position = end;
  } }), { status: 206, headers: {
    'Content-Range': `bytes ${start}-${last}/${input.length}`,
    'Content-Length': String(last - start + 1)
  } });
};
try {
  const bundle = join(temporary, 'worker.mjs');
  await build({ entryPoints: [resolve('src/cenc-remux-worker.js')], bundle: true,
    format: 'esm', platform: 'node', outfile: bundle,
    define: { 'import.meta.env.BASE_URL': JSON.stringify(pathToFileURL(resolve('public') + '/').href) } });
  await import(pathToFileURL(bundle));
  // One speculative demand: the Worker opens the source, probes metadata and
  // downloads, but CPU work waits until processing capacity is granted.
  self.onmessage({ data: { type: 'capabilities', capabilities: { processing: { [bvc2 ? 'bvc2' : 'cenc']: true } } } });
  need({ revision: 1, processing: false });
  await Promise.race([downloaded, finished]);
  assert(stages.some(s => s.stage === 'media.cache' && s.complete), 'Raw download must finish while processing is deferred');
  assert(!stages.some(s => s.stage === 'wasm-start'), 'Next episode must not run WASM before CPU handoff');
  assert.equal(packets.length, 0);
  need({ revision: 2, processing: true });
  await finished;
  assert.equal(stages.filter(s => s.stage === 'wasm-start').length, 1);
  assert.deepEqual(stages.filter(s => s.stage === 'seek.run').map(s => s.generation), [1, 3, 4]);
  assert(generationCounts.get(3) > 0 && generationCounts.get(4) > 0);
  assert.equal(requests[0], 'bytes=0-', 'Metadata and WASM share the first response');
  assert.equal(packets.filter(p => p.type === 'init').length, 3);
  assert(stages.some(s => s.stage === 'media.cache' && s.cacheHits > 0));
  for (const generation of [3, 4]) {
    const clear = join(temporary, `generation-${generation}.mp4`);
    await writeFile(clear, Buffer.concat(packets.filter(p => p.generation === generation)
      .map(p => Buffer.from(p.bytes))));
    execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', clear, '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  console.log('PASS production ' + (bvc2 ? 'ByteVC2' : 'CENC') + ' worker reuses WASM and cached bytes for interrupted/EOF forward/back seeks',
    JSON.stringify({ requests, generations: [...generationCounts] }));
} finally {
  self.onmessage?.({ data: { type: 'cancel' } });
  console.log('requests', JSON.stringify(requests));
  clearTimeout(timer); await rm(temporary, { recursive: true, force: true });
}
