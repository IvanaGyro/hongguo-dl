// SPDX-License-Identifier: GPL-3.0-only
// Media Worker, layer 2 (processing): Librempeg Asyncify AVIO reads bytes
// from the layer-1 cache in this same Worker and produces complete clear
// fMP4 init/media units. The consumer's ACK provides backpressure.
import { createFmp4Assembler } from './fmp4-assembler.js';
import { verifyCencRuntimeBundle, readLimitedAsset } from './cenc-bundle.js';
import { verifyBvc2RuntimeBundle } from './bvc2-bundle.js';

const canceled = () => Object.assign(new Error('Canceled'), { code: 'CANCELED' });

/** Download, verify and instantiate the pinned WASM runtime for a bridge. */
export async function loadMediaRuntime({ bridge, signal, onStage, hooks, baseHref, baseUrl }) {
  const runtime = bridge === 'bvc2' ? 'bvc2' : 'cenc';
  const base = new URL((baseUrl ?? import.meta.env.BASE_URL) + runtime + '/', baseHref);
  const moduleUrl = new URL(runtime + '-core.mjs', base);
  const wasmUrl = new URL(runtime + '-core.wasm', base);
  const manifestUrl = new URL('manifest.json', base);
  onStage('wasm-download');
  const manifestResponse = await fetch(manifestUrl, { signal, cache: 'no-store' });
  if (!manifestResponse.ok) throw new Error('CENC release manifest unavailable');
  const manifestBytes = await readLimitedAsset(manifestResponse, 4096);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest?.schema !== 1 ||
      !/^[a-f0-9]{64}$/.test(manifest?.files?.[runtime + '-core.mjs']) ||
      !/^[a-f0-9]{64}$/.test(manifest?.files?.[runtime + '-core.wasm']))
    throw new Error('Invalid CENC release manifest');
  // Content-address URLs prevent old HTTP cache entries from being reused
  // across Pages deployments. Verify downloaded bytes before running code.
  moduleUrl.searchParams.set('v', manifest.files[runtime + '-core.mjs']);
  wasmUrl.searchParams.set('v', manifest.files[runtime + '-core.wasm']);
  const [moduleResponse, wasmResponse] = await Promise.all([
    fetch(moduleUrl, { signal, cache: 'force-cache' }),
    fetch(wasmUrl, { signal, cache: 'force-cache' })
  ]);
  const [moduleBytes, wasmBytes] = await Promise.all([
    readLimitedAsset(moduleResponse, 1024 * 1024),
    readLimitedAsset(wasmResponse, (bridge === 'bvc2' ? 32 : 24) * 1024 * 1024)
  ]);
  onStage('wasm-verify');
  await (bridge === 'bvc2' ? verifyBvc2RuntimeBundle : verifyCencRuntimeBundle)(manifest, moduleBytes, wasmBytes);
  if (signal.aborted) throw canceled();
  const { default: createModule } = await import(/* @vite-ignore */ moduleUrl.href);
  onStage('wasm-start');
  return createModule({ wasmBinary: wasmBytes, ...hooks });
}

/**
 * One playable output over one source reader. The engine instance itself
 * (runtime.core) outlives jobs; I/O callbacks always target the active job.
 * Position changes restart the demuxer in place with the same engine/cache.
 */
export function createEngineJob({ bridge, reader, fileSize, key, runtime, loadRuntime,
  position, generation: initialGeneration, processing = true, post, onStage, onError,
  after = null, render = false }) {
  const controller = new AbortController();
  const failureCode = bridge === 'bvc2' ? 'BVC2_TRANSCODE_FAILED' : 'CENC_REMUX_FAILED';
  let pendingAck = null, seq = 0, generation = initialGeneration;
  let requestedSeek = { seconds: position, generation: initialGeneration }, latestRequested = initialGeneration;
  let wake = null, activeRun = null, lastRangeError = null;
  let processingAllowed = processing, processingWake = null;
  let completed = false, engineStarted = false, sourceFailed = false, io = null;

  // fMP4 units and (render mode) decoded pictures share one ACK channel, so
  // the consumer's backpressure stops the single WASM loop for both.
  const sendUnit = (type, data, fields = {}) => new Promise((resolve, reject) => {
    if (controller.signal.aborted || activeRun?.signal.aborted) return reject(canceled());
    if (pendingAck) return reject(new Error('Transport already awaiting ACK'));
    const id = ++seq;
    pendingAck = { id, resolve, reject };
    post({ type, id, generation, bytes: data.buffer, ...fields }, [data.buffer]);
  });
  let frames = 0;
  let rangeRequests = 0;
  const readRange = async (start, wanted) => {
    const fetchStarted = performance.now();
    try {
      const bytes = await reader.read(start, wanted, activeRun?.signal);
      rangeRequests++;
      if (rangeRequests <= 4 || rangeRequests % 12 === 0)
        onStage('media-range', { requests: reader.networkStats.requests,
          receivedBytes: reader.networkStats.downloadedBytes,
          fetchMs: Math.round(performance.now() - fetchStarted) });
      return bytes;
    } catch (error) {
      if (activeRun?.signal.aborted) throw canceled();
      lastRangeError = {
        code: /^CENC_[A-Z_]{2,45}$/.test(error?.code || '') ? error.code : 'CENC_RANGE_HTTP',
        status: Number.isInteger(error?.status) ? error.status : 0,
        retryAfterMs: error.retryAfterMs
      };
      onStage('media-range-failed', { request: reader.networkStats.requests, offset: start,
        bytes: wanted, ...lastRangeError, fetchMs: Math.round(performance.now() - fetchStarted) });
      reportSourceFailure(lastRangeError);
      // Keep Asyncify suspended until the owner discards this failed Worker.
      // Returning EIO here resumes a partial encrypted sample and can produce
      // misleading corruption diagnostics before the CDN switch is handled.
      return await new Promise(() => {});
    }
  };
  function reportSourceFailure(fields) {
    if (sourceFailed) return;
    sourceFailed = true;
    onError({ code: fields.code, status: fields.status,
      ...(Number.isFinite(fields.retryAfterMs) ? { retryAfterMs: fields.retryAfterMs } : {}) });
  }

  async function run() {
    // Never enter the engine while a replaced job may still be inside it.
    // A job that cannot unwind leaves its instance unusable for others.
    if (after) {
      let timer;
      const unwound = await Promise.race([after.then(() => true),
        new Promise(resolve => { timer = setTimeout(resolve, 1000, false); })]);
      clearTimeout(timer);
      if (!unwound) { runtime.core = null; runtime.bridge = null; }
      if (controller.signal.aborted) return;
    }
    if (!processingAllowed) {
      // HTTP/cache work is independent of WASM and can overlap the prior episode.
      onStage('processing.waiting');
      await new Promise(resolve => { processingWake = resolve; });
      if (controller.signal.aborted) return;
      onStage('processing.started');
    }
    let assembler;
    io = {
      readRange,
      writeChunk: data => {
        if (activeRun?.signal.aborted) throw canceled();
        return assembler.push(data);
      },
      writeFrame: (data, info) => {
        if (activeRun?.signal.aborted) throw canceled();
        const width = info?.width | 0, height = info?.height | 0;
        if (width < 16 || height < 16 || width > 4096 || height > 4096 || !Number.isFinite(info?.pts))
          throw new Error('Invalid decoded frame');
        if (++frames === 1) onStage('render.first-decoded', { width, height });
        return sendUnit('frame', data, { width, height, pts: info.pts, flags: info.flags | 0 });
      },
      printErr: message => { if (!activeRun?.signal.aborted) console.error(message); }
    };
    if (runtime.core && runtime.bridge !== bridge) throw new Error('Worker engine mismatch');
    runtime.io = io;
    if (!runtime.core) {
      runtime.core = await loadRuntime(bridge, controller.signal, onStage, {
        readRange: (...args) => runtime.io.readRange(...args),
        writeChunk: data => runtime.io.writeChunk(data),
        writeFrame: (data, info) => runtime.io.writeFrame(data, info),
        printErr: message => runtime.io?.printErr(message)
      });
      runtime.bridge = bridge;
    }
    if (controller.signal.aborted) return;
    const core = runtime.core;
    if (bridge === 'bvc2' && (core._bvc2_decoder_available?.() !== 1 ||
        typeof (render ? core._bvc2_play : core._bvc2_stream) !== 'function'))
      throw new Error('BVC2 streaming API unavailable');
    if (bridge === 'cenc' && core._cenc_remux_available() !== 1)
      throw new Error('WASM missing MOV demuxer or MP4 muxer');
    while (!controller.signal.aborted) {
      if (!requestedSeek) await new Promise(resolve => { wake = resolve; });
      if (controller.signal.aborted) break;
      const request = requestedSeek; requestedSeek = null;
      if (bridge === 'cenc' && request.seconds > 0.5 && typeof core._cenc_stream_remux_at !== 'function')
        throw new Error('CENC remux WASM seek API unavailable');
      generation = request.generation;
      activeRun = new AbortController();
      lastRangeError = null; core.bridgeError = null;
      assembler = createFmp4Assembler({
        onInit: data => sendUnit('init', data),
        onMedia: data => sendUnit('media', data)
      });
      onStage('seek.run', { generation, target: request.seconds,
        workerReused: generation !== initialGeneration, indexCached: true });
      onStage('first-fragment');
      engineStarted = true; completed = false;
      frames = 0;
      const ret = bridge === 'bvc2'
        ? await core.ccall(render ? 'bvc2_play' : 'bvc2_stream', 'number', ['number', 'string', 'number'],
          [fileSize, key || '', request.seconds], { async: true })
        : request.seconds > 0.5
          ? await core.ccall('cenc_stream_remux_at', 'number',
            ['number', 'string', 'number'], [fileSize, key, request.seconds], { async: true })
          : await core.ccall('cenc_stream_remux', 'number',
            ['number', 'string'], [fileSize, key], { async: true });
      if (activeRun.signal.aborted) continue;
      if (ret !== 0) throw new Error('Remux failed');
      assembler.finish();
      reader.snapshot(true);
      completed = true;
      post({ type: 'done', generation });
    }
  }
  const finished = run().catch(error => {
    if (controller.signal.aborted) return;
    // A native fetch/decoder error can include a signed URL or key; never
    // relay arbitrary messages. The owner handles every failure the same way.
    runtime.core = null; runtime.bridge = null;
    if (!sourceFailed) onError({ code: lastRangeError?.code || failureCode,
      status: lastRangeError?.status || 0,
      ...(Number.isFinite(lastRangeError?.retryAfterMs) ? { retryAfterMs: lastRangeError.retryAfterMs } : {}) });
  }).finally(() => {
    if (runtime.io === io) runtime.io = null;
    pendingAck = null; requestedSeek = null; activeRun = null; wake = null; processingWake = null;
  });

  return {
    sourceFailure: reportSourceFailure,
    seek(seconds, nextGeneration) {
      if (controller.signal.aborted || nextGeneration <= latestRequested) return;
      latestRequested = nextGeneration;
      completed = false;
      reader.snapshot(true);
      requestedSeek = { seconds, generation: nextGeneration };
      activeRun?.abort();
      pendingAck?.reject(canceled()); pendingAck = null;
      wake?.(); wake = null;
    },
    ack(id) {
      if (pendingAck?.id !== id) return;
      const pending = pendingAck;
      pendingAck = null;
      pending.resolve();
    },
    allowProcessing() {
      if (processingAllowed) return;
      processingAllowed = true;
      processingWake?.(); processingWake = null;
    },
    /** Reusable when no engine call is left in an interrupted state. */
    get reusable() { return Boolean(runtime.core) && (completed || !engineStarted); },
    stop() {
      controller.abort(); activeRun?.abort(); wake?.(); processingWake?.();
      pendingAck?.reject(canceled()); pendingAck = null;
      return finished;
    }
  };
}
