import { createPlaybackAttempts } from './playback-attempts.js';
// Layer 2: playable-media requests, decryption/remux/transcoding
// and speculative work. Playback supplies context; this layer owns scheduling.
import { errorWith } from './logic.js';
import { episodeCacheKey } from './media-cache.js';
import { convertBytes, convertHls, prepareFfmpeg } from './ffmpeg.js';
import { renditionOptions, availableRenditions, codecsAtQuality, playbackRendition, codecId, qualityId, reconcileRendition, playableVariants } from './source-options.js';
import { nextEpisode, shouldPrefetchNext } from './player-prefetch.js';
import { probeCencKid, openClearKeyStream } from './clear-key.js';
import { openCencProgressiveStream } from './cenc-remux.js';
import { bvc2BridgeAvailable, transcodeBvc2 } from './bvc2.js';
import { clampStreamSeek } from './cenc-seek.js';
import { createDownloadSourceSession } from './download-source-session.js';
import { blockHevcFullFileFallback } from './playback-policy.js';
import { createMediaDownload } from './media-download.js';
import { clearMediaProcessors } from './media-processor.js';

export function createMediaSession({
  video, getSeries, sourceFor, fetchBytes, getWorkerOrigin, cache,
  selection, context, savedResumeSeconds, waitForOutputCleanup,
  mimeSupport, mseSupport, bvc2Mode, log, ageMs, markStartupStage,
  reportStartup, reportStage, onVariants, onSelection
}) {
  const download = createMediaDownload({ fetchBytes, getWorkerOrigin });
  const CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC', bytevc2: 'ByteVC2' };
  let sourceAttempt = 0, activeAttempts = createPlaybackAttempts();
  let activeDownload = null;
  let streamFailure = null;
  let lastVariants = null, lastWinnerVariants = null, lastVariantsVid = null;
  let prefetched = null, retryIncrementalCenc = false, canTranscodeBvc2 = false;
  function refreshBvc2Choices(variants, signal) {
    if (!variants.some(v => codecId(v.codec) === 'bytevc2')) return;
    void bvc2BridgeAvailable().then(available => {
      if (signal.aborted || lastVariants !== variants || available === canTranscodeBvc2) return;
      canTranscodeBvc2 = available;
      onVariants(variants);
      log('source.menu.updated', { bvc2Available: available });
    }).catch(() => {});
  }
  async function prepareNativeStream(args) {
    try {
      log('cenc.prepare.begin', { codec: args.codec, elapsedMs: ageMs() });
      const stream = await openClearKeyStream(args);
      log('cenc.route', { kind: stream?.kind || 'unavailable', elapsedMs: ageMs() });
      if (stream?.kind === 'cenc-remux') retryIncrementalCenc = true;
      return stream;
    }
    catch (error) {
      if (args.signal?.aborted) throw error;
      log('cenc.prepare.failed', { code: error?.code || 'UNKNOWN', elapsedMs: ageMs() });
      // This also covers the nativePending prefetch handoff, not just open().
      if (['CENC_SOURCE_FORBIDDEN', 'CENC_RANGE_HTTP'].includes(error?.code))
        retryIncrementalCenc = true;
      throw error;
    }
  }
  function maybeStartPrefetchedProcessing() {
    if (!context().stream || context().stream.finished?.()) prefetched?.prepared?.native?.startProcessing?.();
  }
  function streamStageReporter(signal, attempt, quiet = false, episode = context().episode, observe = () => {}) {
    return (stage, fields = {}) => {
      if (signal.aborted) return;
      if (quiet && context().episode?.vid !== episode?.vid) {
        log('prefetch.stage', { episode: Number(episode?.index) || 0, phase: stage, ...fields });
        observe(stage, fields);
      } else {
        log('cenc.stage', { phase: stage, elapsedMs: ageMs(), ...fields });
        if ((stage === 'media-range-failed' || stage === 'mse.failed') && fields.code)
          streamFailure = { code: fields.code, status: fields.status || 0, retryStep: fields.retryStep, stepAttempt: fields.attempt, retryAfterMs: fields.retryAfterMs };
        if (stage === 'seek.request') prefetched?.prepared?.native?.pauseProcessing?.();
        if (stage === 'mse.done') maybeStartPrefetchedProcessing();
        reportStage(stage, signal, attempt, fields);
      }
    };
  }
  async function prepareEpisode(episode, signal, attempt = 0, options = {}) {
    let steps = options.attempts || activeAttempts, failureStep = 'source-auto';
    let candidate = 0, streamCodec = 'unknown', downloadStarted = false, processingStarted = false, cdnStarted = false, metadataRetryPending = false, downloadRetryPending = false;
    try {
      const series = getSeries();
      let quality = options.quality ?? selection().quality;
      let codec = options.codec ?? selection().codec;
      const quiet = !!options.quiet;
      const report = (message, layer = 1) => { if (!quiet) {
        log('media.wait', { layer, phase: 'prepare' });
        const currentAttempt = steps.count(failureStep);
        reportStartup(message + (currentAttempt ? ' · 第 ' + currentAttempt + '/20 次' : ''), signal, attempt, layer, failureStep);
      } };
      const reportStream = streamStageReporter(signal, attempt, quiet, episode, options.onPrefetchStage);
      const onStage = (stage, fields = {}) => {
        if (signal.aborted) return;
        if (['metadata', 'cdn.probe'].includes(stage) && !cdnStarted) {
          cdnStarted = true; failureStep = 'cdn-probe';
          const attempt = steps.begin('cdn-probe');
          reportStream('cdn.selected', { candidate, codec: streamCodec, attempt, retryStep: 'cdn-probe' });
        }
        if (stage === 'metadata') { failureStep = 'metadata'; steps.begin('metadata'); }
        if (stage === 'range.retry') { failureStep = 'metadata'; steps.check('metadata'); metadataRetryPending = true; }
        if (stage === 'range.request' && metadataRetryPending) { metadataRetryPending = false; steps.begin('metadata'); }
        if (['wasm-download', 'wasm-start', 'first-fragment'].includes(stage) && !processingStarted) { processingStarted = true; steps.next('processing'); }
        if (['wasm-download', 'wasm-verify', 'wasm-start', 'first-fragment'].includes(stage)) failureStep = 'processing';
        if (stage === 'media.request' && (!downloadStarted || downloadRetryPending)) {
          downloadStarted = true; downloadRetryPending = false; steps.next('media-download');
        }
        if (stage === 'media-range-retry') downloadRetryPending = true;
        if (['media.wait', 'media.request', 'media-range-retry', 'media-range-failed'].includes(stage)) failureStep = 'media-download';
        if (stage === 'mse.failed' && !fields.code?.startsWith('CENC_RANGE') && !['CENC_SOURCE_FORBIDDEN', 'CENC_RATE_LIMITED', 'CENC_SOURCE_SLOW'].includes(fields.code)) failureStep = 'processing';
        reportStream(stage, { candidate, codec: streamCodec, ...fields, requestAttempt: fields.attempt, attempt: steps.count(failureStep) + (['range.retry', 'media-range-retry'].includes(stage) ? 1 : 0), processingAttempt: steps.count('processing'), retryStep: failureStep });
      };
      const fallbackStatus = (message, layer = 1) => report(message, layer);
      const seriesId = options.seriesId ?? series?.seriesId;
      let key = episodeCacheKey(seriesId, episode.vid, quality, codec);
      const entry = attempt === 0 ? cache.getEntry(key) : null;
      if (entry?.blob) {
        log('source.cache.hit', { attempt: attempt + 1 });
        report('正在讀取已快取的影片…');
        return { blob: entry.blob, source: entry.source || { codec, quality, source: 'cache' } };
      }
      report(attempt ? '正在選取其他 CDN／更新影片來源…' : '正在取得影片來源…');
      const downloadState = options.downloadState || (activeDownload ||= createDownloadSourceSession({
        sourceFor, seriesId, episode, log, ageMs
      }));
      const list = await downloadState.list({ quality, codec, signal, onStage, report,
        refresh: options.refresh,
        onUpdate: variants => {
          if (!quiet && activeDownload === downloadState && !signal.aborted) {
            onVariants(variants); refreshBvc2Choices(variants, signal);
          }
        } });
      if (list.attempts) steps = list.attempts;
      if (!quiet) activeAttempts = steps;
      const variants = list.variants || [];
      const reconciled = reconcileRendition(variants, { quality, codec });
      if (reconciled.quality !== quality || reconciled.codec !== codec) {
        log('source.selection.reconciled', { previousQuality: quality, previousCodec: codec, ...reconciled });
        quality = reconciled.quality; codec = reconciled.codec;
        key = episodeCacheKey(seriesId, episode.vid, quality, codec);
      }
      // A 1080p HEVC selection must not wait for unrelated ByteVC2 assets.
      let formatCandidates = quality === 'auto'
        ? list.winnerVariants || variants : variants;
      const nativeChoice = playbackRendition(formatCandidates, { quality, codec: 'auto' }, mimeSupport, 0, false, mseSupport).source;
      if (!quiet) for (const option of renditionOptions(variants)) {
        const candidates = variants.filter(v => qualityId(v) === option.quality &&
          (codecId(v.codec) || 'auto') === option.codec);
        log('source.rendition', {
          quality: option.quality, codec: option.codec, candidates: candidates.length,
          encrypted: candidates.some(v => Boolean(v.contentKey)),
          nativeSupported: Boolean(playbackRendition(candidates, option,
            mimeSupport, 0, false, mseSupport).source)
        });
      }
      log('source.selection.policy', { quality, codec, nativeAvailable: Boolean(nativeChoice), bvc2Mode });
      const needsBvc2 = formatCandidates.some(v => codecId(v.codec) === 'bytevc2' &&
        (quality === 'auto' || qualityId(v) === quality) &&
        (!nativeChoice || parseInt(qualityId(v), 10) > parseInt(qualityId(nativeChoice), 10)));
      if (needsBvc2) report('正在檢查 ByteVC2 播放工具…', 2);
      const checkStarted = performance.now();
      const bvc2Available = needsBvc2 ? await bvc2BridgeAvailable() : canTranscodeBvc2;
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      canTranscodeBvc2 = bvc2Available;
      log('source.bvc2.check', {
        required: needsBvc2, available: canTranscodeBvc2,
        elapsedMs: Math.round(performance.now() - checkStarted)
      });
      const supported = playableVariants(variants, mimeSupport, canTranscodeBvc2, mseSupport);
      const supportedSelection = reconcileRendition(supported, { quality, codec });
      if (quality !== supportedSelection.quality || codec !== supportedSelection.codec) {
        quality = supportedSelection.quality; codec = supportedSelection.codec;
        key = episodeCacheKey(seriesId, episode.vid, quality, codec);
        log('source.selection.reconciled', { quality, codec, reason: 'supported-codecs' });
      }
      formatCandidates = quality === 'auto' ? list.winnerVariants || variants : variants;
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (!quiet) {
        lastVariants = variants;
        lastWinnerVariants = list.winnerVariants || variants.slice();
        lastVariantsVid = episode.vid;
        onVariants(variants, { quality, codec });
        refreshBvc2Choices(variants, signal);
        // Persisted codec preferences can belong to another episode's tier.
        // Use the now-enabled selection, rather than rejecting a stale codec.
        if (codec !== selection().codec) {
          codec = selection().codec;
          key = episodeCacheKey(seriesId, episode.vid, quality, codec);
        }
      }
      // Supply format capabilities; layer 1 selects the download source.
      const resolved = downloadState.acquire({ quality, codec }, {
        mimeSupport, mseSupport, canTranscodeBvc2
      });
      const source = resolved.source;
      if (!source) {
        const tiers = availableRenditions(variants);
        const offered = tiers.qualities.map(q =>
          q + '：' + codecsAtQuality(variants, q).map(c => CODEC_NAMES[c] || c).join('/')).join('、');
        throw errorWith('PLAYBACK_UNSUPPORTED',
          '所選 ' + (quality === 'auto' ? '自動畫質' : quality) +
          ' 沒有可播放的編碼；可用來源：' + (offered || '未知') +
          '。ByteVC2 須部署 Librempeg WASM 轉碼器；HEVC 需瀏覽器支援。');
      }
      candidate = resolved.candidate; streamCodec = codecId(source.codec);
      options.onSource?.(source, variants, steps);
      let fallbackNotice = '';
      if (resolved.fallback) {
        const original = quality;
        const actual = qualityId(source);
        const originalCodecs = codecsAtQuality(variants, original)
          .map(id => CODEC_NAMES[id] || id).join('/');
        fallbackNotice = original + ' 只有 ' + originalCodecs +
          '，已改用 ' + actual + ' ' + (CODEC_NAMES[codecId(source.codec)] || source.codec);
        if (!quiet && actual && renditionOptions(variants).some(o => o.quality === actual)) {
          onSelection(actual);
          onVariants(variants);
        }
      }
      if (codecId(source.codec) === 'bytevc2') {
        if (source.hls) throw errorWith('PLAYBACK_UNSUPPORTED',
          'ByteVC2 HLS 尚未支援；目前的 WASM 路徑只接受 MP4');
        // Streaming preload downloads independently and waits for the current
        // processor before producing a bounded clear prefix. Whole-file mode
        // keeps metadata-only lookahead to avoid a second full transcode.
        if (quiet && (bvc2Mode !== 'stream' || !options.nativePrefetch)) return { bvc2Pending: true, source, fallbackNotice, variants,
          winnerVariants: list.winnerVariants || variants.slice() };
        if (bvc2Mode === 'stream') {
          if (!quiet) report('正在準備 ByteVC2 → H.264 增量串流…', 2);
          const { transport, url } = download.open(source);
          const metadata = {};
          log('bvc2.prepare.begin', { mode: 'stream', codec: 'bytevc2' });
          onStage('metadata');
          await probeCencKid(url, signal, transport.fetch, metadata, (phase, fields) => onStage(phase, fields));
          if (!metadata.fileSize || metadata.fragmented)
            throw errorWith('BVC2_ERROR', 'ByteVC2 串流需要可讀取索引的 MP4 來源');
          const native = await openCencProgressiveStream({
            video, input: download.input(source, transport),
            fileSize: metadata.fileSize, initialRanges: metadata.initialRanges, onStage,
            codec: 'h264', hasAac: metadata.hasAac,
            key: source.contentKey || '', signal, bridge: 'bvc2', remainingMediaAttempts: 20 - steps.count('media-download'), preload: quiet && options.nativePrefetch,
            durationSeconds: metadata.movieDurationSeconds || source.duration || null,
            startSeconds: clampStreamSeek(quiet ? 0 : savedResumeSeconds(episode, seriesId),
              metadata.movieDurationSeconds || source.duration || null) || 0
          });
          if (!native) throw errorWith('BVC2_UNAVAILABLE', '瀏覽器無法使用 ByteVC2 → H.264 MSE 串流');
          return { native, url: native.url, source: { ...source, outputCodec: 'h264' },
            fallbackNotice, variants: quiet ? variants : null };
        }
        const reportBvc2 = (message, layer = 2) => report(message, layer);
        log('bvc2.prepare.begin', { mode: 'whole-file', codec: 'bytevc2' });
        onStage('cdn.probe', { mode: 'whole-file' });
        failureStep = 'media-download'; steps.begin('media-download');
        reportBvc2('正在下載 ByteVC2 影片…', 1);
        const started = performance.now();
        let received = 0;
        const raw = await download.read(source, signal, 260 * 1024 * 1024,
          (length, total) => {
            received += length;
            if (length > 0) markStartupStage('first-media-byte');
            if (total > 0) reportBvc2('讀取 ByteVC2 影片 ' +
              Math.min(100, Math.round(100 * received / total)) + '%（需整集下載）', 1);
          });
        if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
        log('bvc2.download.complete', { bytes: raw.length });
        failureStep = 'processing'; steps.begin('processing');
        reportBvc2('ByteVC2 整集已下載；準備 WASM 轉碼（此模式尚不能串流起播）');
        const bvc2Phases = {
          'config-normalized': '正在準備 ByteVC2 設定資料…',
          'wasm-loading': '載入 ByteVC2 WASM 解碼器…',
          'wasm-ready': 'ByteVC2 解碼器已就緒…',
          transcoding: 'ByteVC2 → H.264 正在轉碼整集；完成前無法顯示影格，請勿誤認為已起播',
          finalizing: 'ByteVC2 轉碼完成，正在輸出 MP4…'
        };
        const transcoded = await transcodeBvc2(raw, {
          contentKey: source.contentKey, signal, mode: 'h264',
          progress: value => { if (!signal.aborted) reportBvc2('轉碼 ' + Math.round(value * 100) + '%'); },
          onProgress: phase => {
            if (!signal.aborted) log('bvc2.transcode.stage', { phase });
            if (!signal.aborted && bvc2Phases[phase]) reportBvc2(bvc2Phases[phase]);
          }
        });
        if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
        log('bvc2.transcode.complete', { bytes: transcoded.length });
        console.info('[Hongguo playback] E' + episode.index + ' ByteVC2 解密轉碼：' +
          Math.round(performance.now() - started) + 'ms');
        const playable = new Blob([transcoded], { type: 'video/mp4' });
        const outputSource = { ...source, outputCodec: 'h264' };
        cache.put(key, playable, outputSource);
        return { blob: playable, source: outputSource, fallbackNotice, variants: null };
      }
      if (!source.hls && !source.contentKey) {
        log('playback.route', { kind: 'direct-mp4', elapsedMs: ageMs() });
        const native = await download.nativeSource(source, signal,
          (reason, fields) => onStage('media.transport.fallback', { reason, ...fields }), onStage);
        return { ...native, source, fallbackNotice, variants: quiet ? variants : null };
      }
      // The browser's native CDM performs CENC-AES-CTR on its HTTP Range
      // stream: no full MP4 buffer, JS crypto loop, or FFmpeg virtual FS.
      // ByteVC2 still needs a dedicated decoder, which the CDM cannot supply.
      // A source/API failure may consume attempt zero before any CENC setup.
      // Every newly selected encrypted source must still try incremental playback.
      if ((!quiet || options.nativePrefetch) && source.contentKey && !source.hls) {
        await waitForOutputCleanup();
        const native = await (quiet ? openClearKeyStream : prepareNativeStream)({
          preload: quiet && options.nativePrefetch, video, source, download, codec: codecId(source.codec),
          workerOrigin: getWorkerOrigin(), signal, remainingMediaAttempts: 20 - steps.count('media-download'),
          startSeconds: quiet ? 0 : savedResumeSeconds(episode, seriesId), onStage,
        });
        if (native) {
          if (!quiet && native.kind === 'cenc-remux') retryIncrementalCenc = true;
          log('playback.route', { kind: native.kind, elapsedMs: ageMs() });
          return { url: native.url, native, source, fallbackNotice, variants: quiet ? variants : null };
        }
        if (quiet) return { nativePending: true, source, fallbackNotice, variants };
        if (retryIncrementalCenc)
          throw errorWith('CENC_UNAVAILABLE', '增量串流重試失敗，已禁止整檔備援下載');
      }
      // Whole-file FFmpeg is not a valid fallback for encrypted HEVC MP4.
      if (blockHevcFullFileFallback(source)) {
        log('playback.fallback.blocked', { codec: 'hevc', reason: 'cenc-unavailable' });
        throw errorWith('CENC_UNAVAILABLE',
          'HEVC 增量串流無法使用；已禁止改為整集下載。請複製頁面底部播放診斷 Log。');
      }
      log('playback.fallback.whole-file', {
        codec: codecId(source.codec) || 'unknown',
        reason: source.hls ? 'hls' : 'cenc-unavailable',
        elapsedMs: ageMs()
      });
      let bytes;
      if (source.hls) {
        onStage('cdn.probe', { mode: 'whole-file' });
        failureStep = 'media-download'; steps.begin('media-download');
        if (!quiet) report('正在讀取分片清單…');
        bytes = await convertHls(download.playlistUrl(source), {
          mode: 'copy', contentKey: source.contentKey, signal,
          fetchBytes: (uri, sig, max) => download.read(source, sig, max, undefined, uri),
          segmentProgress: x => report('正在下載分片 ' + x.current + '/' + x.total),
          onStage: phase => {
            if (phase === 'hls-tool') { failureStep = 'processing'; steps.begin('processing'); report('正在準備影片處理工具…', 2); }
            if (phase === 'hls-playlist') { failureStep = 'media-download'; report('正在讀取分片清單…', 1); }
            if (phase === 'hls-remux') { failureStep = 'processing'; report('正在解密並封裝影片…', 2); }
          }
        });
      } else {
        // Encrypted MP4s still require the complete source before decryption.
        // Initialize FFmpeg after the first media chunk, in parallel with the
        // remaining download, so the initial startup stages do not run serially.
        let warmup = !quiet ? prepareFfmpeg(signal).then(() => null, error => error) : null;
        let received = 0, lastUpdate = 0;
        const downloadStarted = performance.now();
        onStage('cdn.probe', { mode: 'whole-file' });
        failureStep = 'media-download'; steps.begin('media-download');
        fallbackStatus('正在下載整集影片…');
        const raw = await download.read(source, signal,
          quiet ? Math.min(cache.limit, 32 * 1024 * 1024) : 260 * 1024 * 1024,
          (length, total) => {
            if (!warmup) warmup = prepareFfmpeg(signal).then(() => null, error => error);
            received += length;
            if (length > 0) markStartupStage('first-media-byte');
            const now = Date.now();
            if (!quiet && now - lastUpdate > 250) {
              lastUpdate = now;
              fallbackStatus(total ? '下載整集 ' + Math.min(100, Math.round(100 * received / total)) + '%'
                : '正在下載整集影片…');
            }
          });
        failureStep = 'processing'; steps.begin('processing');
        fallbackStatus('正在準備影片處理工具…', 2);
        const warmupError = await (warmup || prepareFfmpeg(signal).then(() => null, error => error));
        if (warmupError) throw warmupError;
        if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
        if (!quiet) {
          console.info('[Hongguo playback] E' + episode.index +
            ' 片源下載：' + Math.round(performance.now() - downloadStarted) +
            'ms，' + raw.byteLength + ' bytes');
          fallbackStatus('正在解密並重新封裝整集影片…', 2);
        }
        const remuxStarted = performance.now();
        bytes = await convertBytes(raw, { mode: 'copy', contentKey: source.contentKey, signal });
        if (!quiet) console.info('[Hongguo playback] E' + episode.index +
          ' 解密封裝：' + Math.round(performance.now() - remuxStarted) + 'ms');
      }
      if (!bytes?.length) throw errorWith('EMPTY_MEDIA', '來源沒有媒體資料');
      const result = new Blob([bytes], { type: 'video/mp4' });
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      cache.put(key, result, source);
      return { blob: result, source, fallbackNotice, fullFileFallback: true,
        variants: quiet ? variants : null };
    } catch (error) {
      if (error.retryStep) throw error;
      throw steps.decorate(error, failureStep);
    }
  }
  function cancelPrefetch(exceptVid = null) {
    if (prefetched && prefetched.vid !== exceptVid) {
      prefetched.controller.abort();
      prefetched = null;
    }
  }
  function maybePrefetchNext() {
    if (!context().episode || !context().ready || !getSeries() || !context().duration) return;
    const next = nextEpisode(getSeries()?.episodes || [], context().episode.vid);
    if (!shouldPrefetchNext({
      duration: context().duration, position: context().position,
      startupSeconds: context().startupSeconds, paused: context().paused,
      autoNext: true, saveData: !!navigator.connection?.saveData,
      hasNext: !!next, processingFinished: Boolean(context().stream?.finished?.())
    })) return;
    const seriesId = getSeries().seriesId, quality = selection().quality;
    const codec = 'auto'; // The next episode inherits a quality, never this episode's codec.
    const key = episodeCacheKey(seriesId, next.vid, quality, codec);
    if (prefetched?.key === key) { maybeStartPrefetchedProcessing(); return; }
    if (cache.getEntry(key)) return;
    cancelPrefetch();
    const entry = { vid: next.vid, key, episode: next, quality, codec, seriesId,
      controller: new AbortController(), attemptController: null, prepared: null, attempts: createPlaybackAttempts(),
      variants: null, source: null,
      downloadState: createDownloadSourceSession({ sourceFor, seriesId, episode: next, log, ageMs }),
      ready: false, error: null };
    log('prefetch.begin', { episode: Number(next.index) || 0,
      processingFinished: Boolean(context().stream?.finished?.()) });
    prefetched = entry;
    preparePrefetch(entry);
  }
  function recoverPrefetch(entry, code) {
    if (prefetched !== entry || entry.controller.signal.aborted) return;
    log('prefetch.recover', { episode: Number(entry.episode.index), code, ready: entry.ready,
      tried: entry.downloadState.failedCount });
    preparePrefetch(entry);
  }
  function preparePrefetch(entry) {
    entry.attemptController?.abort();
    const controller = new AbortController();
    entry.attemptController = controller;
    const signal = AbortSignal.any([entry.controller.signal, controller.signal]);
    entry.source = null; entry.prepared = null; entry.ready = false; entry.error = null;
    entry.promise = Promise.resolve().then(() => prepareEpisode(entry.episode, signal, 0, {
      quiet: true, attempts: entry.attempts, quality: entry.quality, codec: entry.codec, seriesId: entry.seriesId,
      nativePrefetch: true, downloadState: entry.downloadState,
      onSource: (source, variants, attempts) => {
        entry.attempts = attempts;
        entry.source = source; entry.variants = variants;
      },
      onPrefetchStage: (stage, fields) => {
        if (stage === 'preload.buffer' && fields.ready && !entry.ready) {
          entry.ready = true;
          log('prefetch.ready', { episode: Number(entry.episode.index), bytes: fields.bytes, units: fields.units });
        }
        const code = stage === 'media.slow' ? 'CENC_SOURCE_SLOW' : fields.code;
        if (!['media.slow', 'media.prefetch.stopped', 'media-range-retry',
          'range.retry', 'media-range-failed', 'mse.failed'].includes(stage) || !code) return;
        if (entry.downloadState.failed(code)) recoverPrefetch(entry, code);
        else if (stage === 'mse.failed' || stage === 'media.prefetch.stopped') {
          entry.error = errorWith(code, '預載媒體讀取失敗');
          entry.prepared = null; entry.promise = Promise.resolve(null); controller.abort();
        }
      }
    })).then(prepared => {
      if (signal.aborted) { void prepared?.native?.close(); return null; }
      entry.prepared = prepared;
      if (prefetched === entry) maybeStartPrefetchedProcessing();
      log('prefetch.prepared', { episode: Number(entry.episode.index), media: Boolean(prepared?.native),
        ready: entry.ready });
      return prepared;
    }).catch(error => {
      if (signal.aborted) return null;
      entry.error = error;
      if (entry.downloadState.failed(error?.code) && prefetched === entry)
        recoverPrefetch(entry, error.code);
      else {
        log('prefetch.failed', { episode: Number(entry.episode.index), code: error?.code || 'UNKNOWN' });
      }
      return null;
    });
  }
  return {
    async request(episode, signal, handoff = null) {
      streamFailure = null;
      if (handoff?.attempts) activeAttempts = handoff.attempts;
      const attempt = sourceAttempt++;
      log('playback.attempt', { attempt: attempt + 1, elapsedMs: ageMs() });
      if (handoff && attempt === 0)
        reportStartup('正在接續預取的影片來源…', signal, attempt);
      let prepared = null, refreshExhaustedPrefetch = false;
      if (handoff && attempt === 0) {
        let pending;
        do { pending = handoff.promise; prepared = await pending; } while (pending !== handoff.promise);
        // The download session owns candidates and failure history across consumers.
        activeDownload = handoff.downloadState;
        if (handoff.variants) {
          lastVariants = handoff.variants; lastWinnerVariants = handoff.variants;
          lastVariantsVid = episode.vid;
        }
        if (!prepared && handoff.error) {
          if (handoff.error.code !== 'CENC_SOURCE_EXHAUSTED' || activeDownload.refreshCount >= 20) throw handoff.error;
          // A failed speculative list is not proof that a fresh foreground query will fail.
          refreshExhaustedPrefetch = true;
          log('prefetch.handoff.refresh', { episode: Number(episode.index) || 0, refreshed: activeDownload.refreshCount });
        }
      }
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      let resolved = prepared || await prepareEpisode(episode, signal, attempt,
        { refresh: refreshExhaustedPrefetch });
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (prepared?.native?.activate) {
        prepared.native.activate();
        if (prepared.native.kind === 'cenc-remux') retryIncrementalCenc = true;
        log('prefetch.handoff', { episode: Number(episode.index) || 0, media: true, ready: handoff.ready });
      }
      if (resolved?.bvc2Pending) {
        resolved = await prepareEpisode(episode, signal, attempt,
          {});
      }
      if (resolved?.nativePending) {
        await waitForOutputCleanup();
        const native = await prepareNativeStream({
          video, source: resolved.source, download, codec: codecId(resolved.source.codec),
          workerOrigin: getWorkerOrigin(), signal,
          startSeconds: savedResumeSeconds(episode),
          onStage: streamStageReporter(signal, attempt, false, episode)
        });
        resolved = native ? { ...resolved, native, url: native.url, nativePending: false }
          : await prepareEpisode(episode, signal, attempt,
            {});
      }
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (prepared?.variants?.length) {
        lastVariants = prepared.variants;
        lastVariantsVid = episode.vid;
        onVariants(prepared.variants);
        if (prepared.fallbackNotice) {
          const actual = qualityId(prepared.source);
          if (actual && renditionOptions(prepared.variants).some(o => o.quality === actual)) {
            onSelection(actual);
            onVariants(prepared.variants);
          }
        }
      }

      return { resolved, prepared, attempt };
    },
    begin(episode) {
      sourceAttempt = 0; activeAttempts = createPlaybackAttempts();
      activeDownload = null; streamFailure = null;
      retryIncrementalCenc = false;
      if (lastVariantsVid !== episode.vid) {
        lastVariants = lastWinnerVariants = null; lastVariantsVid = null;
      }
    },
    takePrefetch(episode) {
      const key = episodeCacheKey(getSeries()?.seriesId, episode.vid,
        selection().quality, selection().codec);
      const handoff = prefetched?.vid === episode.vid && prefetched.key === key ? prefetched : null;
      if (handoff) prefetched = null;
      else cancelPrefetch();
      return handoff;
    },
    beginPlayback() { return activeAttempts.begin('playback'); },
    decoratePlaybackError(error) { return activeAttempts.decorate(error, 'playback'); },
    canResumeDownload(code) {
      const retry = activeDownload?.failed(code) || false;
      if (retry && activeDownload?.tier?.codec === 'hevc') retryIncrementalCenc = true;
      return retry;
    },
    updateContext() { maybePrefetchNext(); },
    cancelPrefetch,
    releaseEngines: clearMediaProcessors,
    clear() {
      cancelPrefetch();
      lastVariants = lastWinnerVariants = null; lastVariantsVid = null;
    },
    takeFailure() { const failure = streamFailure; streamFailure = null; return failure; },
    get failure() { return streamFailure; },
    get attempt() { return sourceAttempt; },
    get variants() { return lastVariants; },
    get bvc2Available() { return canTranscodeBvc2; }
  };
}
