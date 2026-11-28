// SPDX-License-Identifier: GPL-3.0-only
// OFFLINE TEST ONLY: CENC (AES-128-CTR, full-sample) encryption of the video
// track of a progressive MP4, for codecs FFmpeg's muxer cannot encrypt
// (ByteVC2/VVC). Samples are encrypted in place; the sample entry becomes
// encv with sinf(frma, schm 'cenc', tenc) and per-sample IVs go to a senc box
// in stbl, as FFmpeg's own CENC muxer writes them.
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';

const box = (type, ...parts) => {
  const data = Buffer.concat(parts);
  const out = Buffer.alloc(8 + data.length);
  out.writeUInt32BE(out.length); out.write(type, 4, 4, 'ascii'); data.copy(out, 8);
  return out;
};
const full = (type, version, flags, ...parts) => {
  const head = Buffer.alloc(4); head.writeUInt32BE((version << 24) | flags);
  return box(type, head, ...parts);
};
function children(data) {
  const out = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    const size = data.readUInt32BE(offset);
    assert(size >= 8 && offset + size <= data.length, 'Malformed MP4 box');
    out.push({ type: data.toString('ascii', offset + 4, offset + 8), start: offset,
      body: data.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return out;
}
const find = (data, type) => children(data).find(child => child.type === type)?.body;

// Absolute file offset and size of every sample of one trak.
function sampleRanges(stbl) {
  const stsz = find(stbl, 'stsz'), stsc = find(stbl, 'stsc');
  const stco = find(stbl, 'stco'), co64 = find(stbl, 'co64');
  const fixed = stsz.readUInt32BE(4), count = stsz.readUInt32BE(8);
  const sizes = Array.from({ length: count }, (_, i) => fixed || stsz.readUInt32BE(12 + 4 * i));
  const chunks = stco ? Array.from({ length: stco.readUInt32BE(4) }, (_, i) => stco.readUInt32BE(8 + 4 * i))
    : Array.from({ length: co64.readUInt32BE(4) }, (_, i) => Number(co64.readBigUInt64BE(8 + 8 * i)));
  const runs = Array.from({ length: stsc.readUInt32BE(4) }, (_, i) =>
    ({ first: stsc.readUInt32BE(8 + 12 * i) - 1, perChunk: stsc.readUInt32BE(12 + 12 * i) }));
  const ranges = [];
  for (let chunk = 0, sample = 0; chunk < chunks.length; chunk++) {
    const run = runs.findLast(r => r.first <= chunk);
    for (let i = 0, offset = chunks[chunk]; i < run.perChunk && sample < count; i++, sample++) {
      ranges.push({ offset, size: sizes[sample] });
      offset += sizes[sample];
    }
  }
  assert.equal(ranges.length, count, 'Every sample has a chunk');
  return ranges;
}

/**
 * Returns a copy of `mp4` (moov before or after mdat) with its video track
 * encrypted. `key` and `kid` are 32 hex digits.
 */
export function encryptCencVideo(mp4, { key, kid }) {
  const input = Buffer.from(mp4), output = Buffer.from(input);
  const top = children(input), moovBox = top.find(b => b.type === 'moov');
  const mdatBox = top.find(b => b.type === 'mdat');
  assert(moovBox && mdatBox, 'Progressive MP4 with moov and mdat');
  const keyBytes = Buffer.from(key, 'hex'), kidBytes = Buffer.from(kid, 'hex');
  assert(keyBytes.length === 16 && kidBytes.length === 16, '128-bit key and KID');
  let encrypted = 0;
  const rewriteTrak = trak => {
    const mdia = find(trak, 'mdia');
    if (find(mdia, 'hdlr').toString('ascii', 8, 12) !== 'vide') return box('trak', trak);
    const stbl = find(find(mdia, 'minf'), 'stbl');
    const ivs = sampleRanges(stbl).map(({ offset, size }, index) => {
      const iv = Buffer.alloc(8); iv.writeUInt32BE(0x1000 + index, 4);
      const cipher = createCipheriv('aes-128-ctr', keyBytes, Buffer.concat([iv, Buffer.alloc(8)]));
      const clear = input.subarray(offset, offset + size);
      Buffer.concat([cipher.update(clear), cipher.final()]).copy(output, offset);
      return iv;
    });
    encrypted++;
    const count = Buffer.alloc(4); count.writeUInt32BE(ivs.length);
    const tenc = full('tenc', 0, 0, Buffer.from([0, 0, 1, 8]), kidBytes);
    const scheme = Buffer.alloc(8); scheme.write('cenc', 0, 'ascii'); scheme.writeUInt32BE(0x10000, 4);
    const entryRewrite = stsd => {
      const [entry] = children(stsd.subarray(8));
      // Visual sample entry: 78 bytes of fields, then child boxes.
      const sinf = box('sinf', box('frma', Buffer.from(entry.type, 'ascii')), full('schm', 0, 0, scheme),
        box('schi', tenc));
      return box('stsd', stsd.subarray(0, 8), box('encv', entry.body, sinf));
    };
    const stblOut = box('stbl', ...children(stbl).map(child => child.type === 'stsd'
      ? entryRewrite(child.body) : box(child.type, child.body)), full('senc', 0, 0, count, ...ivs));
    const minf = find(mdia, 'minf');
    const minfOut = box('minf', ...children(minf).map(c => c.type === 'stbl' ? stblOut : box(c.type, c.body)));
    const mdiaOut = box('mdia', ...children(mdia).map(c => c.type === 'minf' ? minfOut : box(c.type, c.body)));
    return box('trak', ...children(trak).map(c => c.type === 'mdia' ? mdiaOut : box(c.type, c.body)));
  };
  let moov = box('moov', ...children(moovBox.body).map(c =>
    c.type === 'trak' ? rewriteTrak(c.body) : box(c.type, c.body)));
  assert.equal(encrypted, 1, 'Exactly one video track');
  // A moov in front of mdat grew: move every chunk offset by the same delta.
  const delta = moov.length - (moovBox.body.length + 8);
  if (moovBox.start < mdatBox.start && delta) {
    const shift = data => box('moov', ...children(data).map(c => c.type !== 'trak' ? box(c.type, c.body)
      : box('trak', ...children(c.body).map(t => t.type !== 'mdia' ? box(t.type, t.body)
        : box('mdia', ...children(t.body).map(m => m.type !== 'minf' ? box(m.type, m.body)
          : box('minf', ...children(m.body).map(n => n.type !== 'stbl' ? box(n.type, n.body)
            : box('stbl', ...children(n.body).map(s => {
              const body = Buffer.from(s.body);
              if (s.type === 'stco') for (let i = 0; i < body.readUInt32BE(4); i++)
                body.writeUInt32BE(body.readUInt32BE(8 + 4 * i) + delta, 8 + 4 * i);
              if (s.type === 'co64') for (let i = 0; i < body.readUInt32BE(4); i++)
                body.writeBigUInt64BE(body.readBigUInt64BE(8 + 8 * i) + BigInt(delta), 8 + 8 * i);
              return box(s.type, body);
            }))))))))));
    moov = shift(moov.subarray(8));
  }
  return Buffer.concat(top.map(b => b.type === 'moov' ? moov
    : output.subarray(b.start, b.start + b.body.length + 8)));
}
