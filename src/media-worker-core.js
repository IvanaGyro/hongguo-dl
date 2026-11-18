// SPDX-License-Identifier: GPL-3.0-only
// Media Worker reconciler. The main thread only declares demands (`need`,
// `dont-need`), reports capabilities and acknowledges output. This module
// reconciles those demands against the Worker's two layers:
//   layer 1, download (media-source.js): HTTP, metadata probe, byte cache;
//   layer 2, processing (media-engine.js): WASM demux/decrypt/remux/transcode.
// A 'whole-file' demand reads the complete source through layer 1's reader,
// so bytes already cached by metadata probing or streaming are not fetched
// again, and transfers the assembled file to the main thread.
// Both layers live in this one Worker; they communicate by function calls,
// never by per-read messages or cross-thread stream transfers.
import { createDemandTable, wantsReadAhead } from './media-demand.js';
import { createMediaSource } from './media-source.js';
import { createEngineJob } from './media-engine.js';
import { createPassthroughJob, probeFragmentLayout } from './fmp4-passthrough.js';
import { decideMediaRoute } from './media-route.js';
import { clampStreamSeek } from './cenc-seek.js';

const PUBLIC_SOURCE_CODES = /^(?:CENC_[A-Z_]{2,45}|CANCELED|MEDIA_SOURCE_INVALID)$/;
const WHOLE_FILE_READ = 1024 * 1024;
const WHOLE_FILE_PROGRESS = 512 * 1024;

export function createMediaWorkerCore({ post, fetchImpl = (...args) => fetch(...args), origin,
  loadRuntime = () => Promise.reject(new Error('Media runtime unavailable')), cacheBudget }) {
  const demands = createDemandTable();
  const sources = new Map();      // sourceKey -> { media, consumers notified }
  const delivered = new Map();    // demand id -> { metadata, route, error } revisions sent
  const runtime = { core: null, bridge: null, io: null };
  let capabilities = { processing: { cenc: false, bvc2: false }, types: {} };
  const requestedTypes = new Set();
  let job = null, closed = false;
  const wholeFiles = new Map();   // demand id -> AbortController of a whole-file read
  const stage = (name, fields = {}) => post({ type: 'stage', stage: name, ...fields });

  function failureCodeFor(demand) {
    return demand?.source.bridge === 'bvc2' ? 'BVC2_TRANSCODE_FAILED' : 'CENC_REMUX_FAILED';
  }
  function sendError(demand, fields) {
    const sent = delivered.get(demand.id) || {};
    if (sent.error) return;
    delivered.set(demand.id, { ...sent, error: true });
    post({ type: 'error', demand: demand.id, revision: demand.revision, ...fields });
  }
  function openSource(demand) {
    const key = demand.sourceKey;
    // `layout`: fragmented-MP4 init + index; undefined until probed, null if none.
    const entry = { failure: null, media: null, layout: undefined, layoutProbe: null };
    entry.media = createMediaSource({
      source: demand.source, origin, fetchImpl, cacheBudget, onStage: stage,
      onFailure: fields => failSource(key, { code: fields.code, status: fields.status || 0 })
    });
    entry.media.opened.then(() => reconcile(), error => {
      if (closed || sources.get(key) !== entry) return;
      entry.failure = {
        code: PUBLIC_SOURCE_CODES.test(error?.code || '') ? error.code : 'METADATA_PROBE_FAILED',
        status: Number.isInteger(error?.status) ? error.status : 0,
        ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {})
      };
      reconcile();
    });
    sources.set(key, entry);
    return entry;
  }
  // Every consumer of a failed source sees the same failure. Only the owner
  // of the candidate list (main-thread layer 1) chooses another CDN.
  function failSource(key, fields) {
    const entry = sources.get(key);
    if (!entry || entry.failure) return;
    entry.failure = fields;
    if (job?.sourceKey === key) job.engine.sourceFailure(fields);
    else reconcile();
  }
  // The most recent job's unwinding; a new job waits for it before using
  // the shared engine instance.
  let unwinding = Promise.resolve();
  function stopJob() {
    if (!job) return Promise.resolve(null);
    const stopping = job;
    job = null;
    const stopped = stopping.engine.stop();
    unwinding = stopped;
    return stopped.then(() => stopping);
  }

  function serveMetadata(demand, entry) {
    const sent = delivered.get(demand.id) || {};
    if (sent.metadata) return;
    delivered.set(demand.id, { ...sent, metadata: true });
    post({ type: 'metadata', demand: demand.id, revision: demand.revision,
      metadata: entry.media.metadata });
  }
  // Probe a fragmented source's init segment and index once, from the cache.
  function probeLayout(key, entry) {
    if (entry.layoutProbe) return;
    const controller = new AbortController();
    entry.layoutProbe = controller;
    probeFragmentLayout(entry.media.reader(), entry.media.metadata.fileSize, controller.signal).then(layout => {
      entry.layout = layout;
      stage('fmp4.index', { kind: layout?.index.kind || 'none',
        points: layout ? (layout.index.entries?.length ?? [...layout.index.tracks.values()][0].length) : 0 });
    }, error => {
      if (closed || controller.signal.aborted) return;
      if (/^CENC_(?:SOURCE|RANGE|RATE)/.test(error?.code || ''))
        return failSource(key, { code: error.code, status: error.status || 0 });
      entry.layout = null;
      stage('fmp4.index', { kind: 'invalid' });
    }).finally(() => { if (sources.get(key) === entry) reconcile(); });
  }
  function routeFor(demand, entry) {
    const sent = delivered.get(demand.id) || {};
    // A route is chosen once per demand source; later revisions only move
    // the position or change playback state within that route.
    if (sent.route) return sent.route;
    const metadata = entry.media.metadata;
    const decision = decideMediaRoute({
      bridge: demand.source.bridge, codec: demand.codec, metadata,
      processing: Boolean(capabilities.processing?.[demand.source.bridge]),
      typeSupport: capabilities.types, eme: demand.eme,
      fragmentIndex: entry.layout === undefined ? undefined : entry.layout?.index || null
    });
    if (decision.kind === 'pending-index') {
      probeLayout(demand.sourceKey, entry);
      return null;
    }
    if (decision.kind === 'pending') {
      const missing = decision.types.filter(type => !requestedTypes.has(type));
      for (const type of missing) requestedTypes.add(type);
      if (missing.length) post({ type: 'capability-request', types: missing });
      return null;
    }
    if (decision.check) stage('mse.codec-check', { codec: demand.source.bridge === 'bvc2' ? 'h264' : demand.codec,
      codecString: decision.candidates.videoCodec, hasAac: decision.candidates.hasAac, ...decision.check });
    const durationSeconds = metadata.durationSeconds || demand.durationHint || null;
    const route = {
      kind: decision.kind, reason: decision.reason, code: decision.code,
      mime: decision.candidates?.mime || null, alternateMime: decision.candidates?.alternateMime || null,
      videoCodec: decision.candidates?.videoCodec || null, hasAac: metadata.hasAac,
      fileSize: metadata.fileSize, durationSeconds,
      startSeconds: clampStreamSeek(demand.positionSeconds, durationSeconds) ?? 0
    };
    delivered.set(demand.id, { ...sent, route });
    if (route.kind === 'error') {
      sendError(demand, { code: route.code, status: 0, phase: 'route' });
      return route;
    }
    if (route.kind === 'unsupported' && demand.source.bridge === 'cenc')
      stage('cenc.remux-unavailable', { codec: demand.codec, reason: route.reason });
    post({ type: 'route', demand: demand.id, revision: demand.revision, route });
    return route;
  }
  function serveWholeFile(demand, entry) {
    const sent = delivered.get(demand.id) || {};
    if (sent.wholeFile) return;
    delivered.set(demand.id, { ...sent, wholeFile: true });
    const { fileSize } = entry.media.metadata;
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > demand.maxBytes) {
      sendError(demand, { code: 'MEMORY_LIMIT', status: 0, phase: 'whole-file' });
      return;
    }
    const controller = new AbortController();
    wholeFiles.set(demand.id, controller);
    const reader = entry.media.reader();
    // Keep the single response pump running ahead of the sequential copy.
    reader.prefetch(true);
    const before = reader.snapshot();
    stage('whole-file.begin', { fileBytes: fileSize, cachedBytes: before.cachedBytes || 0,
      requests: before.requests || 0 });
    const output = new Uint8Array(fileSize);
    (async () => {
      let offset = 0, reported = 0;
      while (offset < fileSize) {
        const bytes = await reader.read(offset, Math.min(WHOLE_FILE_READ, fileSize - offset), controller.signal);
        output.set(bytes, offset);
        offset += bytes.length;
        if (offset - reported >= WHOLE_FILE_PROGRESS || offset === fileSize) {
          reported = offset;
          post({ type: 'whole-file.progress', demand: demand.id, received: offset, total: fileSize });
        }
      }
      const after = reader.networkStats;
      stage('whole-file.complete', { fileBytes: fileSize, requests: after.requests,
        downloadedBytes: after.downloadedBytes });
      if (wholeFiles.get(demand.id) !== controller) return;
      wholeFiles.delete(demand.id);
      post({ type: 'whole-file', demand: demand.id, revision: demand.revision, bytes: output.buffer },
        [output.buffer]);
    })().catch(error => {
      if (wholeFiles.get(demand.id) === controller) wholeFiles.delete(demand.id);
      if (closed || controller.signal.aborted) return;
      const current = demands.get(demand.id);
      if (!current) return;
      sendError(current, {
        code: PUBLIC_SOURCE_CODES.test(error?.code || '') ? error.code : 'CENC_RANGE_HTTP',
        status: Number.isInteger(error?.status) ? error.status : 0, phase: 'whole-file',
        ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {})
      });
    });
  }
  function stopWholeFiles(keep = () => false) {
    for (const [id, controller] of wholeFiles) {
      if (keep(id)) continue;
      controller.abort();
      wholeFiles.delete(id);
    }
  }
  function servePlayable(demand, entry) {
    const route = routeFor(demand, entry);
    if (!route || !['mse', 'eme'].includes(route.kind)) return;
    if (job && job.demandId === demand.id && job.sourceKey === demand.sourceKey &&
        job.key === demand.source.key && job.kind === route.kind) {
      const target = clampStreamSeek(demand.positionSeconds, route.durationSeconds) ?? 0;
      job.engine.seek(target, demand.positionRevision);
    } else {
      if (job) void stopJob();
      const reader = entry.media.reader();
      const onError = fields => {
        const current = demands.get(demand.id);
        if (current) sendError(current, { ...fields, phase: 'processing' });
      };
      job = {
        demandId: demand.id, sourceKey: demand.sourceKey, key: demand.source.key, reader, kind: route.kind,
        engine: route.kind === 'eme' ? createPassthroughJob({
          reader, fileSize: route.fileSize, layout: entry.layout, position: route.startSeconds,
          generation: demand.positionRevision, post, onStage: stage, onError
        }) : createEngineJob({
          bridge: demand.source.bridge, reader, fileSize: route.fileSize, key: demand.source.key,
          runtime, loadRuntime, position: route.startSeconds, generation: demand.positionRevision,
          processing: demand.processing, post, onStage: stage, after: unwinding, onError
        })
      };
    }
    if (demand.processing) job.engine.allowProcessing();
    job.reader.prefetch(wantsReadAhead(demand));
  }

  function reconcile() {
    if (closed) return;
    const wanted = demands.sourceKeys();
    stopWholeFiles(id => demands.get(id)?.output === 'whole-file');
    if (job && (!wanted.has(job.sourceKey) || demands.playable()?.id !== job.demandId)) void stopJob();
    for (const [key, entry] of sources) {
      if (wanted.has(key)) continue;
      entry.layoutProbe?.abort();
      entry.media.close();
      sources.delete(key);
    }
    for (const demand of demands.values()) {
      const entry = sources.get(demand.sourceKey) || openSource(demand);
      if (entry.failure) { sendError(demand, { ...entry.failure, phase: 'source' }); continue; }
      if (!entry.media.metadata) continue;
      serveMetadata(demand, entry);
      if (demand.output === 'playable-media') servePlayable(demand, entry);
      else if (demand.output === 'whole-file') serveWholeFile(demand, entry);
    }
    // Bounded metadata consumers do not keep a CDN response open.
    for (const [key, entry] of sources) {
      if (!entry.media.metadata || entry.media.readerOpen) continue;
      if (!demands.consumers(key).some(demand => demand.output !== 'metadata'))
        entry.media.releaseNetwork();
    }
  }

  function dropAll() {
    stopWholeFiles();
    demands.clear(); delivered.clear();
    for (const entry of sources.values()) { entry.layoutProbe?.abort(); entry.media.close(); }
    sources.clear();
    return stopJob();
  }

  return {
    handle(data) {
      if (closed || !data || typeof data !== 'object') return;
      switch (data.type) {
        case 'capabilities': {
          const next = data.capabilities || {};
          capabilities = {
            processing: { ...capabilities.processing, ...(next.processing || {}) },
            types: { ...capabilities.types }
          };
          for (const [type, supported] of Object.entries(next.types || {}))
            if (typeof type === 'string' && typeof supported === 'boolean') capabilities.types[type] = supported;
          reconcile();
          return;
        }
        case 'need': {
          let result;
          try { result = demands.upsert(data.demand); }
          catch (error) {
            post({ type: 'error', demand: typeof data.demand?.id === 'string' ? data.demand.id : null,
              code: error?.code === 'MEDIA_DEMAND_BUSY' ? 'MEDIA_DEMAND_BUSY'
                : failureCodeFor({ source: { bridge: data.demand?.source?.bridge } }), status: 0 });
            return;
          }
          if (result.status === 'stale' || result.status === 'unchanged') return;
          if (result.sourceChanged) delivered.delete(result.demand.id);
          reconcile();
          return;
        }
        case 'dont-need':
          if (demands.remove(data.id)) { delivered.delete(data.id); reconcile(); }
          return;
        case 'ack':
          job?.engine.ack(data.id);
          return;
        case 'release':
        case 'cancel':
          // Release returns the engine to the pool only after the read loop
          // unwinds; an interrupted engine call is never lent out again.
          void dropAll().then(stopped => {
            if (data.type === 'release') post({ type: 'idle',
              reusable: Boolean(runtime.core) && (!stopped || stopped.engine.reusable) });
          });
          return;
      }
    },
    get demands() { return demands.values(); },
    get sourceCount() { return sources.size; },
    close() { closed = true; void dropAll(); }
  };
}
