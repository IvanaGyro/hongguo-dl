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

