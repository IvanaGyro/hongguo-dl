// SPDX-License-Identifier: GPL-3.0-only
// Mobile v5 player signer — faithful port of N3urda/hongguoTV Signer.kt (mobileV5
// path), itself derived from drpys 22261ad. Self-contained so the proven envelope
// is used verbatim. Produces x-khronos / x-helios / x-medusa (+ x-ss-stub) for the
// official-app player POST. Verified live against the real server (code=0 +
// video_model); replaces the earlier hand-assembled buildMedusaV5 envelope whose
// field21=377 / field23 layout returned HTTP 200 with an empty body.
'use strict';
const crypto = require('node:crypto');

const sm3 = require('./sm3'); // pure-JS SM3: Workers/bun have no native 'sm3' digest
const md5 = b => crypto.createHash('md5').update(b).digest();
const hex = s => Buffer.from(s, 'hex');
const le32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0); return b; };
const be32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n | 0); return b; };
const i32be = (buf, at) => buf.readInt32BE(at);
const u = x => x & 255;
const rol = (v, n) => { n &= 31; return n === 0 ? v | 0 : ((v << n) | (v >>> (32 - n))) | 0; };
const ror = (v, n) => { n &= 31; return n === 0 ? v | 0 : ((v >>> n) | (v << (32 - n))) | 0; };
const xorBuf = (a, b) => { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i % b.length]; return o; };
const M64 = (1n << 64n) - 1n;
const rotr64 = (v, n) => ((v >> BigInt(n)) | (v << BigInt(64 - n))) & M64;
const i64le = (buf, at) => { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(buf[at + k]); return v; };
const le64 = v => { const b = Buffer.alloc(8); for (let k = 0; k < 8; k++) { b[k] = Number(v & 0xffn); v >>= 8n; } return b; };

const V5 = {
  magic: hex('2d4b4fca49750d433fb5ae2c226dcc56'),
  license: '646637794',
  field21: 312, // 377 -> HTTP 200 empty body; 312 is the value the server accepts
  signKey: hex('b23c2a470a20d105dc3f8c4438f8272ed46d6c89ffdcdedd5108698d26e9489d'),
  sbox: hex(
    '53290fe9e51f316f90f74a7e034d367784ab49237cd0135cdc632c322fd3be0e2624a417ecd9151a7ff64f60730a87f9445ec6ada2f865d22b696c4188f24c0d' +
    'f37b75510b939f6bc2fe6883e68bc8c722181ba0bdb08c9871b50c9a16b46eea8eed20ba4b8a14e0fcf1468dbbef05a93e5a9d7dcf06898635c1fd99f5de287a' +
    '80c594daaab19b6279fbd75070cb52eb2555c456e39e7839853874e2f0013ac0b64742d8ca10e4b79c955de8b843ce4ed464a6a72ed508091c92e7b3eedd1e1d' +
    'd12afac321618fa3d65f9167c982f43d66a53c6a1997585b346dbf9672ff37cdbc073b2dae11453304df00815476b2a13fccdb30b957a8acafe1274002485912' +
    '38922563e36406d37a24100b7902a028044e218453c2a399199c9d13dc40c55ba67e502273850ebdc1a2e2188b8f2d9e3cb909b8c46a2a9f4a6dd93007eafa65' +
    'b7b3a881aa908cc74f0ad76bbbb58617c37012ca05a469fd44e62eecf1e4272ce860c0ae5eadf99b20d8f0234174006f3f110d7657d01645d4eff8f71471cbfe' +
    '1cb2f52648727bf3c9de55153e031b4d61757db63dbf7782eeafe9018a8891362fb14759ac32bab03b349aeb5a377c5156be4c8dfbe13a684bda39cf836697c8' +
    '94545fe0f2491acea9fc6252f4ff1e0fe72bd2df6e67a7f635e5bcc6d1a5dd951d89960887a18eb40c785cdb1f80ed42299333ab98cdd67f316cd54346585dcc' +
    'd759fb722789b08807cc0fda293f7e5e1819bb0353517020b31d3d00374952bea2c421e862040a9ec892a05b266b7a0d0cc316f483b81af39715657ffe32ad8d' +
    'e0c13077646035236ee5363e5f900e9a7cf850a81cd9960b6df73317226f99eaa6fff15cec34acb98246639b918ab2851466a7cdfc4ad1b52c2ae95a58d3734e' +
    '47ddd5b7560193f644ef9c408b7dee39b4d6aabf4de761e3252d4c7ba3843187745d55e6a5db05d42b45caed43c0c5d0b64bfa9d94a4a9d8f2f0e1a108dcfd28' +
    '8fd2bc1fc7bd675412138169cb09249875ba3b68cfb11180afae104fc9789571c6dfce02413886796ae21e3c488cc21b9f423a066c2eabf98e2fdeeb5776e4f5' +
    'd09a515ba58cbbab3e37b09fd4f6d9244df80512e84cd7956be301cf64f1429d58577cc241f3a2c655144f81aaf95a4e108da894b38970561ae9002619fbbac9' +
    '1fa922ed202bfc62cb08e0de2a7f3631435f8b47c8a3c563b4db4071ce74c46da6fa696a9e282d1e825d663b93bfd56c48dce1884bb10fccea063929f746443f' +
    'd830a4232e53da21a1f2d1bdfebc3a02c10a1b8ad31d04fd616590d272ac737e98eb33af60528716bee78ec0ee8699031177277d9cff32542c67caf5f4459168' +
    '1335ae0e178f3409a7803db83892dde5b9b7f0c750e24aef077badd678a09b850b84ec1597e4963cb5e675df1c0d6fb618496ecd76c35c798325590c2fb27a5e'),
};
const HASH_TABLE = [0xebb64faf,0x7aadcc2,0xcf3187bf,0xe01138ff,0x6d0bfcff,0x5a30a3be,0xb41ad638,0x34180eb8,0xf233eb6f,0xb1a584cc,0xccc30dc7,0x47d1db51,0xd55653de,0x70a84fa1,0x57473c12,0xf76f0288,0x2c077f0a,0xda0dcad0,0xfbb86f6c,0xfdc4cf00,0x688a020d,0xe676c6a6,0x8cd6338b,0x1a3c8d0e,0xcce8b06b,0x6ad0ed0b,0xa0522717,0xdc71ac83,0x2285db71,0xd5b4dda6,0x736f8650,0x6560306c,0x617ce2a6,0xe423417e,0xa40e143,0x544e4032,0x88dffb2a,0x716c1ae0,0x4c467a88,0x5b23bb3,0xe1d0b866,0xbaa3dcb8,0xae3374d3,0xc3381a50,0x1702f75b,0xfe6da368,0xf0b4cf48,0x4e0ffbb8,0x72aad10d,0x26c53a3d,0xf2bce0f6,0xb4557581,0x4a257fdd,0x8c3182a2,0xab0b3b86,0x3d5dfb14,0x4f103634,0xd37b52d7,0x444eff16,0xeb0a33d1,0x6ca86f6e,0x284ba7,0x8387cfa,0x5fb37586].map(x => x | 0);

function aesV3Encrypt(key, ts, source, iv) {
  if (source.length < 248) throw new Error('AesV3 source too short');
  const word = ts & 3;
  const box = Array.from(V5.sbox.subarray(word * 256, word * 256 + 256), b => b & 255);
  const con = [[2,0,3,1],[1,3,2,0],[3,2,1,0],[2,3,1,0]][word];
  const order = [[0,9,14,15,4,13,2,7,8,1,6,3,12,5,10,11],[0,9,14,11,4,13,2,3,8,1,6,15,12,5,10,7],[0,9,14,3,4,13,2,15,8,1,6,11,12,5,10,7],[0,9,14,15,4,13,2,3,8,1,6,11,12,5,10,7]][word];
  const initial = [0xbbb5de72|0,0xd4638d5b|0,0x92a5f73b|0,0x89f8a1c9|0][word];
  const expanded = Array.from(Buffer.concat([xorBuf(Buffer.concat([le32(initial),le32(initial),le32(initial),le32(initial)]), key), Buffer.alloc(32)]), b => b & 255);
  let rounds = 8;
  for (let i = 4; i < 12; i++) {
    const at = 4 * (i - 1);
    let a = expanded[at], b = expanded[at+1], c = expanded[at+2], d = expanded[at+3];
    if ((i & 3) === 0) { const t = ((initial >> (rounds & 24)) ^ box[b]) & 255; b = box[c]; c = box[d]; d = box[a]; a = t; }
    rounds += 2;
    expanded[at+4] = a ^ expanded[at-12]; expanded[at+5] = b ^ expanded[at-11];
    expanded[at+6] = c ^ expanded[at-10]; expanded[at+7] = d ^ expanded[at-9];
  }
  const keys = []; for (let i = 0; i < 12; i++) keys.push(expanded.slice(i*4, i*4+4));
  const block = (value) => {
    let rows = [[],[],[],[]]; for (let i=0;i<4;i++) for (let j=0;j<4;j++) rows[i][j] = value[i*4+j] & 255;
    const addCon = off => { for (let i=0;i<4;i++) for (let j=0;j<4;j++) rows[i][j] ^= keys[off+i][con[j]]; };
    addCon(0);
    for (let round = 1; round <= 2; round++) {
      for (let i=0;i<4;i++) for (let j=0;j<4;j++) rows[i][j] = box[rows[i][j] & 255];
      const before = rows.map(r => r.slice());
      for (let i=0;i<4;i++) rows[i] = before[con[i]].slice();
      const flat = rows.flat();
      for (let i=0;i<16;i++) rows[(i/4)|0][i%4] = flat[order[i]];
      if (round === 1) {
        for (let i=0;i<4;i++) { const old = rows[i].slice(); rows[i] = [old[con[0]],old[con[1]],old[con[2]],old[con[3]]]; }
        const xt = x => ((x << 1) ^ ((x & 128) ? 0x1b : 0)) & 255;
        for (let i=0;i<4;i++) {
          const t = rows[0][i]^rows[1][i]^rows[2][i]^rows[3][i]; const o = rows[0][i];
          rows[0][i] = (rows[0][i]^t^xt(rows[0][i]^rows[1][i])) & 255;
          rows[1][i] = (rows[1][i]^t^xt(rows[1][i]^rows[2][i])) & 255;
          rows[2][i] = (rows[2][i]^t^xt(rows[2][i]^rows[3][i])) & 255;
          rows[3][i] = (rows[3][i]^t^xt(rows[3][i]^o)) & 255;
        }
      }
      addCon(round*4);
    }
    for (let i=0;i<4;i++) for (let j=0;j<4;j++) rows[i][j] ^= keys[4+i][j];
    return Buffer.from(rows.flat().map(x => x & 255));
  };
  const wire = [6,5,3,4,2,7,1,0], compact = [1,7,3,6,2,0,4,5];
  const plaintext = Buffer.alloc(32);
  for (let i=0;i<31;i++) for (let j=0;j<8;j++) plaintext[i] |= (((source[i*8+j] >>> wire[j]) & 1) << compact[j]);
  plaintext[31] = 1;
  const first = block(xorBuf(plaintext.subarray(0,16), iv));
  const key2 = Buffer.concat([first, block(xorBuf(plaintext.subarray(16,32), first))]);
  const out = Buffer.from(source);
  for (let i=0;i<31;i++) for (let j=0;j<8;j++) { const at = i*8+j; out[at] = (out[at] & ~(1<<wire[j])) | (((key2[i] >>> compact[j]) & 1) << wire[j]); }
  return Buffer.concat([Buffer.from([key2[key2.length-1]]), out]);
}

function varint(value) { let n = BigInt(value); const out = []; while (n > 127n) { out.push(Number((n & 127n) | 128n)); n >>= 7n; } out.push(Number(n)); return Buffer.from(out); }
const Fd = (tag, value, type = 'string') => ({ tag, value, type });
function proto(...fields) {
  const parts = [];
  for (const { tag, value, type } of fields) {
    if (type === 'sint') { parts.push(varint(BigInt(tag) << 3n)); const n = BigInt(value); parts.push(varint(n < 0n ? -n * 2n - 1n : n * 2n)); }
    else if (type === 'float') { parts.push(varint((BigInt(tag) << 3n) | 5n)); const b = Buffer.alloc(4); b.writeFloatLE(Number(value)); parts.push(b); }
    else { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); if (bytes.length) { parts.push(varint((BigInt(tag) << 3n) | 2n)); parts.push(varint(bytes.length)); parts.push(bytes); } }
  }
  return Buffer.concat(parts);
}

function getIv(initial, data) {
  let v = initial | 0;
  for (let i = 0; i < data.length; i++) v = (i & 1) === 0 ? ((v >>> 4) ^ v ^ (v << 6) ^ u(data[i])) | 0 : (~((v >>> 7) ^ v ^ (u(data[i]) | (v << 12)))) | 0;
  return v;
}
const ivHash = (query, body, ts) => getIv(getIv(getIv(0x20230928, query), body), le32(ts));
const rawBranch = (queryStr, body, ts) => ivHash(sm3(Buffer.from(queryStr, 'utf8')), body ? md5(body) : Buffer.alloc(16), ts) & 15;

function sumMd5(data) {
  let check = 0x20220420 | 0;
  for (let i = 0; i < 12; i++) {
    const temp = ((check >>> ((i & 1) === 0 ? 3 : 5)) ^ check) | 0;
    check = (i & 1) === 0 ? (u(data[i]) ^ (check << 7)) | 0 : (~(u(data[i]) | (check << 11))) | 0;
    check = (check ^ temp) | 0;
  }
  return ((check | 4) ^ 0x1000000) | 0;
}

function hashF13(query, body, ts) {
  const ivV1 = 0x9d4a97c2 | 0;
  const count = (ivV1 + ts) | 0;
  const tt = HASH_TABLE.map(x => ror(x, count + 1));
  const shift = (count + 2) & 7;
  const pad = Buffer.from([0xfa, 0x45, 0x61, 0xd7].map(x => ((x | (x << 8)) >> shift) & 255));
  const data = Buffer.concat([query, body, le32(ts), pad, hex('00000000000001a0')]);
  const di = []; for (let i = 0; i < data.length; i += 4) di.push(i32be(data, i));
  for (let i = 0; i < 112; i++) { const x = di[i+1], y = di[i+14]; di.push((di[i] + di[i+9] + ((rol(x,14) ^ rol(x,25) ^ (x >>> 3)) | 0) + ((rol(y,13) ^ rol(y,15) ^ (y >>> 10)) | 0)) | 0); }
  const initialArr = [0x7aba4fc8,0x67166507,0x6403fa00,0x340f512f,984304912,3005047866,2874125293,2152413264].map(x => ror(x | 0, count));
  const chosen = [96,1,3,4,0,6,5,2,0,7,7];
  const d = initialArr.slice();
  for (let i = 0; i < chosen[0]; i++) {
    const base = (ivV1 + i) | 0;
    const n1 = (((d[chosen[3]] ^ d[chosen[4]]) & d[chosen[1]]) ^ d[chosen[3]]) | 0;
    const n2 = (rol(d[chosen[1]],26) ^ rol(d[chosen[1]],21) ^ rol(d[chosen[1]],7)) | 0;
    const n4 = (di[base & 127] + n1 + n2 + tt[base & 63] + d[chosen[5]]) | 0;
    const n5 = (rol(d[chosen[2]],30) ^ rol(d[chosen[2]],19) ^ rol(d[chosen[2]],10)) | 0;
    const n6 = ((d[chosen[2]] & d[chosen[6]]) | ((d[chosen[2]] | d[chosen[6]]) & d[chosen[7]])) | 0;
    const old = d[chosen[9]];
    d.unshift(d.splice(7, 1)[0]);
    d[chosen[10]] = (n5 + n6 + n4) | 0;
    d[chosen[8]] = (old + n4) | 0;
  }
  let ret = Buffer.alloc(0);
  for (let i = 0; i < 8; i++) ret = Buffer.concat([ret, be32((d[i] + initialArr[i]) | 0)]);
  const folded = xorBuf(ret.subarray(0,16), ret.subarray(16,32));
  return Buffer.concat([folded, le32((sumMd5(folded) | 0x20) | 0)]);
}

const rnd = () => (Math.random() * 4294967296) | 0;
function helios(ts) {
  const random = rnd();
  const ascii = Buffer.from(md5(Buffer.concat([le32(random), Buffer.from('8662')])).toString('hex'), 'ascii');
  let words = [i64le(ascii,0), i64le(ascii,8), i64le(ascii,16), i64le(ascii,24)];
  const table = [words[0]];
  let b0 = words.shift(), b8 = words.shift();
  for (let i = 0; i < 34; i++) {
    let x8 = ((rotr64(b8, 8) + b0) & M64) ^ BigInt(i);
    words.push(x8 & M64); x8 = (x8 ^ rotr64(b0, 61)) & M64; table.push(x8); b0 = x8; b8 = words.shift();
  }
  const text = Buffer.from(`${ts}-${V5.license}-8662`);
  const padding = 16 - (text.length % 16);
  const data = Buffer.concat([text, Buffer.alloc(padding, padding)]);
  let output = le32(random);
  for (let at = 0; at < data.length; at += 16) {
    let a = i64le(data, at), b = i64le(data, at + 8);
    for (let i = 0; i < 34; i++) { b = (table[i] ^ ((a + rotr64(b, 8)) & M64)) & M64; a = (b ^ rotr64(a, 61)) & M64; }
    output = Buffer.concat([output, le64(a), le64(b)]);
  }
  return output.toString('base64');
}

function xmxor(data, key) {
  const enc = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const at = (i * 4) & 28; const d0 = u(key[at]), d1 = u(key[at + 1]); const v = u(data[i]);
    let d2 = (((v << 4) | (v >>> 4)) & 255) + d0;
    d2 = (~d2) ^ d1; d2 = (((d2 & 255) << 3) | ((d2 & 255) >>> 5)) & 255; d2 = (d2 + d1) & 255; d2 = (d2 ^ d0) & 255;
    enc[data.length - i - 1] = (~d2) & 255;
  }
  const last = enc[enc.length - 1] ^ enc[enc.length - 2]; const first = enc[0];
  enc[0] = ((~last) + first) & 255;
  enc[1] = ((enc[0] ^ enc[enc.length - 1] ^ 254) + enc[1]) & 255;
  enc[2] = (enc[2] + (((last - first) ^ (((enc[1] << 3) | (enc[1] >>> 5)) & 255) ^ 2))) & 255;
  for (let i = 0; i < enc.length - 4; i++) { const temp = ((((enc[i+2] << 3) | (enc[i+2] >>> 5)) & 255) ^ enc[i+1] ^ (i + 3)); enc[i+3] = ((~temp) + enc[i+3]) & 255; }
  enc[enc.length - 1] = enc[enc.length - 1] ^ enc[enc.length - 2];
  let sum = 0; for (let i = 1; i < enc.length; i++) sum += enc[i];
  enc[0] = ((enc[0] ^ enc[1]) + sum) & 255;
  return Buffer.from(enc.map(x => x & 255));
}

// Per-isolate process identity (cold-start nonce + start time), as the official app.
const processNonce = crypto.randomBytes(18).toString('base64url');
const deviceToken = (processNonce.length === 25 && processNonce.startsWith('A')) ? processNonce : ('A' + (processNonce + 'A'.repeat(24)).slice(0, 24));
const processStarted = Date.now();

function medusaV5(url, body, ts, who) {
  const query = sm3(Buffer.from(url.split('?')[1], 'utf8'));
  const f13 = hashF13(query, body ? md5(body) : Buffer.alloc(16), ts);
  const flags = hex('4480000000000000');
  const version = who.version_name;
  const brand = who.device_brand && who.device_brand.length ? who.device_brand : 'HONOR';
  const type = who.device_type;
  const envLaunch = ((Math.random() * 21) | 0) + 100, envPid = ((Math.random() * 2000) | 0) + 10001;
  const deviceInfo = proto(
    Fd(1,1,'sint'),Fd(2,2,'sint'),Fd(3,'8662'),Fd(4,who.device_id),Fd(5,deviceToken),Fd(6,'!noperm!'),
    Fd(7,-888888,'sint'),Fd(8,-888888,'sint'),Fd(9,3,'sint'),Fd(10,-888888,'sint'),Fd(11,'!notset!'),Fd(12,'Asia/Shanghai,8'),Fd(13,'zh_CN'),Fd(14,4,'sint'),
    Fd(16,0,'float'),Fd(17,0,'float'),Fd(18,0,'float'),Fd(19,0,'float'),Fd(20,0,'float'),Fd(21,0,'float'),
    Fd(22,who.os_version),Fd(23,41,'sint'),Fd(24,36,'sint'),Fd(25,processStarted,'sint'),Fd(26,processStarted,'sint'),Fd(27,processStarted,'sint'),Fd(28,Date.now(),'sint'),
    Fd(29,-1,'sint'),Fd(30,type),Fd(31,brand),Fd(32,type),Fd(33,type),Fd(34,brand),Fd(35,brand),Fd(36,brand),Fd(38,31,'sint'));
  const env = proto(
    Fd(1,envLaunch,'sint'),Fd(2,247235599,'sint'),Fd(3,247235596,'sint'),Fd(5,7,'sint'),Fd(6,'v04.10.03.04-bugfix'),Fd(7,envPid,'sint'),
    Fd(8,who.channel),Fd(12,deviceInfo),Fd(13,proto(Fd(1,ts,'sint'),Fd(2,-2,'sint'),Fd(4,200,'sint'))),Fd(14,version));
  const message = proto(
    Fd(1,V5.magic),Fd(2,5,'sint'),Fd(3,(rnd()>>>0),'sint'),Fd(4,'8662'),Fd(5,who.device_id),Fd(6,V5.license),
    Fd(7,version),Fd(8,'v04.10.03-ml-android'),Fd(9,0x040a0300,'sint'),Fd(10,flags),Fd(12,ts,'sint'),Fd(13,f13),Fd(14,query.subarray(0,6)),
    Fd(15,proto(Fd(1,305,'sint'),Fd(2,4,'sint'),Fd(3,694367,'sint'),Fd(5,1621072674,'sint'))),Fd(16,deviceToken),
    Fd(17,ts,'sint'),Fd(20,'none'),Fd(21,V5.field21,'sint'),Fd(23,env),
    Fd(24,'{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}'));
  const nonce = rnd();
  const hash = sm3(Buffer.concat([V5.signKey, le32(nonce), V5.signKey]));
  const high = (nonce >>> 16) & 255;
  const seed = le32((~(((high << 11) | (nonce >>> 24)) ^ (high >>> 5) ^ high)) | 0);
  const transformed = Buffer.from(Buffer.concat([flags, xmxor(message, hash)])).reverse();
  for (let i = 0; i < transformed.length; i++) transformed[i] ^= seed[(~i) & 3];
  const check = (0x18000001 | ((u(query[0]) & 63) << 14) | ((u(f13[0]) & 63) << 8)) | 0;
  const packed = Buffer.concat([Buffer.from([0xca]), le32(rnd()), le32(check), transformed, Buffer.from([(nonce >>> 16) & 255, (nonce >>> 24) & 255])]);
  const encrypted = aesV3Encrypt(md5(V5.signKey.subarray(0,16)), ts, packed, md5(V5.signKey.subarray(16,32)));
  const prefix = Buffer.concat([le32(5), V5.magic]);
  for (let i = 0; i < prefix.length; i++) prefix[i] ^= le32(ts)[i & 3];
  return Buffer.concat([prefix, Buffer.from([nonce & 255, (nonce >>> 8) & 255, 0, 1]), encrypted]).toString('base64');
}

const encode = v => encodeURIComponent(String(v)).replace(/%7E/g, '~');
const encodeQuery = pairs => pairs.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');

// Full official-app player query (order is load-bearing for the signature).
function playerQuery(identity) {
  return [
    ['aid','8662'],['app_name','novelread'],['version_code','74532'],['version_name','7.4.5.32'],
    ['update_version_code','74532'],['manifest_version_code','74532'],['os','android'],['ssmix','a'],
    ['channel','update_64'],['device_platform','android'],['device_type','25053RT47C'],['device_brand','Redmi'],
    ['os_version','16'],['os_api','36'],['ac','wifi'],['language','zh'],['host_abi','arm64-v8a'],
    ['iid', String(identity.iid)],['cdid', String(identity.cdid)],['device_id', String(identity.device_id)],
  ];
}

// Sign the mobile v5 player POST. Returns { url, headers } (minimal official set:
// x-khronos / x-helios / x-medusa, plus Content-Type + x-ss-stub for a body).
function signPlayback(base, orderedValues, body) {
  const now = Date.now(); const ts = Math.floor(now / 1000);
  for (let offset = 0; offset <= 1023; offset++) {
    const ticket = now + offset;
    const pairs = [...orderedValues, ['_rticket', String(ticket)]];
    const queryStr = encodeQuery(pairs);
    if (rawBranch(queryStr, body, ts) !== 12) continue;
    const url = `${base}?${queryStr}`;
    const who = Object.fromEntries(pairs);
    const headers = { 'x-khronos': String(ts), 'x-helios': helios(ts), 'x-medusa': medusaV5(url, body, ts, who) };
    if (body) { headers['Content-Type'] = 'application/json; charset=utf-8'; headers['x-ss-stub'] = md5(body).toString('hex').toUpperCase(); }
    return { url, headers };
  }
  throw Object.assign(new Error('無法產生 v5 播放簽章'), { code: 'SIGNING_FAILED' });
}

// Player UA observed for the model request (matches the proven hongguoTV form).
const PLAYER_UA = 'com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)';

module.exports = { signPlayback, playerQuery, medusaV5, helios, hashF13, PLAYER_UA };
