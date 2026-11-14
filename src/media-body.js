// SPDX-License-Identifier: GPL-3.0-only
// A 206 Content-Length describes this response, not necessarily the file.
// Continue server-capped open-ended responses at the first missing byte.
import { errorWith } from './logic.js';
import { withRangeDeadline } from './range-deadline.js';
export async function* readMediaBody(response, { fetchImpl, url, signal,
  maxBytes, timeoutMs, onTotal = () => {} }) {
  let offset = 0, total = null, etag = null;
  while (true) {
    if (signal?.aborted) {
      void response.body?.cancel().catch(() => {});
      throw errorWith('CANCELED', '使用者取消');
    }
    const tag = response.headers.get('etag');
    if (etag && tag && etag !== tag) {
      void response.body?.cancel().catch(() => {});
      throw errorWith('MEDIA_RANGE_INVALID', '接續來源的檔案版本已變更');
    }
    if (tag) etag = tag;
    const advertised = response.headers.get('content-length');
    let expected = advertised === null ? null : /^\d+$/.test(advertised) ? Number(advertised) : NaN;
    if (response.status === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (!match || Number(match[1]) !== offset || Number(match[2]) < offset ||
          Number(match[2]) >= Number(match[3]) ||
          total !== null && total !== Number(match[3]) ||
          expected !== null && expected !== Number(match[2]) - offset + 1) {
        void response.body?.cancel().catch(() => {});
        throw errorWith('MEDIA_RANGE_INVALID', '媒體範圍回應與檔案不符');
      }
      total = Number(match[3]); expected = Number(match[2]) - offset + 1;
    } else if (response.status === 200 && offset === 0) total = expected;
    else {
      void response.body?.cancel().catch(() => {});
      const code = response.status === 403 ? 'MEDIA_SOURCE_FORBIDDEN' :
        response.status === 429 ? 'MEDIA_RATE_LIMITED' : 'MEDIA_HTTP';
      throw Object.assign(errorWith(code, '媒體來源回傳 HTTP ' + response.status), { status: response.status });
    }
    if (total !== null && (!Number.isSafeInteger(total) || total > maxBytes) ||
        expected !== null && !Number.isSafeInteger(expected)) {
      void response.body?.cancel().catch(() => {});
      throw errorWith('MEMORY_LIMIT', '媒體超過下載／記憶體安全限制');
    }
    onTotal(total || 0);
    if (!response.body) throw errorWith('EMPTY_MEDIA', '來源未回傳資料串流');
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    let received = 0;
    try {
      while (true) {
        const { done, value } = await withRangeDeadline(() => reader.read(), signal, timeoutMs);
        if (signal?.aborted) throw errorWith('CANCELED', '使用者取消');
        if (done) break;
        if (!(value instanceof Uint8Array) || expected !== null && received + value.length > expected)
          throw errorWith('MEDIA_RANGE_INVALID', '媒體回應超過宣告範圍');
        received += value.length; offset += value.length;
        if (offset > maxBytes) throw errorWith('MEMORY_LIMIT', '媒體超過下載／記憶體安全限制');
        yield { bytes: value, total: total || 0 };
      }
      if (expected !== null && received !== expected)
        throw errorWith('INCOMPLETE', '媒體回應長度不足');
    } finally {
      signal?.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
    if (total === null || offset === total) return;
    if (!received || offset > total) throw errorWith('INCOMPLETE', '媒體回應長度不足');
    response = await withRangeDeadline(localSignal => fetchImpl(url, {
      signal: localSignal, cache: 'no-store', headers: { Range: 'bytes=' + offset + '-' }
    }), signal, timeoutMs);
  }
}
