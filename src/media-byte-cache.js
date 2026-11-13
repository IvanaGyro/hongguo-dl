// SPDX-License-Identifier: GPL-3.0-only
// Sparse encrypted bytes, independent of demux/MSE lifetime. End offsets are
// exclusive; missing intervals are never represented by zero-filled pages.
const PAGE = 65536;
function merge(ranges) {
  const out = [];
  for (const [a, b] of ranges.sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(b, out.at(-1)[1]);
    else out.push([a, b]);
  }
  return out;
}
export function createMediaByteCache({ fileSize, budget = 32 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 1 || !Number.isFinite(budget) || budget < PAGE)
    throw new TypeError('Invalid byte cache bounds');
  const limit = Math.floor(budget / PAGE), pages = new Map();
  let clock = 0, evictedBytes = 0, hits = 0, misses = 0;
  const valid = (start, size) => Number.isSafeInteger(start) && Number.isSafeInteger(size) &&
    start >= 0 && size > 0 && start + size <= fileSize;
  const ranges = () => merge([...pages].flatMap(([index, page]) =>
    page.ranges.map(([a, b]) => [index * PAGE + a, index * PAGE + b])));
  const firstMissing = (start, end) => {
    let position = start;
    while (position < end) {
      const index = Math.floor(position / PAGE), page = pages.get(index);
      if (!page) return position;
      let within = position % PAGE;
      for (const [a, b] of page.ranges) {
        if (b <= within) continue;
        if (a > within) return index * PAGE + within;
        within = b;
        if (index * PAGE + within >= end) return null;
      }
      if (within < PAGE) return index * PAGE + within;
      position = (index + 1) * PAGE;
    }
    return null;
  };
  return {
    write(start, bytes, pinned = false) {
      if (!(bytes instanceof Uint8Array) || !valid(start, bytes.length))
        throw new TypeError('Invalid cache write');
      for (let offset = 0; offset < bytes.length;) {
        const position = start + offset, index = Math.floor(position / PAGE);
        const within = position % PAGE, count = Math.min(PAGE - within, bytes.length - offset);
        let page = pages.get(index);
        if (!page) {
          if (pages.size >= limit) {
            const oldest = [...pages].filter(([, p]) => !p.pinned)
              .sort((a, b) => a[1].used - b[1].used)[0];
            if (!oldest) throw new Error('Pinned metadata exceeds cache budget');
            evictedBytes += oldest[1].ranges.reduce((n, [a, b]) => n + b - a, 0);
            pages.delete(oldest[0]);
          }
          page = { data: new Uint8Array(PAGE), ranges: [], used: 0, pinned: false };
          pages.set(index, page);
        }
        page.data.set(bytes.subarray(offset, offset + count), within);
        page.ranges = merge([...page.ranges, [within, within + count]]);
        page.pinned ||= pinned; page.used = ++clock;
        offset += count;
      }
    },
    read(start, size) {
      if (!valid(start, size)) throw new TypeError('Invalid cache read');
      if (firstMissing(start, start + size) !== null) { misses++; return null; }
      hits++;
      const output = new Uint8Array(size);
      for (let offset = 0; offset < size;) {
        const position = start + offset, page = pages.get(Math.floor(position / PAGE));
        const within = position % PAGE, count = Math.min(PAGE - within, size - offset);
        output.set(page.data.subarray(within, within + count), offset);
        page.used = ++clock; offset += count;
      }
      return output;
    },
    firstMissing,
    get stats() {
      const intervals = ranges(), cachedBytes = intervals.reduce((n, [a, b]) => n + b - a, 0);
      return { byteRanges: intervals, cachedBytes, allocatedBytes: pages.size * PAGE,
        cacheBudget: limit * PAGE, evictedBytes, cacheHits: hits, cacheMisses: misses,
        complete: cachedBytes === fileSize };
    }
  };
}
