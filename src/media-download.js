// Layer 1: source transport and complete-byte reads. Streaming byte reads use
// cached-media-reader.js, which owns its own range cache and network lookahead.
import { mediaProxyUrl, errorWith } from './logic.js';
import { createMediaTransportForSource, isApprovedDirectMediaUrl } from './media-transport.js';

export function createMediaDownload({ fetchBytes, getWorkerOrigin, fetchImpl = (...args) => fetch(...args) }) {
  const profileFor = source => source.source === 'app' ? 'app' : 'web';
  function open(source, onFallback) {
    const profile = profileFor(source);
    const proxyUrl = mediaProxyUrl(source.url, profile, getWorkerOrigin(), source.userAgent);
    const transport = createMediaTransportForSource(source.url, profile, getWorkerOrigin(),
      fetchImpl, onFallback, source.userAgent);
    return { proxyUrl, transport, url: transport.mode === 'direct' ? source.url : proxyUrl };
  }
  return {
    open,
    read(source, signal, maxBytes, onChunk, url = source.url) {
      return fetchBytes(url, profileFor(source), signal, maxBytes, onChunk, source.userAgent);
    },
    async nativeSource(source, signal, onFallback) {
      const { proxyUrl, transport } = open(source, onFallback);
      if (!isApprovedDirectMediaUrl(source.url)) return { url: proxyUrl };
      const probe = await transport.fetch(source.url, {
        headers: { Range: 'bytes=0-15' }, signal, cache: 'no-store'
      });
      await probe.body?.cancel().catch(() => {});
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (probe.status === 429)
        throw errorWith('MEDIA_RATE_LIMITED', '來源回傳 HTTP 429，暫停重試');
      // Native video can consume a complete 200 response; JS range demux needs 206.
      if (probe.status !== 206 && probe.status !== 200)
        throw errorWith(probe.status === 403 ? 'MEDIA_SOURCE_FORBIDDEN' : 'MEDIA_HTTP',
          '媒體來源 HTTP ' + probe.status);
      const directUrl = probe.status === 206 && transport.mode === 'direct' ? source.url : null;
      return { url: directUrl || proxyUrl, directProxyFallback: directUrl ? proxyUrl : null };
    }
  };
}
