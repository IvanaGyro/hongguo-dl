// SPDX-License-Identifier: GPL-3.0-only
// Media Worker, layer 1 (download): one application-owned source. It opens
// the initial `Range: bytes=0-` response, inspects bounded MP4 metadata from
// that same response, and then adopts the response body into the byte cache
// that the processing layer reads. Everything stays in this Worker: no
// ReadableStream or metadata copy crosses a thread on the way to WASM.
import { createMediaTransport, isAcceptedMediaTransportUrl } from './media-transport.js';
import { openProgressiveMediaDownload } from './progressive-media-download.js';
import { probeCencKid } from './mp4-metadata.js';
import { createCachedMediaReader } from './cached-media-reader.js';
import { normalizeBvc2Config } from './bvc2-config.js';
import { RANGE_TIMEOUT_MS } from './range-deadline.js';

const hex = bytes => bytes ? [...bytes].map(value => value.toString(16).padStart(2, '0')).join('') : null;
const coded = (code, status = 0) => Object.assign(new Error(code), { code, status });

// Merge probe ranges that are not already inside the persistent prefix.
function mergeRanges(prefixRanges, probeRanges) {
  return [...prefixRanges, ...probeRanges.filter(range => !prefixRanges.some(prefix =>
    range.offset >= prefix.offset &&
    range.offset + range.data.length <= prefix.offset + prefix.data.length))];
}

export function createMediaSource({ source, origin, fetchImpl, onStage = () => {},
  onFailure = () => {}, cacheBudget, timeoutMs = RANGE_TIMEOUT_MS }) {
  const controller = new AbortController();
  let progressive = null, transport = null, metadata = null, reader = null;
  let probeRanges = [], released = null, closed = false;
  const mediaUrl = new URL(source.url, origin).href;
  const opened = (async () => {
    if (!isAcceptedMediaTransportUrl(mediaUrl, origin) ||
        (source.proxyUrl && !isAcceptedMediaTransportUrl(source.proxyUrl, origin)))
      throw coded('MEDIA_SOURCE_INVALID');
    transport = createMediaTransport({
      retryRejectedDirect: false, directUrl: mediaUrl, proxyUrl: source.proxyUrl || mediaUrl,
      fetchImpl, sessionFailureCache: null,
      onFallback: (reason, fields) => onStage('media.transport.fallback', { reason, ...fields })
    });
    progressive = await openProgressiveMediaDownload({
      url: mediaUrl, fetchImpl: transport.fetch, signal: controller.signal, onStage, timeoutMs
    });
    const info = {};
    const kid = await probeCencKid(mediaUrl, controller.signal, transport.fetch, info,
      onStage, timeoutMs, null, progressive);
    probeRanges = info.initialRanges || [];
    metadata = Object.freeze({
      fileSize: info.fileSize || progressive.fileSize,
      indexed: Boolean(info.fileSize), fragmented: Boolean(info.fragmented),
      hasAac: Boolean(info.hasAac), videoCodec: info.videoCodec || null,
      hevcCodecString: info.hevcCodecString || null, audioTracks: info.audioTracks || 0,
      durationSeconds: info.movieDurationSeconds || null,
      hasKid: Boolean(kid), kid: hex(kid)
    });
    onStage('metadata.probed', {
      hasKid: metadata.hasKid, fragmented: metadata.fragmented, fileBytes: metadata.fileSize,
      hasAac: metadata.hasAac, duration: metadata.durationSeconds || 0,
      codec: metadata.videoCodec || 'unknown', codecString: metadata.hevcCodecString || 'unknown'
    });
    return metadata;
  })();
  // Close the abandoned connection promptly if probing fails.
  opened.catch(() => close());

  function takePrefix() {
    if (released) return released;
    if (!progressive) return { initialRanges: [] };
    released = progressive.handoff();
    return released;
  }
  function close() {
    if (closed) return;
    closed = true;
    controller.abort();
    reader?.close();
    released?.initialStream?.cancel().catch(() => {});
    progressive?.close();
    probeRanges = [];
  }
  return {
    opened,
    get metadata() { return metadata; },
    get readerOpen() { return Boolean(reader); },
    /**
     * Release the HTTP response when only metadata consumers remain.
     * The bounded metadata ranges stay available for a later byte reader.
     */
    releaseNetwork() {
      if (closed || reader || !progressive) return;
      const shared = takePrefix();
      shared.initialStream?.cancel().catch(() => {});
      released = { ...shared, initialStream: null };
      progressive.close();
      onStage('media.network.released', { reason: 'metadata-only' });
    },
    /** The processing layer's byte reader, sharing this source's cache. */
    reader() {
      if (reader) return reader;
      if (!metadata || closed) throw coded('CANCELED');
      const shared = takePrefix();
      let initialRanges = mergeRanges(shared.initialRanges || [], probeRanges);
      probeRanges = [];
      if (source.bridge === 'bvc2') {
        initialRanges = initialRanges.map(range => ({ ...range,
          data: normalizeBvc2Config(range.data, { inPlace: true }).bytes }));
        onStage('bvc2.config', { indexNormalized: true });
      }
      reader = createCachedMediaReader({
        fetchImpl: transport.fetch, url: mediaUrl, fileSize: metadata.fileSize,
        initialRanges, initialStream: shared.initialStream || null,
        initialOffset: shared.initialOffset || 0, initialEnd: shared.initialEnd || 0,
        initialEtag: shared.initialEtag || null,
        durationSeconds: metadata.durationSeconds || 0, budget: cacheBudget,
        signal: controller.signal, timeoutMs,
        onStage: (stage, fields) => {
          onStage(stage, fields);
          // A failed background pump invalidates this candidate immediately,
          // even while the decoder still has buffered media to play.
          if (stage === 'media.prefetch.stopped') onFailure(fields);
        },
        onResponse: fields => onStage('media-range', fields)
      });
      released = { ...shared, initialStream: null };
      return reader;
    },
    close
  };
}
