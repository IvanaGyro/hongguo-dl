import test from 'node:test';
import assert from 'node:assert/strict';
import { openCencProgressiveStream } from '../src/cenc-remux.js';

test('CENC startup releases object URLs on Worker constructor and postMessage failures', async t => {
  const saved = {
    Worker: globalThis.Worker,
    MediaSource: globalThis.MediaSource,
    fetch: globalThis.fetch,
    location: globalThis.location,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL
  };
  t.after(() => {
    for (const field of ['Worker', 'MediaSource', 'fetch', 'location']) {
      if (saved[field] === undefined) delete globalThis[field];
      else globalThis[field] = saved[field];
    }
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
  });
  let nextId = 0, terminated = 0;
  const minted = [], revoked = [];
  URL.createObjectURL = () => {
    const uri = 'blob:cenc-startup-' + ++nextId;
    minted.push(uri);
    return uri;
  };
  URL.revokeObjectURL = uri => { revoked.push(uri); };
  globalThis.location = { href: 'https://example.test/hongguo-dl/' };
  globalThis.MediaSource = class {
    static isTypeSupported() { return true; }
    readyState = 'closed';
  };
  globalThis.fetch = async (_url, { method }) => {
    assert.equal(method, 'HEAD');
    return { ok: true, headers: new Headers({
      'Content-Type': 'application/wasm',
      'Content-Length': '1024'
    }) };
  };

  const base = {
    video: { canPlayType: () => 'probably' },
    url: '/api/media?synthetic=1', fileSize: 10240,
    codec: 'h264', hasAac: true,
    key: '00112233445566778899aabbccddeeff'
  };
  globalThis.Worker = class {
    constructor() { throw new Error('private Worker constructor error'); }
  };
  await assert.rejects(openCencProgressiveStream(base), /Worker 無法建立/);
  assert.deepEqual(revoked, minted, 'Failed Worker constructor left an object URL active');

  globalThis.Worker = class {
    postMessage() { throw new Error('private postMessage details'); }
    terminate() { terminated++; }
  };
  await assert.rejects(openCencProgressiveStream(base), /Worker 無法啟動/);
  assert.deepEqual(revoked, minted, 'Failed postMessage left an object URL active');
  assert.equal(terminated, 1, 'Failed startup must terminate Worker');
  assert.equal(minted.length, 2);

  // Some browsers reject a bare "hvc1" declaration but accept a full
  // profile/compatibility/tier/level codec string on an MSE SourceBuffer.
  // canPlayType('hvc1') must not veto that precise MSE capability.
  let selectedMime = null;
  globalThis.MediaSource.isTypeSupported = mime => {
    selectedMime = mime;
    return mime === 'video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"';
  };
  globalThis.Worker = class {
    constructor() { throw new Error('synthetic Worker construction failure'); }
  };
  await assert.rejects(openCencProgressiveStream({
    ...base, codec: 'hevc', videoCodecString: 'hvc1.2.4.L120.90',
    video: { canPlayType: () => '' }
  }), /Worker 無法建立/);
  assert.equal(selectedMime, 'video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"');
  assert.deepEqual(revoked, minted);
});


test('HEVC seeks preserve codec and failed workers revoke URLs', async t => {
  const saved = {
    Worker: globalThis.Worker,
    MediaSource: globalThis.MediaSource,
    fetch: globalThis.fetch,
    location: globalThis.location,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL
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
  URL.createObjectURL = () => {
    const url = 'blob:cenc-seek-' + (minted.length + 1);
    minted.push(url);
    return url;
  };
  URL.revokeObjectURL = url => { revoked.push(url); };
  globalThis.location = { href: 'https://example.test/hongguo-dl/' };
  globalThis.fetch = async (_url, { method }) => {
    assert.equal(method, 'HEAD');
    return { ok: true, headers: new Headers({
      'Content-Type': 'application/wasm', 'Content-Length': '1024'
    }) };
  };
  const expectedMime = 'video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"';
  globalThis.MediaSource = class extends EventTarget {
    readyState = 'open';
    static isTypeSupported(mime) { return mime === expectedMime; }
    endOfStream(reason) { this.endReason = reason; }
  };
  globalThis.Worker = class {
    constructor() {
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  };
  const base = {
    video: { canPlayType: () => '' },
    url: '/api/media?synthetic=1', fileSize: 10240,
    codec: 'hevc', hasAac: true,
    videoCodecString: 'hvc1.2.4.L120.90',
    key: '00112233445566778899aabbccddeeff'
  };
  let stream = await openCencProgressiveStream(base);
  assert.equal(stream.mime, expectedMime);
  for (const seconds of [55, 62, 5, 68]) {
    const previous = stream;
    stream = await previous.seekTo(seconds);
    assert.equal(stream.mime, expectedMime, 'Seek lost the exact hvcC profile');
    assert.equal(workers.at(-2).terminated, true);
    assert.equal(workers.at(-1).messages[0].startSeconds, seconds);
    assert.equal(revoked.length, minted.length - 1,
      'Seek retained a previous CENC Object URL');
  }
  workers.at(-1).onerror({ preventDefault() {} });
  assert.equal(workers.at(-1).terminated, true);
  assert.deepEqual(revoked, minted, 'Worker error retained an Object URL');
  await stream.close();
  assert.deepEqual(revoked, minted, 'close after failure double-revoked an URL');
});

test('MSE follows the actual clear HEVC sample entry rather than presumed hvc1', async t => {
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
    box('stbl', box('stsd', join(new Uint8Array([0,0,0,0,0,0,0,1]),
      entry)))))));
  const init = join(box('ftyp', new Uint8Array(8)), moov);
  const hvc1 = 'video/mp4; codecs="hvc1.2.4.L120.90, mp4a.40.2"';
  const hev1 = 'video/mp4; codecs="hev1.2.4.L120.90, mp4a.40.2"';
  const created = [], revoked = [], workers = [], sources = [];
  URL.createObjectURL = () => {
    const value = 'blob:hevc-entry-' + (created.length + 1);
    created.push(value);
    return value;
  };
  URL.revokeObjectURL = value => revoked.push(value);
  globalThis.location = { href: 'https://example.test/hongguo-dl/' };
  globalThis.fetch = async () => ({
    ok: true, headers: new Headers({
      'Content-Type': 'application/wasm', 'Content-Length': '1024'
    })
  });
  let supportHev1 = true;
  globalThis.MediaSource = class extends EventTarget {
    readyState = 'open';
    constructor() { super(); sources.push(this); }
    static isTypeSupported(mime) {
      return mime === hvc1 || (supportHev1 && mime === hev1);
    }
    addSourceBuffer(mime) {
      this.actualMime = mime;
      const sb = new EventTarget();
      sb.buffered = { length: 0 };
      sb.updating = false;
      sb.appendBuffer = () => queueMicrotask(() =>
        sb.dispatchEvent(new Event('updateend')));
      return sb;
    }
    endOfStream(reason) { this.endReason = reason; }
  };
  globalThis.Worker = class {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  };
  const base = {
    video: { canPlayType: () => '' },
    url: '/api/media?synthetic=1', fileSize: 10240,
    codec: 'hevc', hasAac: true,
    videoCodecString: 'hvc1.2.4.L120.90',
    key: '00112233445566778899aabbccddeeff'
  };
  const deliver = async (worker, bytes) => {
    const packet = bytes.slice();
    worker.onmessage({ data: { type: 'init', id: 1, bytes: packet.buffer } });
    await new Promise(resolve => setImmediate(resolve));
  };
  const stream = await openCencProgressiveStream(base);
  assert.equal(stream.mime, hvc1, 'Input hvcC should be a provisional MIME');
  await deliver(workers.at(-1), init);
  assert.equal(sources.at(-1).actualMime, hev1,
    'The clear fMP4 sample entry must decide SourceBuffer MIME');
  assert.equal(stream.mime, hev1);
  assert(workers.at(-1).messages.some(message => message.type === 'ack'));
  await stream.close();
  assert.deepEqual(revoked, created);

  supportHev1 = false;
  const unsupported = await openCencProgressiveStream(base);
  assert(unsupported, 'Preflight can accept hvc1 before the mux output is known');
  await deliver(workers.at(-1), init);
  assert.equal(sources.at(-1).actualMime, undefined,
    'Unsupported clear output must not be appended as hvc1');
  assert.equal(sources.at(-1).endReason, 'decode');
  assert.equal(workers.at(-1).terminated, true);
  assert.deepEqual(revoked, created);
  await unsupported.close();
});

test('CENC abort closes Worker and object URL even with a blocked MSE ACK', async t => {
  const saved = {
    Worker: globalThis.Worker, MediaSource: globalThis.MediaSource,
    fetch: globalThis.fetch, location: globalThis.location,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL
  };
  t.after(() => {
    for (const field of ['Worker', 'MediaSource', 'fetch', 'location']) {
      if (saved[field] === undefined) delete globalThis[field];
      else globalThis[field] = saved[field];
    }
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
  });
  let sequence = 0, appends = 0;
  const revoked = [], workers = [];
  URL.createObjectURL = () => 'blob:blocked-ack-' + ++sequence;
  URL.revokeObjectURL = value => revoked.push(value);
  globalThis.location = { href: 'https://example.test/hongguo-dl/' };
  globalThis.fetch = async () => ({
    ok: true, headers: new Headers({
      'Content-Type': 'application/wasm', 'Content-Length': '1024'
    })
  });
  let mseMode = 'open';
  globalThis.MediaSource = class extends EventTarget {
    readyState = mseMode;
    static isTypeSupported() { return true; }
    addSourceBuffer() {
      const buffer = new EventTarget();
      buffer.buffered = { length: 0 };
      buffer.updating = false;
      // Simulate a browser that never delivers updateend.
      buffer.appendBuffer = () => { appends++; };
      return buffer;
    }
    endOfStream(reason) { this.endReason = reason; }
  };
  globalThis.Worker = class {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(data) { this.messages.push(data); }
    terminate() { this.terminated = true; }
  };
  const base = {
    video: { canPlayType: () => 'probably', currentTime: 0 },
    url: '/api/media?test=1', fileSize: 10240,
    codec: 'h264', hasAac: true, key: '00112233445566778899aabbccddeeff'
  };
  const sendInit = worker => worker.onmessage({ data: {
    type: 'init', id: 123, bytes: new Uint8Array([1, 2, 3, 4]).buffer
  } });

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
  assert.equal(revoked.length, 2,
    'Closing before sourceopen must release URL and terminate stalled Worker');

  mseMode = 'ended';
  const ended = await openCencProgressiveStream(base);
  sendInit(workers.at(-1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.at(-1).terminated, true,
    'An ended MediaSource must fail instead of waiting forever for sourceopen');
  assert.equal(revoked.length, 3,
    'Failure before SourceBuffer creation must revoke its object URL');
  await ended.close();
  assert.equal(revoked.length, 3);
});
