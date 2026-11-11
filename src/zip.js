// Streaming ZIP64 (stored entries, no recompression of video). Never buffers
// an entire series. Each entry is opened lazily so the producer holds at most
// one episode at once. Works with Blob fallback and a service-worker download.
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const b of bytes) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function header(n) {
  const data = new Uint8Array(n);
  const view = new DataView(data.buffer);
  return { data, u16: (i, x) => view.setUint16(i, x, true),
    u32: (i, x) => view.setUint32(i, x >>> 0, true),
    u64: (i, x) => view.setBigUint64(i, BigInt(x), true) };
}
function local(name) {
  const h = header(30 + name.length + 20);
  h.u32(0, 0x04034b50); h.u16(4, 45); h.u16(6, 0x0808);
  h.u32(18, 0xffffffff); h.u32(22, 0xffffffff);
  h.u16(26, name.length); h.u16(28, 20);
  h.data.set(name, 30);
  const x = 30 + name.length;
  h.u16(x, 1); h.u16(x + 2, 16);
  // Unknown sizes: data descriptor follows each entry.
  return h.data;
}
function descriptor(checksum, size) {
  const h = header(24);
  h.u32(0, 0x08074b50); h.u32(4, checksum);
  h.u64(8, size); h.u64(16, size);
  return h.data;
}
function central(name, checksum, size, offset) {
  const h = header(46 + name.length + 28);
  h.u32(0, 0x02014b50); h.u16(4, 45); h.u16(6, 45);
  h.u16(8, 0x0808); h.u32(16, checksum);
  h.u32(20, 0xffffffff); h.u32(24, 0xffffffff);
  h.u16(28, name.length); h.u16(30, 28);
  h.u32(42, 0xffffffff);
  h.data.set(name, 46);
  const p = 46 + name.length;
  h.u16(p, 1); h.u16(p + 2, 24);
  h.u64(p + 4, size); h.u64(p + 12, size); h.u64(p + 20, offset);
  return h.data;
}
function trailer(count, directorySize, directoryOffset) {
  const h = header(56 + 20 + 22);
  h.u32(0, 0x06064b50); h.u64(4, 44);
  h.u16(12, 45); h.u16(14, 45);
  h.u64(24, count); h.u64(32, count);
  h.u64(40, directorySize); h.u64(48, directoryOffset);
  h.u32(56, 0x07064b50); h.u64(64, directoryOffset + directorySize);
  h.u32(72, 1);
  h.u32(76, 0x06054b50);
  h.u16(84, 0xffff); h.u16(86, 0xffff);
  h.u32(88, 0xffffffff); h.u32(92, 0xffffffff);
  return h.data;
}
export async function* zipChunks(entries, { signal, onEntry } = {}) {
  const directory = [];
  let written = 0n;
  for await (const entry of entries) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!entry.name || /[/\\]|^\./.test(entry.name)) throw new TypeError('Unsafe ZIP entry filename');
    const name = encoder.encode(entry.name);
    if (name.length > 65535) throw new TypeError('ZIP entry filename too long');
    // Resolve content before emitting the header so a failed episode can be
    // skipped/retried rather than leaving a partially emitted ZIP entry.
    const stream = await entry.open();
    const offset = written;
    const head = local(name);
    yield head; written += BigInt(head.length);
    const reader = stream.getReader();
    let size = 0n, checksum = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        checksum = crc32(chunk, checksum);
        size += BigInt(chunk.byteLength);
        written += BigInt(chunk.byteLength);
        yield chunk;
      }
    } finally { reader.releaseLock(); }
    const tail = descriptor(checksum, size);
    yield tail; written += BigInt(tail.length);
    directory.push(central(name, checksum, size, offset));
    onEntry?.(entry.name, size);
  }
  const directoryOffset = written;
  for (const record of directory) {
    yield record;
    written += BigInt(record.length);
  }
  yield trailer(BigInt(directory.length), written - directoryOffset, directoryOffset);
}
export function zipReadableStream(entries, options) {
  const iterator = zipChunks(entries, options)[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); }
  });
}
