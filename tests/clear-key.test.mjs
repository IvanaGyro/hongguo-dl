import test from 'node:test';
import assert from 'node:assert/strict';
import { mp4Boxes, cencKidFromMoov, probeCencKid, clearKeyLicense,
  mimeForCodec, openClearKeyStream, commonCencPssh } from '../src/clear-key.js';

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
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    assert(match);
    const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
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
  const metadata = await probeCencKid('https://example.com/too-large.mp4', null,
    async () => {
      calls++;
      return new Response(header, { status: 206, headers: {
        'Content-Range': 'bytes 0-65535/10000000'
      } });
    });
  assert.equal(metadata, null);
  assert.equal(calls, 1, 'A giant index must not trigger extra Range or whole-file fetch');
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

test('prefers browser native EME and prepares license before fetching media', async () => {
  const f = mockFetch(concat(ftyp, moov, mdat));
  let keys = null, updated = null, generated = null, sessionClosed = false;
  const listeners = new Map();
  const session = {
    addEventListener: (name, cb) => listeners.set(name, cb),
    generateRequest: async (type, data) => {
      generated = [type, new TextDecoder().decode(data)];
      queueMicrotask(() => listeners.get('message')({
        message: new TextEncoder().encode(JSON.stringify({
          kids: ['AQIDBAUGBwgJCgsMDQ4PEA'], type: 'temporary'
        }))
      }));
    },
    update: async bytes => { updated = JSON.parse(new TextDecoder().decode(bytes)); },
    close: async () => { sessionClosed = true; }
  };
  const video = { canPlayType: () => 'probably', setMediaKeys: async x => { keys = x; } };
  const access = { createMediaKeys: async () => ({ createSession: () => session }) };
  const result = await openClearKeyStream({
    video, source: { url: 'https://cdn.example/mp4', codec: 'h264',
      contentKey: '00112233445566778899aabbccddeeff', source: 'app' },
    codec: 'h264', workerOrigin: 'https://worker.example',
    fetchImpl: f.fetchImpl, requestAccess: async () => access
  });
  assert.ok(result?.url.includes('/api/media?'));
  assert.equal(generated[0], 'keyids');
  assert.equal(updated.keys.length, 1);
  assert.ok(keys);
  await result.close();
  assert.equal(sessionClosed, true);
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
  await assert.rejects(pending, /已切換影片/);
  assert.equal(opened, 1);
  assert.equal(canceled, 1, 'Metadata stream must be canceled immediately on abort');
});
