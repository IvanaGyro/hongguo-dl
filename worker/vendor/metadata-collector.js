// SPDX-License-Identifier: GPL-3.0-only
// Faithful player-metadata collector for the v5 Medusa field23 (device_profile)
// and field24 (diagnostics), ported from the reverse-bytedance recovery of
// com.phoenix.read 74532 / libmetasec_ml.so c6831ab2…14fe3
// (analysis/portable/collector_clean.pseudo.txt, diagnostic_model.py,
//  metadata_schema.json, docs/collectors.md).
//
// Status: the STATIC device fields and the COMPUTABLE diagnostics (pd, fkd,
// fl[2:5]) are reproduced byte-exactly against the recovery's known answers.
// The purely-runtime values (un_h = a live ART jmethodID; lp middle addresses;
// f18/f19/f20 = timestamp XOR resolved JNI_OnLoad / TPIDR_EL0; the fl TLS word)
// depend on the real process's ASLR/TLS/time and CANNOT be produced offline —
// they are filled with clearly-marked plausible placeholders. This improves
// faithfulness; it is NOT a verified pass of the server's device attestation.
'use strict';
const crypto = require('node:crypto');

// ---- protobuf-C encoder (sint = ZigZag varint; float = wire-5 LE IEEE754) ----
const zigzag = value => { const n = BigInt(value); return n < 0n ? (-n) * 2n - 1n : n * 2n; };
function varint(value) { let n = BigInt(value); const out = []; while (n > 127n) { out.push(Number((n & 127n) | 128n)); n >>= 7n; } out.push(Number(n)); return Buffer.from(out); }
function protoField(tag, value, type) {
    if (value === undefined || value === null) return Buffer.alloc(0);
    if (type === 'bytes' || type === 'string' || type === 'message') {
        const body = type === 'bytes' ? Buffer.from(value) : type === 'message' ? value : Buffer.from(String(value), 'utf8');
        return Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(body.length), body]);
    }
    if (type === 'float') { const b = Buffer.alloc(4); b.writeFloatLE(Number(value)); return Buffer.concat([varint((BigInt(tag) << 3n) | 5n), b]); }
    return Buffer.concat([varint(BigInt(tag) << 3n), varint(type === 'sint' ? zigzag(value) : value)]);
}
const proto = fields => Buffer.concat(fields.filter(f => f[1] !== undefined && f[1] !== null && f[1] !== '').map(([t, v, ty]) => protoField(t, v, ty || 'string')));

// ---- recovered helpers (verified against reverse-bytedance known answers) ----
function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function f32(x) { const b = Buffer.alloc(4); b.writeFloatLE(x); return b.readFloatLE(0); }
// giB(bytes): float32(signed64(bytes)) then ×float32(1/1024) three times.
function giB(bytes) { let x = f32(Number(bytes)); const inv = f32(1 / 1024); for (let i = 0; i < 3; i++) x = f32(x * inv); return x; }
// Recovered fl[2:5] at SDK-setup completion (initial_lifecycle_markers).
function initialFlMarkers(initTsMs) {
    const ts = BigInt(initTsMs) & ((1n << 64n) - 1n);
    const folded = Number((ts & 0xffffffffn) ^ (ts >> 32n)) >>> 0;
    const sb = Buffer.alloc(4); sb.writeUInt32LE(folded); const swapped = sb.readUInt32BE(0);
    let h = 0x201507 >>> 0; const w = Buffer.alloc(8); w.writeUInt32LE(swapped, 0);
    for (let i = 0; i < 8; i++) { const byte = w[i]; h = i % 2 === 0 ? (h ^ (h << 6) ^ (h >>> 4) ^ byte) >>> 0 : (h ^ (h >>> 7) ^ (~(byte | (h << 12)))) >>> 0; }
    return [folded, swapped, h >>> 0];
}
// tk predicate: the SDK URL-Base64 nonempty-output test (diagnostic_model.py).
function urlBase64HasOutput(raw) {
    raw = Buffer.from(raw).toString('latin1').replace(/-/g, '+').replace(/_/g, '/');
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let pos = 0, count = 0, padding = 0;
    while (pos < raw.length) {
        let spaces = false;
        while (pos < raw.length && raw[pos] === ' ') { spaces = true; pos++; }
        if (pos === raw.length) break;
        const ch = raw[pos];
        if (ch === '\n') { pos++; continue; }
        if (ch === '\r' && raw[pos + 1] === '\n') { pos++; continue; }
        if (spaces) return false;
        if (ch === '=') { if (++padding > 2) return false; }
        else if (!alpha.includes(ch) || padding) return false;
        count++; pos++;
    }
    return count >= 4;
}
const diagnosticTk = securityId => securityId == null ? true : (s => s.length === 0 || urlBase64HasOutput(s))(Buffer.from(String(securityId), 'utf8'));

// ---- field24 diagnostics JSON (order is load-bearing) ----
// uuid/kd: the SDK security uuid + int key (device-bound). pd/fkd computed
// exactly; cmr/cmr2/sts baseline constants; lp/fl partly computed, partly
// runtime placeholders (see header).
function diagnosticsJson({ uuid, kd = 0, tsMs, initTsMs, threadMarker, securityId = null,
    vpn = 0, unHash /*runtime*/, lpSeeds /*runtime*/, allocation = 0x5200d7a0 }) {
    const pd = crc32(Buffer.from(uuid, 'utf8'));
    const fkd = crc32(Buffer.from(crypto.createHash('md5').update(Buffer.concat([Buffer.from(uuid, 'utf8'), Buffer.from(String(kd), 'utf8')])).digest('hex'), 'ascii'));
    const MASK = 0x7943f10b58n;
    const s = lpSeeds || { a: 284n, b: 0xc746cb4an };
    const lp = ['2', String(s.a ^ MASK), String(s.b ^ MASK), String((BigInt(tsMs) & 0xffffffffffffffffn) ^ MASK), String(allocation)].join('|');
    const [m2, m3, m4] = initialFlMarkers(initTsMs);
    const fl = ['0', '0', String(m2), String(m3), String(m4), '0', '0', '0', '0', String(threadMarker >>> 0)].join('|');
    // key order fixed: cmr, cmr2, un_h, vpn, sts, kd, fkd, pd, lp, fl, dyn, do, tk
    return '{' + [
        `"cmr":16777216`, `"cmr2":16777216`, `"un_h":${(unHash >>> 0) || 0}`, `"vpn":${vpn ? 1 : 0}`, `"sts":11`, `"kd":${kd}`,
        `"fkd":${fkd}`, `"pd":${pd}`, `"lp":"${lp}"`, `"fl":"${fl}"`, `"dyn":""`, `"do":0`, `"tk":${diagnosticTk(securityId)}`,
    ].join(',') + '}';
}

// ---- field23 device_profile (recovered schema) ----
// device: { model, brand, board, name, device, manufacturer, hardware,
//           osRelease, timezoneId, rawOffsetHours, locale } + plausible runtime.
function deviceInfoProto({ deviceId, securityId = '!notset!', osRelease = '16',
    timezone = 'Asia/Taipei,8', locale = 'zh_TW', cpuCore = 8, wmSize = 'Physical size: 1280x2772',
    storageTotal = 128 * 1024 ** 3, storageFree = 96 * 1024 ** 3, ramTotal = 8 * 1024 ** 3, ramFree = 3 * 1024 ** 3,
    dataTotal, dataFree, model = '25053RT47C', brand = 'Redmi', board = 'unknown', name = '25053RT47C', deviceName = '25053RT47C',
    manufacturer = 'Xiaomi', hardware = 'qcom', features = 0b10111 /* BT|BLE|GPS|Telephony */,
    brightness = 128, volume = 7, usbConnected = 0, fltkMs, scheduleMs, bootDeltaMs = -1, requestClockMs, initMs }) {
    // f16/f17 = /sdcard total/free; f20/f21 = /data + /sdcard total/free, summed
    // even on a unified filesystem (recovered collector 0x21d36c) => f20 ~= 2*f16.
    const dTot = dataTotal == null ? storageTotal : dataTotal;
    const dFree = dataFree == null ? storageFree : dataFree;
    const total = giB(storageTotal), free = giB(storageFree);
    return proto([
        [1, 1, 'sint'], [2, 2, 'sint'], [3, '8662'], [4, deviceId], [5, securityId], [6, '!noperm!'],
        [7, -888888, 'sint'], [8, 0, 'sint'], [9, -1, 'sint'], [10, -888888, 'sint'], [11, '!notset!'],
        [12, timezone], [13, locale], [14, cpuCore, 'sint'], [15, wmSize],
        [16, total, 'float'], [17, free, 'float'], [18, giB(ramTotal), 'float'], [19, giB(ramFree), 'float'],
        [20, giB(dTot + storageTotal), 'float'], [21, giB(dFree + storageFree), 'float'], [22, osRelease],
        [23, brightness, 'sint'], [24, volume, 'sint'], [25, fltkMs, 'sint'], [26, scheduleMs, 'sint'],
        [27, bootDeltaMs, 'sint'], [28, requestClockMs, 'sint'], [29, usbConnected, 'sint'],
        [30, model], [31, brand], [32, board], [33, name], [34, deviceName], [35, manufacturer], [36, hardware],
        [37, ''], [38, features, 'sint'], [40, initMs, 'sint'],
    ]);
}

// ---- per-process plausible runtime profile (indistinguishable, not "real") ----
// f18/f19/f20, un_h, and the lp middle/last values are live ASLR / TLS / JNI
// quantities unique to a running process. The server never sees them from any
// second source, so it cannot verify them — only reject obvious tells (zero,
// fixed constants, f18==f20). We draw ONE coherent set of plausible AArch64
// addresses per process and feed them through the recovered formulas, so the
// emitted fields are statistically indistinguishable from a real device's while
// staying unverifiable. Deterministic given a seed so one worker stays stable.
function mulberry32(a) {
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0); };
}
function plausibleRuntime(seed = (Math.random() * 2 ** 32) >>> 0) {
    const r = mulberry32(seed >>> 0);
    const addr = () => (r() & 0xfffffff8) >>> 0;                 // 8-aligned low32 of a 64-bit address
    // resolved JNI_OnLoad low32: page-random high bits, but the low 12 bits are
    // the fixed file offset of JNI_OnLoad in libmetasec (SO VA 0x2a5194 => 0x194),
    // so f20^ts carries the real offset a page-random value would not.
    const jniOnLoad = ((r() & 0xfffff000) | 0x194) >>> 0;
    const tpidr = addr();                                       // TPIDR_EL0 thread pointer low32
    const unHash = (addr() | 0x8) >>> 0;                        // ART jmethodID low32 (heap, nonzero)
    const allocation = (0x50000000 | (r() & 0x0ffffff0)) >>> 0; // default; re-rolled per request by the caller
    const jniGap = 16;                                          // |slot61-slot62| gap; fingerprint checksum requires abs==16
    const lpA = BigInt(r() & 0xffff);                           // lp middle seed a (small)
    const lpB = BigInt(addr());                                 // lp middle seed b (32-bit)
    const pid = (r() % 29000) + 1200;                           // plausible getpid() (field23 f7)
    const uptimeMs = (r() % (9 * 86400000)) + 3600000;          // 1h..9d uptime, for the boot-epoch (device_info f27)
    const brightness = (r() % 236) + 20;                        // 20..255, stable per process
    const volume = r() % 16;                                    // 0..15, stable per process
    return { seed: seed >>> 0, jniOnLoad, tpidr, unHash, allocation, jniGap, lpA, lpB, pid, uptimeMs, brightness, volume };
}

// Full field23 device_profile message. With `runtime`, f18/f19/f20 follow the
// recovered formulas over plausible per-process addresses
//   f18 = ts ^ JNI_OnLoad ^ TPIDR_EL0,  f20 = ts ^ JNI_OnLoad,  f19 = ts ^ jni_gap
// so f18 != f20 and neither value XOR-ts is a constant. Without `runtime` the
// legacy fixed-mask placeholder (f18 == f20 == ts^0x2a5194) is kept unchanged.
function deviceProfileProto({ pid = 1234, ssVersionName = '!notset!', ts, info, runtime }) {
    const u32 = n => (n >>> 0);
    const rt = runtime || { jniOnLoad: 0x2a5194, tpidr: 0, jniGap: 0x4628b0 };
    const f18 = (BigInt(u32(ts)) ^ BigInt(rt.jniOnLoad >>> 0) ^ BigInt(rt.tpidr >>> 0)) & 0xffffffffn;
    const f20 = (BigInt(u32(ts)) ^ BigInt(rt.jniOnLoad >>> 0)) & 0xffffffffn;
    const f19 = u32(ts) ^ u32(rt.jniGap >>> 0);
    return proto([
        [6, 'v04.10.03.04-bugfix'], [7, pid, 'sint'], [12, info, 'message'], [14, ssVersionName],
        [15, 2, 'sint'], [18, f18, 'sint'], [19, f19, 'sint'], [20, f20, 'sint'],
    ]);
}

module.exports = { crc32, giB, initialFlMarkers, diagnosticTk, urlBase64HasOutput, diagnosticsJson, deviceInfoProto, deviceProfileProto, plausibleRuntime };
