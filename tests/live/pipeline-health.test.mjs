// SPDX-License-Identifier: GPL-3.0-only
// Live pipeline health: does each external service still accept what the
// current implementation sends, and still return what it can handle?
//
// Each stage is one test and depends on the one before it. When a stage
// fails, the later stages are skipped, so the first failure names the
// service that changed. Playback behaviour (decoding, seeking, resuming) is
// NOT checked here; the synthetic browser specs cover it.
//
// Bounded by design: one series request, at most two source requests, and a
// few small Range reads (no complete episode). HTTP 429 stops the run. Logs
// never contain signed URLs, device IDs, keys or media bytes.
//
//   LIVE_WORKER_ORIGIN  Worker to test (default: a local `wrangler dev`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackDeviceStore } from '../../src/playback-device.js';
import { playbackRendition } from '../../src/source-options.js';
import { probeCencKid } from '../../src/clear-key.js';

const WORKER = new URL(process.env.LIVE_WORKER_ORIGIN || 'http://127.0.0.1:8787');
const FRONTEND = 'https://ivanagyro.github.io';
const SERIES_ID = '7699513062054710296';
const MAX_SOURCE_EPISODES = 2;
const MAX_CDN_HOSTS = 2;
const PROBE_BYTES = 256;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;
// Container sample entries the app can handle, per advertised codec.
const SAMPLE_ENTRIES = { h264: ['avc1', 'avc3'], hevc: ['hvc1', 'hev1'], bytevc2: ['bvc2'] };
const CODEC_FAMILY = codec => {
  const v = String(codec || '').toLowerCase();
  if (['h264', 'avc', 'avc1'].includes(v)) return 'h264';
  if (['h265', 'hevc', 'hvc1', 'hev1', 'bytevc1'].includes(v)) return 'hevc';
  if (['bytevc2', 'bvc2'].includes(v)) return 'bytevc2';
  return null;
};

const state = {};
let blocked = null;
const summary = [];

class RateLimited extends Error {}

async function call(path, init = {}) {
  const response = await fetch(new URL(path, WORKER), {
    ...init,
    headers: { Origin: FRONTEND, ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store'
  });
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    throw new RateLimited('HTTP 429 from ' + path.split('?')[0] + ': stopped all further requests');
  }
  return response;
}

async function json(path, init) {
  const response = await call(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } });
  let body = null;
  try { body = await response.json(); } catch { /* reported below */ }
  // Error bodies carry a code and a short message, never a signed URL.
  assert.ok(response.ok, path.split('?')[0] + ': HTTP ' + response.status +
    (body?.error?.code ? ' ' + body.error.code : ''));
  assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND,
    path.split('?')[0] + ': the front-end origin is not allowed');
  assert.ok(body && typeof body === 'object', path.split('?')[0] + ': response is not JSON');
  return body;
}

function stage(name, needs, run) {
  test(name, async t => {
    if (blocked) {
      summary.push([name, 'skipped']);
      t.skip('blocked by: ' + blocked);
      return;
    }
    const missing = needs.filter(key => state[key] === undefined);
    assert.deepEqual(missing, [], 'previous stage left no ' + missing.join(', '));
    try {
      const note = await run(t);
      summary.push([name, 'pass', note]);
      if (note) t.diagnostic(note);
    } catch (error) {
      blocked = name;
      summary.push([name, error instanceof RateLimited ? 'rate limited' : 'FAIL', error.message]);
      throw error;
    }
  });
}

stage('Worker under test answers /api/health', [], async () => {
  const health = await json('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.deviceSessions, true, 'Worker no longer offers device sessions');
  assert.equal(typeof health.deviceProfile, 'string');
  state.profile = health.deviceProfile;
  return 'profile ' + health.deviceProfile;
});

stage('series page: hongguoduanju.com lists the episodes', ['profile'], async () => {
  const series = await json('/api/series?input=' + SERIES_ID);
  assert.equal(series.kind, 'series');
  assert.equal(String(series.seriesId), SERIES_ID);
  assert.ok(typeof series.title === 'string' && series.title, 'series has no title');
  assert.ok(Array.isArray(series.episodes) && series.episodes.length > 0, 'series has no episodes');
  assert.equal(series.total, series.episodes.length, 'episode count does not match the list');
  for (const [i, episode] of series.episodes.entries()) {
    assert.equal(episode.index, i + 1, 'episode indices are not sequential');
    assert.match(String(episode.vid), /^\d{1,30}$/, 'episode ' + (i + 1) + ' has no valid vid');
  }
  state.episodes = series.episodes.filter(episode => episode.available !== false)
    .slice(0, MAX_SOURCE_EPISODES);
  assert.ok(state.episodes.length, 'no episode is marked available');
  return series.episodes.length + ' episodes, ' + state.episodes.length + ' sampled';
});

stage('device registration: the App log service registers a device', ['episodes'], async () => {
  const memory = new Map();
  const devices = createPlaybackDeviceStore({
    storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) },
    locks: null, background: () => false,
    fetchImpl: (url, init) => call(new URL(url).pathname, init)
  });
  state.identity = await devices.ensure(new URL('/api/device', WORKER).href, state.profile);
  assert.ok(state.identity?.device_id, 'registration returned no device ID');
});

stage('signed source request: the App player API accepts the signatures', ['identity'], async () => {
  const failures = [];
  for (const episode of state.episodes) {
    try {
      const source = await json('/api/source?' + new URLSearchParams({ sid: SERIES_ID, vid: episode.vid }),
        { headers: { 'X-Playback-Device': JSON.stringify(state.identity) } });
      const variants = (source.variants || []).filter(v => /^https:\/\//.test(v.url || ''));
      assert.ok(variants.length, 'episode ' + episode.index + ' returned no HTTPS variants');
      for (const v of variants)
        assert.ok(v.codec && v.quality, 'a variant lacks codec or quality metadata');
      const known = variants.filter(v => CODEC_FAMILY(v.codec));
      assert.ok(known.length, 'no variant uses a codec the app knows: ' +
        [...new Set(variants.map(v => v.codec))].join(', '));
      state.episode = episode;
      state.variants = known;
      const codecs = [...new Set(known.map(v => CODEC_FAMILY(v.codec) + '/' + v.quality))];
      return 'episode ' + episode.index + ': ' + variants.length + ' variants (' + codecs.join(', ') + ')';
    } catch (error) {
      if (error instanceof RateLimited) throw error;
      failures.push('episode ' + episode.index + ': ' + error.message);
    }
  }
  assert.fail(failures.join('; '));
});

stage('CDN: a small Range read succeeds through /api/media', ['variants'], async () => {
  // The variant the player would pick when every codec is playable.
  const chosen = playbackRendition(state.variants, {}, () => 'probably', 0, true).source;
  assert.ok(chosen, 'the player would not choose any variant');
  const sameTier = state.variants.filter(v => v.codec === chosen.codec && v.quality === chosen.quality);
  const hosts = new Set(), statuses = [];
  for (const variant of [chosen, ...sameTier]) {
    const host = new URL(variant.url).hostname;
    if (hosts.has(host) || hosts.size >= MAX_CDN_HOSTS) continue;
    hosts.add(host);
    const path = '/api/media?' + new URLSearchParams({ url: variant.url, profile: variant.source === 'app' ? 'app' : 'web' });
    const response = await call(path, { headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) } });
    statuses.push(response.status);
    if (response.status !== 206) { await response.body?.cancel().catch(() => {}); continue; }
    try {
      assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND, 'media CORS is missing');
      assert.match(response.headers.get('access-control-expose-headers') || '', /content-range/i,
        'Content-Range is not exposed to the page');
      const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      assert.ok(range && Number(range[1]) < PROBE_BYTES, 'invalid Content-Range for a ' + PROBE_BYTES + '-byte read');
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.ok(bytes.length > 0 && bytes.length <= PROBE_BYTES, 'unexpected body size ' + bytes.length);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    state.media = { variant, path };
    return CODEC_FAMILY(variant.codec) + '/' + variant.quality + ', HTTP ' + statuses.join(',');
  }
  assert.fail('no CDN host returned 206 Partial Content (HTTP ' + statuses.join(',') + ')');
});

stage('media format: the container and encryption are ones the app handles', ['media'], async () => {
  const { variant, path } = state.media;
  let requested = 0;
  const boundedFetch = async (url, init) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || '');
    assert.ok(range, 'only explicit Range reads are allowed');
    requested += Number(range[2]) - Number(range[1]) + 1;
    assert.ok(requested <= MAX_METADATA_BYTES, 'MP4 metadata needs more than ' + MAX_METADATA_BYTES + ' bytes');
    return call(new URL(url).pathname + new URL(url).search, { headers: init.headers, signal: init.signal });
  };
  const metadata = {};
  const kid = await probeCencKid(new URL(path, WORKER).href, null, boundedFetch, metadata);
  assert.ok(metadata.videoCodec, 'no moov or video track found in the first ' + requested + ' bytes');
  const family = CODEC_FAMILY(variant.codec);
  assert.ok(SAMPLE_ENTRIES[family].includes(metadata.videoCodec),
    'advertised ' + family + ' but the sample entry is ' + metadata.videoCodec);
  if (variant.contentKey) assert.ok(kid, 'encrypted variant has no CENC key ID (tenc)');
  return [family + ' in ' + metadata.videoCodec, variant.contentKey ? 'CENC' : 'clear',
    metadata.fragmented ? 'fragmented' : 'progressive', metadata.hasAac ? 'AAC' : 'no AAC',
    requested + ' bytes read'].join(', ');
});

test.after(async () => {
  const lines = summary.map(([name, result, note]) => '| ' + name + ' | ' + result + ' | ' + (note || '') + ' |');
  const table = '### Live pipeline health\n\nWorker: ' + (WORKER.hostname === '127.0.0.1' ? 'local (repository code)' : WORKER.origin) +
    '\n\n| Stage | Result | Detail |\n| --- | --- | --- |\n' + lines.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, table);
  }
});
