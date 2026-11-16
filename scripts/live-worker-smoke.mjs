// Bounded REAL upstream smoke: no signed URLs or media keys in diagnostics.
// Runs only from the dedicated weekly/manual workflow, never on every push.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERIES_ID = '7699513062054710296';
const FRONTEND_ORIGIN = 'https://ivanagyro.github.io';
const DEFAULT_WORKER = 'https://hongguo-dl.ivana-gyro.workers.dev';
const RANGE_BYTES = 256;
const MAX_MEDIA_PROBES = 2;
const TIMEOUT_MS = 20000;

function checkEpisodeCount(value) {
  if (value !== 1 && value !== 2) throw new Error('Live smoke permits only 1 or 2 episodes');
  return value;
}

async function readJson(response, context) {
  if (!response.ok) {
    // Do not print response bodies, CDN URLs, cookies or signed credentials.
    throw new Error(context + ': HTTP ' + response.status);
  }
  assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN,
    context + ': cross-origin access is missing');
  return response.json();
}

function variantsForProbe(variants) {
  assert.ok(Array.isArray(variants) && variants.length, 'No source variants');
  const primary = variants[0];
  assert.ok(primary.url && primary.codec && primary.quality,
    'First source lacks URL, codec or quality metadata');
  const seenHosts = new Set();
  const choices = [];
  for (const variant of variants) {
    if (variant.codec !== primary.codec || variant.quality !== primary.quality) continue;
    let url;
    try { url = new URL(variant.url); } catch { continue; }
    if (url.protocol !== 'https:' || seenHosts.has(url.hostname)) continue;
    seenHosts.add(url.hostname);
    choices.push(variant);
    if (choices.length === MAX_MEDIA_PROBES) break;
  }
  assert.ok(choices.length, 'No HTTPS CDN candidates for selected rendition');
  return choices;
}

export async function runLiveSmoke({
  fetchImpl = fetch,
  workerOrigin = DEFAULT_WORKER,
  episodeCount = 1,
  log = console.log
} = {}) {
  checkEpisodeCount(episodeCount);
  const origin = new URL(workerOrigin);
  assert.equal(origin.protocol, 'https:', 'Worker origin must use HTTPS');
  assert.equal(origin.pathname, '/', 'Worker origin must be a root URL');
  let requests = 0;
  const budget = 1 + episodeCount * (1 + MAX_MEDIA_PROBES);
  const get = async (path, headers) => {
    if (++requests > budget) throw new Error('Live upstream request budget exceeded');
    return fetchImpl(new URL(path, origin), {
      method: 'GET',
      headers: { Origin: FRONTEND_ORIGIN, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
      cache: 'no-store'
    });
  };
  const series = await readJson(
    await get('/api/series?input=' + encodeURIComponent(SERIES_ID),
      { Accept: 'application/json' }), 'series');
  assert.equal(series.kind, 'series');
  assert.equal(String(series.seriesId), SERIES_ID);
  assert.ok(typeof series.title === 'string' && series.title, 'Missing series title');
  assert.ok(Array.isArray(series.episodes) && series.episodes.length > 0);
  assert.equal(series.total, series.episodes.length, 'Inconsistent episode count');
  const ids = new Set();
  for (const [i, ep] of series.episodes.entries()) {
    assert.equal(ep.index, i + 1, 'Non-sequential episode index');
    assert.match(String(ep.vid), /^\d{1,30}$/, 'Invalid episode vid');
    assert.ok(!ids.has(ep.vid), 'Duplicate episode vid');
    ids.add(ep.vid);
  }
  // Inspect the complete *metadata* list but resolve media for at most 2 episodes.
  const sample = series.episodes.filter(ep => ep.available !== false).slice(0, episodeCount);
  assert.equal(sample.length, episodeCount, 'Not enough accessible sample episodes');
  log('Live series metadata: ' + series.episodes.length +
    ' episodes listed; inspecting only ' + sample.length + ' source(s)');
  const results = [];
  for (const episode of sample) {
    const params = new URLSearchParams({
      sid: SERIES_ID, vid: episode.vid
    });
    const source = await readJson(
      await get('/api/source?' + params, { Accept: 'application/json' }),
      'source episode #' + episode.index);
    const variants = source.variants;
    const choices = variantsForProbe(variants);
    const codec = choices[0].codec;
    const quality = choices[0].quality;
    const probes = [];
    let passed = false;
    for (const variant of choices) {
      // Only 256 bytes per media request; never fetch the entire episode.
      const endpoint = '/api/media?' + new URLSearchParams({
        url: variant.url, profile: variant.source === 'app' ? 'app' : 'web'
      });
      let response;
      try {
        response = await get(endpoint, { Range: 'bytes=0-' + (RANGE_BYTES - 1) });
        const status = response.status;
        const entry = { status, ok: false };
        probes.push(entry);
        if (status === 429) throw new Error('HTTP 429 rate limited: stop immediately');
        if (status !== 206) {
          await response.body?.cancel();
          continue; // One different CDN may be accessible; no repeated requests.
        }
        assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN,
          'Media CORS missing');
        const exposed = response.headers.get('access-control-expose-headers') || '';
        assert.match(exposed, /content-range/i, 'Content-Range is not CORS-exposed');
        assert.match(response.headers.get('content-type') || '',
          /^(video\/|application\/octet-stream)/i, 'Response is not media');
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') || '');
        assert.ok(range, 'Invalid Content-Range');
        assert.equal(Number(range[1]), 0, 'Range starts at wrong offset');
        assert.ok(Number(range[2]) < RANGE_BYTES && Number(range[3]) > Number(range[2]),
          'Range exceeds 256-byte probe');
        const sizeHeader = response.headers.get('content-length');
        if (sizeHeader != null) assert.ok(Number(sizeHeader) <= RANGE_BYTES,
          'Response advertised more bytes than requested');
        const reader = response.body?.getReader();
        assert.ok(reader, 'Missing media ReadableStream');
        try {
          const first = await reader.read();
          assert.ok(!first.done && first.value?.byteLength > 0,
            'No bytes from media stream');
          assert.ok(first.value.byteLength <= RANGE_BYTES, 'Oversized media chunk');
          entry.ok = true;
          passed = true;
        } finally { await reader.cancel().catch(() => {}); }
        break;
      } catch (error) {
        if (response?.body && !response.body.locked)
          await response.body.cancel().catch(() => {});
        if (String(error.message).includes('429')) throw error;
        // Transport failures are diagnostics; never retry the same CDN.
        probes.push({ status: 'network-error', ok: false });
      }
    }
    const statuses = probes.map(p => String(p.status)).join(',');
    log('Episode #' + episode.index + ': ' + variants.length +
      ' variant URLs; chosen ' + codec + '/' + quality +
      '; CDN probe status ' + statuses + (passed ? ' ✓' : ' ✗'));
    results.push({ episode: episode.index, codec, quality, probes, passed });
    if (!passed) throw new Error('Episode #' + episode.index +
      ': no CDN returned a valid 206 Partial Content (' + statuses + ')');
  }
  return { totalEpisodes: series.total, checkedEpisodes: results.length,
    requestCount: requests, requestBudget: budget, results };
}

const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const episodeCount = Number(process.env.LIVE_EPISODES || '1');
  try {
    const result = await runLiveSmoke({ episodeCount });
    console.log('Live upstream smoke passed: ' + result.checkedEpisodes +
      ' episode(s), ' + result.requestCount + '/' + result.requestBudget +
      ' HTTP requests');
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        '### Live origin smoke\n\n- Episodes checked: ' + result.checkedEpisodes +
        ' / ' + result.totalEpisodes + '\n- HTTP requests: ' + result.requestCount +
        ' / ' + result.requestBudget +
        '\n- Media: 256-byte Range only, no complete videos\n');
    }
  } catch (error) {
    console.error('Live upstream smoke failed: ' + error.message);
    process.exitCode = 1;
  }
}
