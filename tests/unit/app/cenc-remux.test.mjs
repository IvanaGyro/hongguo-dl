import test from 'node:test';
import assert from 'node:assert/strict';
import { openCencProgressiveStream } from '../../../src/cenc-remux.js';

const KEY = '00112233445566778899aabbccddeeff';
const input = { url: '/api/media?synthetic=1', proxyUrl: '/api/media?synthetic=1' };
const H264_AAC = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
const HVC1 = 'video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"';
const HEV1 = 'video/mp4; codecs="hev1.2.4.L120.90, mp4a.40.2"';

function environment(t) {
  const saved = {
    Worker: globalThis.Worker, MediaSource: globalThis.MediaSource,
    fetch: globalThis.fetch, location: globalThis.location,
    createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL
  };
  t.after(() => {
    for (const field of ['Worker', 'MediaSource', 'fetch', 'location']) {
      if (saved[field] === undefined) delete globalThis[field];
      else globalThis[field] = saved[field];
    }
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
  });
  const minted = [], revoked = [], workers = [];
  URL.createObjectURL = () => { const value = 'blob:cenc-' + (minted.length + 1); minted.push(value); return value; };
  URL.revokeObjectURL = value => revoked.push(value);
  globalThis.location = { href: 'https://example.test/hongguo-dl/' };
  globalThis.fetch = async (_url, { method }) => {
    assert.equal(method, 'HEAD');
    return { ok: true, headers: new Headers({ 'Content-Type': 'application/wasm', 'Content-Length': '1024' }) };
  };
  return { minted, revoked, workers };
}

// A scripted media Worker: it answers the first demand with metadata, asks
// for the MIME capabilities it needs, and then reports the given route.
function scriptedWorker(workers, { route = {}, types = [H264_AAC], answers = [] } = {}) {
  return class {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === 'need' && !this.demand) {
        this.demand = message.demand;
        queueMicrotask(() => {
          this.onmessage({ data: { type: 'metadata', demand: this.demand.id, metadata: { fileSize: 10240, kid: '01'.repeat(16) } } });
          this.onmessage({ data: { type: 'capability-request', types } });
        });
      }
      if (message.type === 'capabilities' && message.capabilities.types) {
        answers.push(message.capabilities.types);
        queueMicrotask(() => this.onmessage({ data: { type: 'route', demand: this.demand.id, route: {
          kind: 'mse', mime: types[0], alternateMime: types[1] || null,
          videoCodec: types[0].match(/codecs="([^,"]+)/)[1], hasAac: true,
          fileSize: 10240, durationSeconds: null, startSeconds: 0, ...route } } }));
      }
    }
    terminate() { this.terminated = true; }
  };
}

test('CENC startup releases the Worker on constructor and postMessage failures', async t => {
  const { minted, workers } = environment(t);
  globalThis.MediaSource = class { static isTypeSupported() { return true; } readyState = 'closed'; };
  const base = { video: { canPlayType: () => 'probably' }, input, codec: 'h264', key: KEY };
  globalThis.Worker = class { constructor() { throw new Error('private Worker constructor error'); } };
  await assert.rejects(openCencProgressiveStream(base), /Worker 無法建立/);
  let terminated = 0;
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage() { throw new Error('private postMessage details'); }
    terminate() { terminated++; }
  };
  await assert.rejects(openCencProgressiveStream(base), /Worker 無法啟動/);
  assert.equal(terminated, 1, 'Failed startup must terminate Worker');
  assert.equal(minted.length, 0, 'No MediaSource exists before the Worker chooses an MSE route');
});

test('the main thread reports exact HEVC MSE support; canPlayType does not veto it', async t => {
  const { workers } = environment(t);
  const answers = [];
  globalThis.MediaSource = class extends EventTarget {
    readyState = 'open';
    static isTypeSupported(mime) { return mime === HVC1; }
  };
  globalThis.Worker = scriptedWorker(workers, { types: [HVC1, HEV1], answers });
  const stream = await openCencProgressiveStream({ video: { canPlayType: () => '' }, input, codec: 'hevc', key: KEY });
  assert.deepEqual(answers, [{ [HVC1]: true, [HEV1]: false }]);
  const need = workers[0].messages.find(message => message.type === 'need').demand;
  assert.equal(need.output, 'playable-media');
  assert.equal(need.codec, 'hevc');
  assert.equal(need.source.url, input.url);
  assert.equal(stream.mime, HVC1);
  assert(!workers[0].messages.some(message => 'initialStream' in message || 'initialRanges' in message),
    'Main thread transfers no probed bytes or response streams');
  await stream.close();
});

test('HEVC seeks update the demand in place and failed workers revoke URLs', async t => {
  const { minted, revoked, workers } = environment(t);
  globalThis.MediaSource = class extends EventTarget {
    readyState = 'open';
    static isTypeSupported(mime) { return mime === HVC1; }
    endOfStream(reason) { this.endReason = reason; }
  };
  globalThis.Worker = scriptedWorker(workers, { types: [HVC1, HEV1] });
  const stream = await openCencProgressiveStream({ video: { canPlayType: () => '' }, input, codec: 'hevc', key: KEY });
  assert.equal(stream.mime, HVC1);
  const before = workers[0].messages.filter(message => message.type === 'need').at(-1).demand;
  const pending = stream.seekTo(55);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, false);
  const seek = workers[0].messages.at(-1);
  assert.equal(seek.type, 'need');
  assert.equal(seek.demand.positionSeconds, 55);
  assert.equal(seek.demand.id, before.id);
  assert(seek.demand.revision > before.revision);
  assert.equal(revoked.length, 0);
  const rejected = assert.rejects(pending, { code: 'CENC_REMUX_FAILED' });
  workers.at(-1).onerror({ preventDefault() {} });
  await rejected;
  assert.equal(workers.at(-1).terminated, true);
  assert(!workers.at(-1).messages.some(message => message.type === 'cancel'),
    'Failure cleanup must terminate without racing a cancel message');
  assert.deepEqual(revoked, minted, 'Worker error retained an Object URL');
  await stream.close();
  assert.deepEqual(revoked, minted, 'close after failure double-revoked an URL');
});

test('MSE follows the actual clear HEVC sample entry rather than presumed hvc1', async t => {
  const { minted, revoked, workers } = environment(t);
  const box = (tag, payload = new Uint8Array(0)) => {
    const result = new Uint8Array(payload.length + 8);
    new DataView(result.buffer).setUint32(0, result.length);
    result.set([...tag].map(c => c.charCodeAt(0)), 4);
    result.set(payload, 8);
    return result;
  };
  const join = (...parts) => {
    const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  };
  const hvcC = new Uint8Array(23);
  hvcC[0] = 1; hvcC[1] = 2; hvcC[2] = 0x20;
  hvcC[6] = 0x90; hvcC[12] = 120;
  const entry = box('hev1', join(new Uint8Array(78), box('hvcC', hvcC)));
  const moov = box('moov', box('trak', box('mdia', box('minf',
    box('stbl', box('stsd', join(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), entry)))))));
  const init = join(box('ftyp', new Uint8Array(8)), moov);
  const sources = [];
  let supportHev1 = true;
  globalThis.MediaSource = class extends EventTarget {
    readyState = 'open';
    constructor() { super(); sources.push(this); }
    static isTypeSupported(mime) { return mime === HVC1 || (supportHev1 && mime === HEV1); }
    addSourceBuffer(mime) {
      this.actualMime = mime;
      const sb = new EventTarget();
      sb.buffered = { length: 0 };
      sb.updating = false;
      sb.appendBuffer = () => queueMicrotask(() => sb.dispatchEvent(new Event('updateend')));
      return sb;
    }
    endOfStream(reason) { this.endReason = reason; }
  };
  globalThis.Worker = scriptedWorker(workers, { types: [HVC1, HEV1] });
  const base = { video: { canPlayType: () => '' }, input, codec: 'hevc', key: KEY };
  const deliver = async (worker, bytes) => {
    const packet = bytes.slice();
    worker.onmessage({ data: { type: 'init', id: 1, bytes: packet.buffer } });
    await new Promise(resolve => setImmediate(resolve));
  };
  const stream = await openCencProgressiveStream(base);
  assert.equal(stream.mime, HVC1, 'Input hvcC should be a provisional MIME');
  await deliver(workers.at(-1), init);
  assert.equal(sources.at(-1).actualMime, HEV1, 'The clear fMP4 sample entry must decide SourceBuffer MIME');
  assert.equal(stream.mime, HEV1);
  assert(workers.at(-1).messages.some(message => message.type === 'ack'));
  await stream.close();
  assert.deepEqual(revoked, minted);

  supportHev1 = false;
  const unsupported = await openCencProgressiveStream(base);
  assert(unsupported, 'Preflight can accept hvc1 before the mux output is known');
  await deliver(workers.at(-1), init);
  assert.equal(sources.at(-1).actualMime, undefined, 'Unsupported clear output must not be appended as hvc1');
  assert.equal(sources.at(-1).endReason, 'decode');
  assert.equal(workers.at(-1).terminated, true);
  assert.deepEqual(revoked, minted);
  await unsupported.close();
});

test('CENC abort closes Worker and object URL even with a blocked MSE ACK', async t => {
  const { revoked, workers } = environment(t);
  let appends = 0, mseMode = 'open';
  globalThis.MediaSource = class extends EventTarget {
    readyState = mseMode;
    static isTypeSupported() { return true; }
    addSourceBuffer() {
      const buffer = new EventTarget();
      buffer.buffered = { length: 0 };
      buffer.updating = false;
      buffer.appendBuffer = () => { appends++; }; // never delivers updateend
      return buffer;
    }
    endOfStream(reason) { this.endReason = reason; }
  };
  globalThis.Worker = scriptedWorker(workers);
  const base = { video: { canPlayType: () => 'probably', currentTime: 0 }, input, codec: 'h264', key: KEY };
  const sendInit = worker => worker.onmessage({ data: {
    type: 'init', id: 123, bytes: new Uint8Array([1, 2, 3, 4]).buffer } });

  const controller = new AbortController();
  const stream = await openCencProgressiveStream({ ...base, signal: controller.signal });
  sendInit(workers.at(-1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(appends, 1, 'Synthetic append must reach a pending updateend ACK');
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.at(-1).terminated, true);
  assert.equal(workers.at(-1).messages.some(message => message.type === 'ack'), false,
    'A canceled stream must not acknowledge a SourceBuffer append');
  await stream.close();
  assert.equal(revoked.length, 1, 'Cancel and close cannot double-revoke an MSE URL');

  mseMode = 'closed';
  const waiting = await openCencProgressiveStream(base);
  sendInit(workers.at(-1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.at(-1).messages.some(message => message.type === 'ack'), false);
  await waiting.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.at(-1).terminated, true);
  assert.equal(revoked.length, 2, 'Closing before sourceopen must release URL and terminate stalled Worker');

  mseMode = 'ended';
  const ended = await openCencProgressiveStream(base);
  sendInit(workers.at(-1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.at(-1).terminated, true,
    'An ended MediaSource must fail instead of waiting forever for sourceopen');
  assert.equal(revoked.length, 3, 'Failure before SourceBuffer creation must revoke its object URL');
  await ended.close();
  assert.equal(revoked.length, 3);
});

test('a non-MSE route creates no MediaSource and hands metadata to the native pipeline', async t => {
  const { minted, workers } = environment(t);
  let mediaSources = 0;
  globalThis.MediaSource = class {
    static isTypeSupported() { return false; }
    constructor() { mediaSources++; }
  };
  globalThis.Worker = scriptedWorker(workers, { route: { kind: 'native', reason: 'mse-codec-unsupported' } });
  let handedOff = null;
  const stream = await openCencProgressiveStream({ video: { canPlayType: () => '' }, input,
    codec: 'h264', key: KEY, onMetadata: (metadata, route) => { handedOff = { metadata, route }; } });
  assert.equal(stream, null);
  assert.equal(mediaSources, 0, 'Negative support must not create a MediaSource');
  assert.equal(minted.length, 0);
  assert.equal(handedOff.route.kind, 'native');
  assert.equal(handedOff.metadata.kid, '01'.repeat(16));
});

test('Worker source errors reject startup with public codes only', async t => {
  const { workers } = environment(t);
  globalThis.MediaSource = class { static isTypeSupported() { return true; } };
  globalThis.Worker = class {
    constructor() { workers.push(this); this.terminated = false; }
    postMessage(message) {
      if (message.type === 'need') queueMicrotask(() => this.onmessage({ data: {
        type: 'error', demand: message.demand.id, code: 'CENC_RATE_LIMITED', status: 429, retryAfterMs: 1500 } }));
    }
    terminate() { this.terminated = true; }
  };
  await assert.rejects(openCencProgressiveStream({ video: { canPlayType: () => 'probably' }, input, codec: 'h264', key: KEY }),
    error => error.code === 'CENC_RATE_LIMITED' && error.status === 429 && error.retryAfterMs === 1500 &&
      !/api\/media|0011223344/.test(error.message));
  assert.equal(workers[0].terminated, true);
});
