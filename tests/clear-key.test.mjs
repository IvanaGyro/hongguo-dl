import test from 'node:test';
import assert from 'node:assert/strict';
import { mp4Boxes, cencKidFromMoov, probeCencKid, clearKeyLicense,
  mimeForCodec, openClearKeyStream, commonCencPssh, ensureMediaKeys, openKeySession } from '../src/clear-key.js';

const box = (name, payload) => {
  const ret = new Uint8Array(8 + payload.length);
  new DataView(ret.buffer).setUint32(0, ret.length);
  ret.set(Array.from(name, c => c.charCodeAt(0)), 4);
  ret.set(payload, 8);
  return ret;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((x, p) => x + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const KID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const tenc = box('tenc', concat(Uint8Array.of(0,0,0,0, 0,0,1,8), KID));
const moov = box('moov', box('trak', box('schi', tenc)));
const ftyp = box('ftyp', new Uint8Array(16));
const mdat = box('mdat', new Uint8Array(3072));
function mockFetch(bytes) {
  const calls = [];
  const fetchImpl = async (_url, { headers }) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(headers.Range);
    assert(match);
    const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    calls.push({ start, end });
    const data = bytes.subarray(start, end + 1);
    return new Response(data, { status: 206, headers: {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length,
      'Content-Length': String(data.length)
    } });
  };
  return { calls, fetchImpl };
}

test('parse nested tenc ID using only moov metadata', () => {
  assert.deepEqual([...cencKidFromMoov(moov)], [...KID]);
  assert.equal(cencKidFromMoov(mdat), null);
  assert.deepEqual(mp4Boxes(concat(ftyp, moov, mdat)).map(b => b.type),
    ['ftyp', 'moov', 'mdat']);
});

test('recognize fragmented moov only when it contains mvex', async () => {
  const fragmentedMoov = box('moov', concat(box('trak', box('schi', tenc)),
    box('mvex', box('trex', new Uint8Array(24)))));
  const fixture = concat(ftyp, fragmentedMoov, mdat);
  const fragmented = {};
  const f = mockFetch(fixture);
  assert.deepEqual([...(await probeCencKid('https://example.com/f.mp4', null,
    f.fetchImpl, fragmented))], [...KID]);
  assert.equal(fragmented.fragmented, true);
  assert.equal(fragmented.fileSize, fixture.length);
  const regular = {};
  await probeCencKid('https://example.com/regular.mp4', null,
    mockFetch(concat(ftyp, moov, mdat)).fetchImpl, regular);
  assert.equal(regular.fragmented, false);
});

test('find KID via single bounded Range when moov precedes media', async () => {
  const f = mockFetch(concat(ftyp, moov, mdat));
  const kid = await probeCencKid('https://example.com/test.mp4', null, f.fetchImpl);
  assert.deepEqual([...kid], [...KID]);
  assert.equal(f.calls.length, 1);
  assert(f.calls[0].end <= 65535);
});

test('find moov after mdat without downloading its payload', async () => {
  const media = concat(ftyp, mdat, moov), f = mockFetch(media);
  const kid = await probeCencKid('https://example.com/test.mp4', null, f.fetchImpl);
  assert.deepEqual([...kid], [...KID]);
});

test('long MP4 moov above 1 MiB is fetched as one bounded metadata Range', async () => {
  const largeMoov = box('moov', concat(
    box('trak', box('schi', tenc)),
    box('free', new Uint8Array(1250000))
  ));
  assert(largeMoov.length > 1024 * 1024);
  const f = mockFetch(concat(ftyp, largeMoov, mdat));
  const info = {};
  const kid = await probeCencKid('https://example.com/long.mp4', null, f.fetchImpl, info);
  assert.deepEqual([...kid], [...KID]);
  assert.equal(info.fileSize, ftyp.length + largeMoov.length + mdat.length);
  assert.equal(f.calls.length, 2, 'Only bounded header and complete moov Ranges');
  assert(f.calls[0].end < 65536);
  assert.equal(f.calls[1].end - f.calls[1].start + 1, largeMoov.length);
});

test('oversized MP4 moov is rejected without unbounded metadata downloads', async () => {
  const header = new Uint8Array(65536);
  header.set(ftyp, 0);
  const offset = ftyp.length;
  new DataView(header.buffer).setUint32(offset, 9 * 1024 * 1024);
  header.set([0x6d, 0x6f, 0x6f, 0x76], offset + 4); // moov
  let calls = 0;
  await assert.rejects(probeCencKid('https://example.com/too-large.mp4', null,
    async () => {
      calls++;
      return new Response(header, { status: 206, headers: {
        'Content-Range': 'bytes 0-65535/10000000'
      } });
    }), error => error.code === 'CENC_METADATA_LIMIT' && /8 MiB/.test(error.message));
  assert.equal(calls, 1, 'A giant index must not trigger extra Range or whole-file fetch');
});

test('oversized encrypted CENC index stops playback preparation before full-file fallback', async () => {
  const header = new Uint8Array(65536);
  header.set(ftyp, 0);
  new DataView(header.buffer).setUint32(ftyp.length, 9 * 1024 * 1024);
  header.set([0x6d, 0x6f, 0x6f, 0x76], ftyp.length + 4);
  let calls = 0;
  await assert.rejects(openClearKeyStream({
    video: { canPlayType: () => 'probably' },
    source: {
      url: 'https://cdn.example/encrypted.mp4', codec: 'h264',
      contentKey: '00112233445566778899aabbccddeeff', source: 'app'
    },
    codec: 'h264', workerOrigin: 'https://worker.example',
    fetchImpl: async () => {
      calls++;
      return new Response(header, { status: 206, headers: {
        'Content-Range': 'bytes 0-65535/10000000'
      } });
    },
    requestAccess: async () => { throw new Error('Should not try EME'); }
  }), error => error.code === 'CENC_METADATA_LIMIT');
  assert.equal(calls, 1);
});

test('reject HTTP 200 instead of buffering a full video', async () => {
  let cancelled = false;
  await assert.rejects(probeCencKid('https://example.com', null, async () =>
    ({ status: 200, body: { cancel: async () => { cancelled = true; } } })),
    /HTTP Range/);
  assert.equal(cancelled, true);
});

test('clear key is exact 128-bit and codec selection excludes ByteVC2', () => {
  assert.equal(mimeForCodec('bytevc2'), null);
  assert.match(mimeForCodec('h264'), /avc1/);
  const license = JSON.parse(clearKeyLicense(KID, new Uint8Array(16).fill(1)));
  assert.equal(license.type, 'temporary');
  assert.equal(license.keys[0].kid, 'AQIDBAUGBwgJCgsMDQ4PEA');
  assert.equal(license.keys[0].k, 'AQEBAQEBAQEBAQEBAQEBAQ');
});

test('standard Common SystemID PSSH includes only the supplied KID', () => {
  const bytes = commonCencPssh(KID);
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.byteLength, 52);
  assert.equal(view.getUint32(0), 52);
  assert.equal(new TextDecoder().decode(bytes.subarray(4, 8)), 'pssh');
  assert.equal(bytes[8], 1);
  assert.equal(Buffer.from(bytes.subarray(12, 28)).toString('hex'),
    '1077efecc0b24d02ace33c1e52e2fb4b');
  assert.equal(view.getUint32(28), 1);
  assert.deepEqual([...bytes.subarray(32, 48)], [...KID]);
  assert.equal(view.getUint32(48), 0);
  assert.throws(() => commonCencPssh(new Uint8Array(15)), /16 bytes/);
});

// Browsers decrypt CENC only through MSE (diagnostics/CENC-FINDINGS.md):
// a progressive encrypted MP4 is never handed to the media element.
function fakeKeySystem({ statuses = ['usable'] } = {}) {
  const calls = { access: 0, setMediaKeys: 0, sessions: 0, closed: 0, generated: [] };
  const access = {
    getConfiguration: () => ({ initDataTypes: ['keyids'] }),
    createMediaKeys: async () => ({
      createSession: () => {
        calls.sessions++;
        const listeners = new Map();
        return {
          addEventListener: (name, cb) => listeners.set(name, cb),
          keyStatuses: new Map(statuses.map((status, i) => [i, status])),
          generateRequest: async (type, data) => {
            calls.generated.push([type, new TextDecoder().decode(data)]);
            queueMicrotask(() => listeners.get('message')({
              message: new TextEncoder().encode(JSON.stringify({ kids: ['AQIDBAUGBwgJCgsMDQ4PEA'] }))
            }));
          },
          update: async () => {},
          close: async () => { calls.closed++; }
        };
      }
    })
  };
  const requestAccess = async () => { calls.access++; return access; };
  return { calls, requestAccess, access };
}

test('progressive CENC never uses EME or an encrypted URL; without WASM it declines', async () => {
  const f = mockFetch(concat(ftyp, moov, mdat));
  const keySystem = fakeKeySystem();
  const video = { canPlayType: () => 'probably',
    setMediaKeys: async () => { keySystem.calls.setMediaKeys++; } };
  const result = await openClearKeyStream({
    video, source: { url: 'https://cdn.fqnovelvod.com/mp4', codec: 'h264',
      contentKey: '00112233445566778899aabbccddeeff', source: 'app' },
    codec: 'h264', workerOrigin: 'https://worker.example',
    fetchImpl: f.fetchImpl, requestAccess: keySystem.requestAccess
  });
  // Node has no MSE, so no WASM route: the caller's whole-file fallback applies.
  assert.equal(result, null);
  assert.equal(keySystem.calls.access, 0, 'A progressive MP4 must not request a key system');
  assert.equal(keySystem.calls.setMediaKeys, 0);
  assert.equal(f.calls.length, 1, 'Only the metadata probe reads the source');
});

test('aborting stalled CENC KID metadata Range cancels reader and stops probing', async () => {
  const controller = new AbortController();
  let opened = 0, canceled = 0;
  const stream = new ReadableStream({
    start() { opened++; },
    cancel() { canceled++; }
  });
  const pending = probeCencKid('https://example.com/encrypted.mp4', controller.signal,
    async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=0-65535');
      return new Response(stream, { status: 206, headers: {
        'Content-Range': 'bytes 0-65535/100000'
      } });
    });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELED' });
  assert.equal(opened, 1);
  assert.equal(canceled, 1, 'Metadata stream must be canceled immediately on abort');
});

test('metadata Range deadline covers both headers and an idle body', async () => {
  for (const phase of ['headers', 'body']) {
    let signalSeen, canceled = 0;
    const fetchImpl = async (_url, { signal }) => {
      signalSeen = signal;
      if (phase === 'headers') return new Promise(() => {});
      return new Response(new ReadableStream({ cancel() { canceled++; } }), {
        status: 206, headers: { 'Content-Range': 'bytes 0-65535/100000' }
      });
    };
    await assert.rejects(probeCencKid('https://example.com/fixture', undefined,
      fetchImpl, null, () => {}, 20), { code: 'CENC_RANGE_TIMEOUT' });
    assert.equal(signalSeen.aborted, true);
    if (phase === 'body') assert.equal(canceled, 1);
  }
});

test('late metadata headers leave a fresh body idle budget, while progress identifies the exact bytes', async () => {
  const data = concat(ftyp, moov), stages = [];
  const fetchImpl = async (_url, { headers }) => {
    const first = Number(/bytes=(\d+)-/.exec(headers.Range)[1]);
    await new Promise(resolve => setTimeout(resolve, 60));
    const body = new ReadableStream({ start(controller) {
      setTimeout(() => { controller.enqueue(data.subarray(first)); controller.close(); }, 60);
    } });
    return new Response(body, { status: 206, headers: {
      'Content-Range': `bytes ${first}-${data.length - 1}/${data.length}`, 'Content-Length': String(data.length - first)
    } });
  };
  const kid = await probeCencKid('https://example.com/fixture', undefined, fetchImpl, null,
    (stage, fields) => stages.push({ stage, ...fields }), 100);
  assert.deepEqual(kid, KID);
  assert(stages.some(row => row.stage === 'range.request' && row.part === 'header' && row.offset === 0));
  assert(stages.some(row => row.stage === 'range.progress' && row.receivedBytes === data.length));
});


test('a progressive CENC source above the WASM limit is not handed to native EME', async () => {
  const fileSize = 261 * 1024 * 1024;
  const prefix = new Uint8Array(65536);
  prefix.set(concat(ftyp, moov, mdat));
  const keySystem = fakeKeySystem();
  let calls = 0;
  const result = await openClearKeyStream({
    video: { canPlayType: () => 'probably', setMediaKeys: async () => {} },
    source: {
      url: 'https://cdn.fqnovelvod.com/large.mp4', codec: 'h264', source: 'app',
      contentKey: '00112233445566778899aabbccddeeff'
    },
    codec: 'h264', workerOrigin: 'https://worker.example',
    fetchImpl: async (_, opts) => {
      calls++;
      assert.equal(opts.headers.Range, 'bytes=0-');
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(prefix); controller.close(); }
      }), { status: 206, headers: {
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`
      } });
    },
    requestAccess: keySystem.requestAccess
  });
  assert.equal(result, null);
  assert.equal(keySystem.calls.access, 0);
  assert.equal(calls, 1);
});

test('MediaKeys attach once per element and stay attached; each episode gets its own session', async () => {
  const keySystem = fakeKeySystem();
  const attached = [];
  const video = { setMediaKeys: async keys => { attached.push(keys); } };
  const first = await ensureMediaKeys(video, keySystem.requestAccess);
  const second = await ensureMediaKeys(video, keySystem.requestAccess);
  assert.equal(first, second);
  assert.equal(keySystem.calls.access, 1);
  assert.equal(attached.length, 1, 'setMediaKeys is called once and never with null');
  const a = await openKeySession({ ...first, kid: KID, key: new Uint8Array(16) });
  const b = await openKeySession({ ...first, kid: KID, key: new Uint8Array(16) });
  assert.notEqual(a, b);
  assert.equal(keySystem.calls.sessions, 2);
  assert.deepEqual(keySystem.calls.generated[0], ['keyids', JSON.stringify({ kids: ['AQIDBAUGBwgJCgsMDQ4PEA'] })]);
  await a.close();
  assert.equal(keySystem.calls.closed, 1);
  assert.equal(attached.length, 1);
});

test('an unusable key status is an EME failure, not a source failure', async () => {
  const keySystem = fakeKeySystem({ statuses: ['internal-error'] });
  const { access, keys } = await ensureMediaKeys({ setMediaKeys: async () => {} }, keySystem.requestAccess);
  await assert.rejects(openKeySession({ access, keys, kid: KID, key: new Uint8Array(16) }),
    { code: 'EME_UNAVAILABLE' });
  assert.equal(keySystem.calls.closed, 1);
});
