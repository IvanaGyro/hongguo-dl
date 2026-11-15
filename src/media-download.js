import { retryAfterMs } from './retry-after.js';
// Layer 1: source transport and complete-byte reads. Streaming byte reads use
// cached-media-reader.js, which owns its own range cache and network lookahead.
import { mediaProxyUrl, errorWith } from './logic.js';
import { createMediaTransportForSource, isApprovedDirectMediaUrl } from './media-transport.js';
import { downloadSource } from './download-source-session.js';

export function createMediaDownload({ fetchBytes, getWorkerOrigin, fetchImpl = (...args) => fetch(...args) }) {
  const profileFor = source => source.source === 'app' ? 'app' : 'web';
  function open(handle, onFallback, options = {}) {
    const source = downloadSource(handle);
    const profile = profileFor(source);
    const proxyUrl = mediaProxyUrl(source.url, profile, getWorkerOrigin(), source.userAgent);
    const transport = createMediaTransportForSource(source.url, profile, getWorkerOrigin(),
      fetchImpl, onFallback, source.userAgent, { retryRejectedDirect: false, ...options });
    return { proxyUrl, transport, url: transport.mode === 'direct' ? source.url : proxyUrl };
  }
  return {
    open,
    input(handle, transport) {
      const source = downloadSource(handle);
      const proxyUrl = mediaProxyUrl(source.url, profileFor(source), getWorkerOrigin(), source.userAgent);
      return { url: transport.mode === 'direct' ? source.url : proxyUrl, proxyUrl };
    },
    playlistUrl(handle) { return downloadSource(handle).url; },
    read(handle, signal, maxBytes, onChunk, url) {
      const source = downloadSource(handle);
      return fetchBytes(url || source.url, profileFor(source), signal, maxBytes, onChunk, source.userAgent);
    },
    async nativeSource(handle, signal, onFallback, onStage = () => {}) {
      const source = downloadSource(handle);
      const { proxyUrl, transport } = open(handle, onFallback);
      if (!isApprovedDirectMediaUrl(source.url)) return { url: proxyUrl };
      onStage('cdn.probe', { offset: 0, bytes: 16 });
      const probe = await transport.fetch(source.url, {
        headers: { Range: 'bytes=0-15' }, signal, cache: 'no-store'
      });
      await probe.body?.cancel().catch(() => {});
      if (signal.aborted) throw errorWith('CANCELED', '已切換影片');
      if (probe.status === 429)
        throw Object.assign(errorWith('MEDIA_RATE_LIMITED', '來源回傳 HTTP 429，等待後重試'),
          { status: 429, retryAfterMs: retryAfterMs(probe.headers.get('retry-after')) });
      // Native video can consume a complete 200 response; JS range demux needs 206.
      if (probe.status !== 206 && probe.status !== 200)
        throw errorWith(probe.status === 403 ? 'MEDIA_SOURCE_FORBIDDEN' : 'MEDIA_HTTP',
          '媒體來源 HTTP ' + probe.status);
      const directUrl = probe.status === 206 && transport.mode === 'direct' ? source.url : null;
      return { url: directUrl || proxyUrl, directProxyFallback: directUrl ? proxyUrl : null };
    }
  };
}
