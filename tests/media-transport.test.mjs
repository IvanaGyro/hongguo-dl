// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaTransport, isApprovedDirectMediaUrl, isAcceptedMediaTransportUrl } from '../src/media-transport.js';
const direct = 'https://v5-reading-video-b.qznovelvod.com/sample.mp4?token=PRIVATE';
const proxy = 'https://proxy.example/api/media?url=PRIVATE';
const range = () => new Response(new Uint8Array(16), {
  status: 206, headers: { 'Content-Range': 'bytes 0-15/100', 'Content-Length': '16' }
});
const response = (status, headers = {}, body = '') => new Response(body, { status, headers });
test('allowlisted CDN and proxy, not lookalike or non-TLS CDN hosts', () => {
  assert.equal(isApprovedDirectMediaUrl(direct), true);
  assert.equal(isApprovedDirectMediaUrl('https://qznovelvod.com.evil.example/a'), false);
  assert.equal(isApprovedDirectMediaUrl('http://qznovelvod.com/a'), false);
  assert.equal(isAcceptedMediaTransportUrl(proxy, 'https://proxy.example'), true);
  assert.equal(isAcceptedMediaTransportUrl('https://evil.example/private', 'https://proxy.example'), false);
});
test('valid CORS-visible 206 Range uses CDN without proxy', async () => {
  const seen = [];
  const transport = createMediaTransport({ directUrl: direct, proxyUrl: proxy,
    fetchImpl: async (url, opts) => { seen.push([url,opts.mode,opts.credentials]); return range(); }
  });
  assert.equal((await transport.fetch(direct, { headers: { Range: 'bytes=0-15' } })).status, 206);
  assert.equal(transport.mode, 'direct');
  assert.deepEqual(seen, [[direct, 'cors', 'omit']]);
});
test('network/CORS error selects proxy for all further requests', async () => {
  const seen = [];
  const transport = createMediaTransport({ directUrl: direct, proxyUrl: proxy,
    fetchImpl: async url => { seen.push(url); if (url === direct) throw new TypeError('CORS blocked'); return range(); }
  });
  await transport.fetch(direct, { headers: { Range: 'bytes=0-15' } });
  await transport.fetch(direct, { headers: { Range: 'bytes=16-31' } });
  assert.deepEqual(seen, [direct, proxy, proxy]);
});
test('403, 200 for Range or hidden Content-Range use proxy', async () => {
  for (const failure of [response(403), response(200), response(206, {}, new Uint8Array(16))]) {
    const seen = [];
    const transport = createMediaTransport({ directUrl: direct, proxyUrl: proxy,
      fetchImpl: async url => { seen.push(url); return url === direct ? failure : range(); } });
    assert.equal((await transport.fetch(direct, { headers: { Range: 'bytes=0-15' } })).status, 206);
    assert.deepEqual(seen, [direct, proxy]);
  }
});
test('429 does not retry through proxy', async () => {
  const seen = [];
  const transport = createMediaTransport({ directUrl: direct, proxyUrl: proxy,
    fetchImpl: async url => { seen.push(url); return response(429); } });
  assert.equal((await transport.fetch(direct, { headers: { Range: 'bytes=0-15' } })).status, 429);
  assert.deepEqual(seen, [direct]);
});


test('proxy success marks host proxy-preferred in one session', async () => {
  const seen=[],memory=new Set();
  const source = 'https://v5-reading-video-b.qznovelvod.com/different.mp4';
  const request = async url => {
    seen.push(url);
    return url === proxy ? range() : response(403);
  };
  await createMediaTransport({ directUrl: direct, proxyUrl: proxy,
    fetchImpl: request, sessionFailureCache: memory
  }).fetch(direct,{headers:{Range:'bytes=0-15'}});
  assert.equal(memory.has('v5-reading-video-b.qznovelvod.com'),true);
  await createMediaTransport({directUrl:source,proxyUrl:proxy,
    fetchImpl:request,sessionFailureCache:memory
  }).fetch(source,{headers:{Range:'bytes=0-15'}});
  assert.deepEqual(seen,[direct,proxy,proxy]);
});
test('403 on direct and proxy does not poison whole host', async () => {
  const memory = new Set();
  const transport = createMediaTransport({directUrl:direct,proxyUrl:proxy,
    fetchImpl:async()=>response(403),sessionFailureCache:memory});
  assert.equal((await transport.fetch(direct,{headers:{Range:'bytes=0-15'}})).status,403);
  assert.equal(memory.size,0);
});


test('proxy HTTP 200 that ignores Range must not mark a CDN host as proxy-preferred', async () => {
  const remembered = new Set();
  const transport = createMediaTransport({
    directUrl: direct, proxyUrl: proxy, sessionFailureCache: remembered,
    fetchImpl: async url => url === direct ? response(403) : response(200)
  });
  assert.equal((await transport.fetch(direct, {headers:{Range:'bytes=0-15'}})).status,200);
  assert.equal(remembered.size,0);
});
