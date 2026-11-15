import { createPlaybackAttempts } from './playback-attempts.js';
// Layer 2: playable-media requests, source policy, decryption/remux/transcoding
// and speculative work. Playback supplies context; this layer owns scheduling.
import { errorWith, isHlsUrl } from './logic.js';
import { episodeCacheKey } from './media-cache.js';
import { convertBytes, convertHls, prepareFfmpeg } from './ffmpeg.js';
import { renditionOptions, availableRenditions, codecsAtQuality, playbackRendition, codecId, qualityId, sourceQueryForPlayback, untriedPlaybackRendition, reconcileRendition, playableVariants } from './source-options.js';
import { nextEpisode, shouldPrefetchNext } from './player-prefetch.js';
import { probeCencKid, openClearKeyStream } from './clear-key.js';
import { openCencProgressiveStream } from './cenc-remux.js';
import { bvc2BridgeAvailable, transcodeBvc2 } from './bvc2.js';
import { clampStreamSeek } from './cenc-seek.js';
import { canTryNextCencSource, sameTierPlaybackCandidates, isRecoverableMediaSourceError } from './cenc-source-fallback.js';
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
  let lastSourceUrl = '', rateRetryUrl = '';
  let sourceAttempt = 0, activeAttempts = createPlaybackAttempts();
  let sourceRefreshCount = 0, cencRetryTier = null;
  let cencTriedUrls = new Set(), candidateIds = new Map();
  let streamFailure = null;
  let lastVariants = null, lastWinnerVariants = null, lastVariantsVid = null;
  let pendingSourceExpansion = null, triedSourceUrls = new Set();
  let prefetched = null, retryIncrementalCenc = false, canTranscodeBvc2 = false;
  async function requestSources(...args) {
    try { return await sourceFor(...args); }
    catch (error) { throw Object.assign(error, { stage: 'source-api' }); }
  }
  function refreshBvc2Choices(variants, signal) {
    if (!variants.some(v => codecId(v.codec) === 'bytevc2')) return;
    void bvc2BridgeAvailable().then(available => {
      if (signal.aborted || lastVariants !== variants || available === canTranscodeBvc2) return;
      canTranscodeBvc2 = available;
      onVariants(variants);
      log('source.menu.updated', { bvc2Available: available });
    }).catch(() => {});
  }
  function retryCurrentSource(variants, source, tried = cencTriedUrls) {
    return !(variants || []).some(other => other.url && other.url !== source.url &&
      other.contentKey && !tried.has(other.url) &&
      codecId(other.codec) === codecId(source.codec) && qualityId(other) === qualityId(source));
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
  async function sourceForEpisode(episode, signal, attempt = 0, options = {}) {
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
      log('source.resolve.begin', {
        attempt: attempt + 1, quality, codec, prefetch: quiet, elapsedMs: ageMs()
      });
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
      if (!quiet && attempt > 0 && !cencRetryTier &&
          pendingSourceExpansion?.vid === episode.vid) {
        report('正在等待另一種來源查詢結果…');
        await pendingSourceExpansion.promise;
        if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      }
      // This API may return 10 variants but only two HEVC URLs at 1080p.
      // Rotate just those candidates; refresh signed URLs once when exhausted.
      const sameEpisode = !quiet && lastVariants && lastVariantsVid === episode.vid;
      const rateRetry = sameEpisode && rateRetryUrl;
      const priorCandidates = sameEpisode && cencRetryTier
        ? sameTierPlaybackCandidates(lastVariants, { quality, codec }, cencRetryTier) : [];
      const withinCycle = priorCandidates.some(source => !cencTriedUrls.has(source.url));
      let refreshingCencSources = false;
      const sameList = Boolean(sameEpisode && attempt > 0 &&
        (rateRetry || (cencRetryTier ? withinCycle : attempt < lastVariants.length)));
      if (!quiet && cencRetryTier && sameEpisode && attempt > 0 && !sameList) {
        if (sourceRefreshCount >= 20) {
          log('source.list.exhausted', {
            attempts: attempt, tier: cencRetryTier.quality, refreshed: sourceRefreshCount
          });
          throw errorWith('CENC_SOURCE_EXHAUSTED',
            '同畫質片源刷新已達 20 次上限；請稍後重新整理頁面再試。');
        }
        refreshingCencSources = true;
        log('source.list.refresh', {
          attempt: attempt + 1, tier: cencRetryTier.quality, refreshed: sourceRefreshCount
        });
        report('正在重新取得同畫質影片來源…');
      }
      const sourceQuery = sourceQueryForPlayback(quality);
      const list = options.variants?.length ? { variants: options.variants, winnerVariants: options.winnerVariants }
        : episode.vid === 'direct'
        ? { variants: [{ url: episode.url, source: 'web', codec: 'unknown', contentKey: null }] }
        : sameList ? { variants: lastVariants, winnerVariants: lastWinnerVariants }
          : await requestSources(seriesId, episode.vid, sourceQuery.quality, sourceQuery.codec, signal,
            { refresh: Boolean(options.refresh || !quiet && attempt > 0 && !sameList), onStage });
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (list.attempts) steps = list.attempts;
      if (!quiet) activeAttempts = steps;
      const variants = list.variants || [];
      // A public unknown-quality URL cannot satisfy an explicit rendition
      // request. Await the other query only when the initial source lacks it.
      if (list.lateVariants && (refreshingCencSources ||
          (quality !== 'auto' || codec !== 'auto') &&
          !variants.some(v => (quality === 'auto' || qualityId(v) === quality) &&
            (codec === 'auto' || codecId(v.codec) === codec)))) {
        report('等待另一條片源查詢補齊所選畫質（網頁／App API）…', 1);
        const extra = await list.lateVariants;
        if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
        const seen = new Set(variants.map(v => v.url));
        for (const v of extra || []) if (v?.url && !seen.has(v.url)) {
          variants.push(v); seen.add(v.url);
        }
      }
      if (refreshingCencSources) {
        if (!variants.length) throw errorWith('SOURCE_UNAVAILABLE', '刷新未取得可用片源');
        const fresh = sameTierPlaybackCandidates(variants, { quality, codec }, cencRetryTier)
          .filter(source => !cencTriedUrls.has(source.url));
        if (!fresh.length) {
          log('source.list.stale', { variants: variants.length });
          throw errorWith('CENC_SOURCE_EXHAUSTED', '刷新未取得同畫質／編碼的新候選網址，已停止重試失敗來源。');
        }
        // A successful API response is not proof of fresh media. Retain failed
        // URL identities even when the new list also contains usable candidates.
        sourceRefreshCount++;
        log('source.list.refreshed', { variants: variants.length, freshCandidates: fresh.length,
          refreshed: sourceRefreshCount });
      }
      log('source.list.ready', {
        variants: variants.length, fromCache: sameList || Boolean(list.fromCache), sharedRequest: Boolean(list.shared),
        elapsedMs: ageMs()
      });
      const reconciled = reconcileRendition(variants, { quality, codec });
      if (reconciled.quality !== quality || reconciled.codec !== codec) {
        log('source.selection.reconciled', { previousQuality: quality, previousCodec: codec, ...reconciled });
        quality = reconciled.quality; codec = reconciled.codec;
        key = episodeCacheKey(seriesId, episode.vid, quality, codec);
      }
      // A 1080p HEVC selection must not wait for unrelated ByteVC2 assets.
      let policyVariants = quality === 'auto'
        ? list.winnerVariants || variants : variants;
      const nativeChoice = playbackRendition(policyVariants, { quality, codec: 'auto' }, mimeSupport, 0, false, mseSupport).source;
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
      const needsBvc2 = policyVariants.some(v => codecId(v.codec) === 'bytevc2' &&
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
      policyVariants = quality === 'auto' ? list.winnerVariants || variants : variants;
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (!quiet) {
        lastVariants = variants;
        lastWinnerVariants = list.winnerVariants || variants.slice();
        lastVariantsVid = episode.vid;
        onVariants(variants, { quality, codec });
        refreshBvc2Choices(variants, signal);
        // An independently resolved web/App source may arrive after playback
        // has already started. Merge it for future quality changes and retries,
        // but never restart or replace a healthy active MediaSource.
        if (list.lateVariants) {
          const expansion = list.lateVariants.then(extras => {
            if (signal.aborted || lastVariants !== variants ||
                lastVariantsVid !== episode.vid || !extras?.length) return;
            const seen = new Set(variants.map(item => item.url));
            let added = 0;
            for (const variant of extras) {
              if (!variant?.url || seen.has(variant.url)) continue;
              seen.add(variant.url);
              variants.push(variant);
              added++;
            }
            if (added) {
              log('source.list.extended', { added, variants: variants.length });
              onVariants(variants);
              refreshBvc2Choices(variants, signal);
            }
          }).catch(() => {});
          pendingSourceExpansion = { vid: episode.vid, promise: expansion };
        } else {
          pendingSourceExpansion = null;
        }
        // Persisted codec preferences can belong to another episode's tier.
        // Use the now-enabled selection, rather than rejecting a stale codec.
        if (codec !== selection().codec) {
          codec = selection().codec;
          key = episodeCacheKey(seriesId, episode.vid, quality, codec);
        }
      }
      // A fixed tier is not a fixed codec: Nova's 720p is encrypted VVC, not
      // HEVC. Reject it before spending bandwidth and CPU on doomed FFmpeg work.
      const tier = quiet ? options.tier : cencRetryTier;
      const tried = quiet ? options.triedUrls || new Set() : cencTriedUrls;
      const selectableVariants = rateRetry ? policyVariants.filter(source => source.url === rateRetry) : tier
        ? sameTierPlaybackCandidates(variants, { quality, codec }, tier).filter(source => !tried.has(source.url))
        : policyVariants;
      const candidateIndex = (rateRetry || tier || !quiet && !triedSourceUrls.size) ? 0 : attempt;
      let resolved = playbackRendition(selectableVariants,
        { quality, codec }, mimeSupport, candidateIndex, canTranscodeBvc2, mseSupport);
      if (!quiet && !cencRetryTier && triedSourceUrls.size) {
        const next = untriedPlaybackRendition(selectableVariants,
          { quality, codec }, mimeSupport, triedSourceUrls, canTranscodeBvc2, mseSupport);
        if (next?.source) resolved = next;
      }
      const source = resolved.source;
      const ids = options.candidateIds || candidateIds;
      if (source?.url && !ids.has(source.url)) ids.set(source.url, ids.size + 1);
      log('source.selected', {
        candidate: source?.url ? ids.get(source.url) : 0, episode: Number(episode.index) || 0,
        quality: source ? qualityId(source) || 'unknown' : 'none',
        codec: source ? codecId(source.codec) || 'unknown' : 'none',
        encrypted: Boolean(source?.contentKey),
        hls: Boolean(source && isHlsUrl(source.url)),
        fallback: resolved.fallback, attempt: attempt + 1, elapsedMs: ageMs()
      });
      if (!source?.url) {
        if (tier)
          throw errorWith('CENC_SOURCE_EXHAUSTED',
            '已無與原本畫質／編碼相同的可用官方影片來源。');
        const tiers = availableRenditions(variants);
        const offered = tiers.qualities.map(q =>
          q + '：' + codecsAtQuality(variants, q).map(c => CODEC_NAMES[c] || c).join('/')).join('、');
        throw errorWith('PLAYBACK_UNSUPPORTED',
          '所選 ' + (quality === 'auto' ? '自動畫質' : quality) +
          ' 沒有可播放的編碼；可用來源：' + (offered || '未知') +
          '。ByteVC2 須部署 Librempeg WASM 轉碼器；HEVC 需瀏覽器支援。');
      }
      if (!quiet) { lastSourceUrl = source.url; rateRetryUrl = ''; }
      candidate = ids.get(source.url); streamCodec = codecId(source.codec);
      options.onSource?.(source, variants, steps);
      if (!quiet) {
        triedSourceUrls.add(source.url);
        cencTriedUrls.add(source.url);
      }
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
      if (!quiet && !cencRetryTier && (codecId(source.codec) === 'bytevc2' ||
          ['h264', 'hevc'].includes(codecId(source.codec)) && source.contentKey) && !isHlsUrl(source.url))
        cencRetryTier = { codec: codecId(source.codec), quality: qualityId(source) };
      if (codecId(source.codec) === 'bytevc2') {
        if (isHlsUrl(source.url)) throw errorWith('PLAYBACK_UNSUPPORTED',
          'ByteVC2 HLS 尚未支援；目前的 WASM 路徑只接受 MP4');
        // Streaming preload downloads independently and waits for the current
        // processor before producing a bounded clear prefix. Whole-file mode
        // keeps metadata-only lookahead to avoid a second full transcode.
        if (quiet && (bvc2Mode !== 'stream' || !options.nativePrefetch)) return { bvc2Pending: true, source, fallbackNotice, variants,
          winnerVariants: list.winnerVariants || variants.slice() };
        if (bvc2Mode === 'stream') {
          if (!quiet) report('正在準備 ByteVC2 → H.264 增量串流…', 2);
          const { proxyUrl, transport, url } = download.open(source);
          const metadata = {};
          log('bvc2.prepare.begin', { mode: 'stream', codec: 'bytevc2' });
          onStage('metadata');
          await probeCencKid(url, signal, transport.fetch, metadata, (phase, fields) => onStage(phase, fields));
          if (!metadata.fileSize || metadata.fragmented)
            throw errorWith('BVC2_ERROR', 'ByteVC2 串流需要可讀取索引的 MP4 來源');
          const native = await openCencProgressiveStream({
            video, url: transport.mode === 'direct' ? source.url : proxyUrl,
            proxyUrl, fileSize: metadata.fileSize, initialRanges: metadata.initialRanges, onStage,
            codec: 'h264', hasAac: metadata.hasAac, retrySameSource: retryCurrentSource(variants, source, options.triedUrls),
            key: source.contentKey || '', signal, bridge: 'bvc2', remainingMediaAttempts: 20 - steps.count('media-download'), preload: quiet && options.nativePrefetch,
            durationSeconds: metadata.movieDurationSeconds || source.duration || null,
            startSeconds: clampStreamSeek(savedResumeSeconds(episode, seriesId),
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
      if (!isHlsUrl(source.url) && !source.contentKey) {
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
      if ((!quiet || options.nativePrefetch) && source.contentKey && !isHlsUrl(source.url)) {
        await waitForOutputCleanup();
        const native = await (quiet ? openClearKeyStream : prepareNativeStream)({
          preload: quiet && options.nativePrefetch, video, source, codec: codecId(source.codec),
          workerOrigin: getWorkerOrigin(), signal, remainingMediaAttempts: 20 - steps.count('media-download'),
          startSeconds: savedResumeSeconds(episode, seriesId), onStage,
          retrySameSource: retryCurrentSource(variants, source, options.triedUrls)
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
        reason: isHlsUrl(source.url) ? 'hls' : 'cenc-unavailable',
        elapsedMs: ageMs()
      });
      let bytes;
      if (isHlsUrl(source.url)) {
        onStage('cdn.probe', { mode: 'whole-file' });
        failureStep = 'media-download'; steps.begin('media-download');
        if (!quiet) report('正在讀取分片清單…');
        bytes = await convertHls(source.url, {
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
      variants: null, source: null, tier: null, triedUrls: new Set(), candidateIds: new Map(),
      refreshCount: 0, refreshed: false, ready: false, error: null };
    log('prefetch.begin', { episode: Number(next.index) || 0,
      processingFinished: Boolean(context().stream?.finished?.()) });
    prefetched = entry;
    preparePrefetch(entry);
  }
  function recoverPrefetch(entry, code) {
    if (prefetched !== entry || entry.controller.signal.aborted) return;
    if (entry.source?.url) entry.triedUrls.add(entry.source.url);
    log('prefetch.recover', { episode: Number(entry.episode.index), code, ready: entry.ready,
      tried: entry.triedUrls.size });
    preparePrefetch(entry);
  }
  function preparePrefetch(entry) {
    entry.attemptController?.abort();
    const controller = new AbortController();
    entry.attemptController = controller;
    const signal = AbortSignal.any([entry.controller.signal, controller.signal]);
    const remaining = entry.tier && entry.variants
      ? sameTierPlaybackCandidates(entry.variants, { quality: entry.quality, codec: entry.codec }, entry.tier)
        .filter(source => !entry.triedUrls.has(source.url)) : null;
    let refresh = false;
    if (remaining && !remaining.length) {
      if (entry.refreshCount >= 20) {
        entry.error = errorWith('CENC_SOURCE_EXHAUSTED', '預載的同畫質來源及刷新來源均已失敗');
        entry.prepared = null; entry.ready = false; entry.promise = Promise.resolve(null);
        log('prefetch.failed', { episode: Number(entry.episode.index), code: entry.error.code });
        return;
      }
      refresh = true; entry.refreshCount++;
      log('prefetch.refresh', { episode: Number(entry.episode.index) });
    }
    entry.source = null; entry.prepared = null; entry.ready = false; entry.error = null;
    entry.promise = Promise.resolve().then(() => sourceForEpisode(entry.episode, signal, 0, {
      quiet: true, attempts: entry.attempts, quality: entry.quality, codec: entry.codec, seriesId: entry.seriesId,
      nativePrefetch: true, variants: refresh ? null : entry.variants,
      tier: entry.tier, triedUrls: entry.triedUrls, refresh, candidateIds: entry.candidateIds,
      onSource: (source, variants, attempts) => {
        entry.attempts = attempts;
        entry.source = source; entry.variants = variants;
        if (source.contentKey || codecId(source.codec) === 'bytevc2')
          entry.tier ||= { codec: codecId(source.codec), quality: qualityId(source) };
        if (refresh) entry.refreshed = true;
      },
      onPrefetchStage: (stage, fields) => {
        if (stage === 'preload.buffer' && fields.ready && !entry.ready) {
          entry.ready = true;
          log('prefetch.ready', { episode: Number(entry.episode.index), bytes: fields.bytes, units: fields.units });
        }
        const code = stage === 'media.slow' ? 'CENC_SOURCE_SLOW' : fields.code;
        if (!['media.slow', 'media.prefetch.stopped', 'media-range-retry',
          'range.retry', 'media-range-failed', 'mse.failed'].includes(stage) || !code) return;
        if (entry.tier && isRecoverableMediaSourceError(code)) recoverPrefetch(entry, code);
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
      if (entry.source?.url && isRecoverableMediaSourceError(error?.code)) entry.triedUrls.add(entry.source.url);
      if (entry.tier && isRecoverableMediaSourceError(error?.code) && prefetched === entry)
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
      if (handoff?.source?.url) lastSourceUrl = handoff.source.url;
      const attempt = sourceAttempt++;
      log('playback.attempt', { attempt: attempt + 1, elapsedMs: ageMs() });
      if (handoff && attempt === 0)
        reportStartup('正在接續預取的影片來源…', signal, attempt);
      let prepared = null;
      if (handoff && attempt === 0) {
        let pending;
        do { pending = handoff.promise; prepared = await pending; } while (pending !== handoff.promise);
        // Keep failed source identities and retry budgets across the handoff.
        for (const url of handoff.triedUrls) { triedSourceUrls.add(url); cencTriedUrls.add(url); }
        candidateIds = new Map(handoff.candidateIds);
        if (handoff.variants) {
          lastVariants = handoff.variants; lastWinnerVariants = handoff.variants;
          lastVariantsVid = episode.vid;
        }
        cencRetryTier = handoff.tier;
        sourceRefreshCount = handoff.refreshCount || 0;
        if (!prepared && handoff.error) throw handoff.error;
      }
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      let resolved = prepared || await sourceForEpisode(episode, signal, attempt);
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (prepared?.native?.activate) {
        prepared.native.activate();
        if (prepared.source?.url) {
          triedSourceUrls.add(prepared.source.url); cencTriedUrls.add(prepared.source.url);
          cencRetryTier = { codec: codecId(prepared.source.codec), quality: qualityId(prepared.source) };
        }
        if (prepared.native.kind === 'cenc-remux') retryIncrementalCenc = true;
        log('prefetch.handoff', { episode: Number(episode.index) || 0, media: true, ready: handoff.ready });
      }
      if (resolved?.bvc2Pending) {
        resolved = await sourceForEpisode(episode, signal, attempt,
          { variants: resolved.variants, winnerVariants: resolved.winnerVariants });
      }
      if (resolved?.nativePending) {
        await waitForOutputCleanup();
        const native = await prepareNativeStream({
          video, source: resolved.source, codec: codecId(resolved.source.codec),
          workerOrigin: getWorkerOrigin(), signal,
          startSeconds: savedResumeSeconds(episode),
          retrySameSource: retryCurrentSource(prepared.variants, resolved.source),
          onStage: streamStageReporter(signal, attempt, false, episode)
        });
        resolved = native ? { ...resolved, native, url: native.url, nativePending: false }
          : await sourceForEpisode(episode, signal, attempt,
            { variants: prepared.variants });
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
      sourceAttempt = 0; lastSourceUrl = ''; rateRetryUrl = ''; activeAttempts = createPlaybackAttempts(); pendingSourceExpansion = null;
      triedSourceUrls = new Set(); cencTriedUrls = new Set(); candidateIds = new Map();
      sourceRefreshCount = 0; cencRetryTier = null; streamFailure = null;
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
    retryAfterRateLimit() {
      rateRetryUrl = lastSourceUrl;
      cencTriedUrls.delete(lastSourceUrl); triedSourceUrls.delete(lastSourceUrl);
    },
    canRetrySource(code, episode) {
      const retry = canTryNextCencSource({ code, variants: lastVariants,
        variantsVid: lastVariantsVid, episodeVid: episode.vid,
        tried: cencTriedUrls.size, triedUrls: cencTriedUrls, tier: cencRetryTier,
        quality: selection().quality, codec: selection().codec });
      if (retry && cencRetryTier?.codec === 'hevc') retryIncrementalCenc = true;
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
