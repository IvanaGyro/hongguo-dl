// Protocol-compatible Rust implementation of Medusa hashF13's three
// branches. The tables are pinned copies of worker/vendor/app-source.js.
// This is not general-purpose cryptography; do not reuse as SHA/MD5.
use crate::{medusa_get_iv, medusa_sum_md5};

const BRANCH2_SV: [u32; 64] = [
    0xa7aefe20, 0x7149f1d6, 0x47e4ca07, 0xe9b58f67, 0x93b924de, 0xc614d0f5,
    0x38afe0ef, 0xb2bbad73, 0xe24444c3, 0x9d3aec9b, 0xdf7b37e4, 0xd8b16d40,
    0xf8ac31b8, 0x76b9a90b, 0x31d833ee, 0x953fce64, 0x353595a4, 0x4609c13b,
    0x36925008, 0x8c6d0925, 0x5df5c177, 0x1cfbf52b, 0x8a4fa7f0, 0x114ca35e,
    0x8193f984, 0x7a7a8733, 0x316ab4d5, 0x3c20cfc9, 0xa6d84453, 0x3a18500c,
    0x798ec47a, 0x97a76b28, 0x66c4ff96, 0x51716443, 0xdd2fc3b, 0xb5696da7,
    0xbbeb3ac5, 0x5c53d204, 0xd32608ce, 0x7279b9ec, 0xf4188ecf, 0xf7d793db,
    0x332cc491, 0xab76ae15, 0x9bebe727, 0x18a01384, 0x5be9f8a7, 0x5f90a754,
    0x39b663c0, 0x36673c83, 0x7c92f514, 0x9d7d94d7, 0xe2e8d9aa, 0x5f7e9ea9,
    0x7abd4551, 0x569e05da, 0x40a25632, 0x3df5a9a5, 0xbab37d80, 0x454286dc,
    0x3f5d4e78, 0x3d7b75d, 0xb1fe4af7, 0xa5ab26a3, 
];
const BRANCH2_ORDERS: [u8; 320] = [
    0x0f, 0x07, 0x04, 0x00, 0x09, 0x08, 0x03, 0x0a, 0x06, 0x0b, 0x05, 0x0d, 0x0e, 0x01, 0x0c, 0x02,
    0x0f, 0x05, 0x08, 0x0c, 0x00, 0x09, 0x02, 0x01, 0x03, 0x07, 0x0e, 0x06, 0x0b, 0x0a, 0x0d, 0x04,
    0x06, 0x05, 0x00, 0x07, 0x0c, 0x00, 0x0a, 0x04, 0x08, 0x0f, 0x01, 0x0b, 0x0d, 0x09, 0x02, 0x0e,
    0x06, 0x0b, 0x02, 0x05, 0x04, 0x03, 0x08, 0x01, 0x01, 0x07, 0x0a, 0x00, 0x0d, 0x0c, 0x09, 0x0e,
    0x0d, 0x07, 0x0e, 0x0f, 0x0b, 0x02, 0x08, 0x03, 0x0c, 0x05, 0x09, 0x01, 0x00, 0x04, 0x06, 0x0a,
    0x0d, 0x09, 0x02, 0x06, 0x0f, 0x0b, 0x0a, 0x04, 0x08, 0x07, 0x00, 0x0c, 0x05, 0x03, 0x01, 0x0e,
    0x0c, 0x09, 0x0f, 0x07, 0x06, 0x0f, 0x03, 0x0e, 0x02, 0x0d, 0x04, 0x05, 0x01, 0x0b, 0x0a, 0x00,
    0x0c, 0x05, 0x0a, 0x09, 0x0e, 0x08, 0x02, 0x04, 0x04, 0x07, 0x03, 0x0f, 0x01, 0x06, 0x0b, 0x00,
    0x0b, 0x0f, 0x04, 0x08, 0x02, 0x0a, 0x07, 0x00, 0x09, 0x0d, 0x06, 0x01, 0x0e, 0x03, 0x05, 0x0c,
    0x0b, 0x06, 0x0a, 0x05, 0x08, 0x02, 0x0c, 0x03, 0x07, 0x0f, 0x0e, 0x09, 0x0d, 0x00, 0x01, 0x04,
    0x09, 0x06, 0x08, 0x0f, 0x05, 0x08, 0x00, 0x04, 0x0a, 0x0b, 0x03, 0x0d, 0x01, 0x02, 0x0c, 0x0e,
    0x09, 0x0d, 0x0c, 0x06, 0x04, 0x07, 0x0a, 0x03, 0x03, 0x0f, 0x00, 0x08, 0x01, 0x05, 0x02, 0x0e,
    0x01, 0x00, 0x0d, 0x0f, 0x09, 0x0a, 0x0b, 0x0e, 0x04, 0x02, 0x08, 0x07, 0x03, 0x06, 0x0c, 0x05,
    0x01, 0x08, 0x0a, 0x0c, 0x0f, 0x09, 0x05, 0x06, 0x0b, 0x00, 0x03, 0x04, 0x02, 0x0e, 0x07, 0x0d,
    0x04, 0x08, 0x0f, 0x00, 0x0c, 0x0f, 0x0e, 0x0d, 0x0a, 0x01, 0x06, 0x02, 0x07, 0x09, 0x05, 0x03,
    0x04, 0x02, 0x05, 0x08, 0x0d, 0x0b, 0x0a, 0x06, 0x06, 0x00, 0x0e, 0x0f, 0x07, 0x0c, 0x09, 0x03,
    0x0a, 0x08, 0x04, 0x0f, 0x00, 0x0b, 0x01, 0x06, 0x0d, 0x0c, 0x07, 0x09, 0x03, 0x0e, 0x05, 0x02,
    0x0a, 0x07, 0x0b, 0x05, 0x0f, 0x00, 0x02, 0x0e, 0x01, 0x08, 0x03, 0x0d, 0x0c, 0x06, 0x09, 0x04,
    0x0d, 0x07, 0x0f, 0x08, 0x05, 0x0f, 0x06, 0x04, 0x0b, 0x0a, 0x0e, 0x0c, 0x09, 0x00, 0x02, 0x03,
    0x0d, 0x0c, 0x02, 0x07, 0x04, 0x01, 0x0b, 0x0e, 0x0e, 0x08, 0x06, 0x0f, 0x09, 0x05, 0x00, 0x03,

];
const BRANCH0_TT: [u32; 64] = [
    0xebb64faf, 0x7aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be,
    0xb41ad638, 0x34180eb8, 0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51,
    0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288, 0x2c077f0a, 0xda0dcad0,
    0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
    0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6,
    0x736f8650, 0x6560306c, 0x617ce2a6, 0xe423417e, 0xa40e143, 0x544e4032,
    0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x5b23bb3, 0xe1d0b866, 0xbaa3dcb8,
    0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
    0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2,
    0xab0b3b86, 0x3d5dfb14, 0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1,
    0x6ca86f6e, 0x284ba7, 0x8387cfa, 0x5fb37586, 
];
const BRANCH0_IV1: [u32; 6] = [
    0xc4a78580, 0xb3c0fd39, 0xc58c5686, 0xc9aa3ba7, 0xf5a7adf2, 0x963c2ed1,

];
const BRANCH0_CHOSEN: [[usize; 11]; 6] = [
    [101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3],
    [96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4],
    [96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5],
    [99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6],
    [96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4],
    [100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5]
];

#[inline]
fn word_le(data: &[u8]) -> u32 { u32::from_le_bytes(data.try_into().unwrap()) }
#[inline]
fn word_be(data: &[u8]) -> u32 { u32::from_be_bytes(data.try_into().unwrap()) }

fn md5_v3_step(kind: usize, a: u32, b: u32, c: u32, d: u32,
               m: u32, shift: u32, constant: u32) -> u32 {
    let f = match kind {
        0 => (b & c) | ((!b) & d),
        1 => (b & d) | (c & (!d)),
        2 => b ^ c ^ d,
        _ => c ^ (b | (!d)),
    };
    b.wrapping_add(a.wrapping_add(f).wrapping_add(m).wrapping_add(constant).rotate_left(shift))
}

fn branch2(iv: u32, query: &[u8; 32], body: &[u8; 16], ts: &[u8; 4], khronos: u32) -> Vec<u8> {
    let v = (iv & 13) * 86;
    let index = (((v >> 15) & 255) + ((v >> 8) & 255)) as usize;
    let n1: u32 = [0x8980f29b, 0xeb549c7f, 0xb08726db, 0xd40cb5e6, 0xe8f559e4][index];
    let count_v1 = n1.wrapping_add(khronos).wrapping_add(1) & 255;
    let count_v2 = n1.wrapping_add(khronos);
    let shift = count_v2.wrapping_add(5) & 7;
    let seed = [0x84u32, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8];
    let mut message = [0u8; 64];
    message[..32].copy_from_slice(query);
    message[32..48].copy_from_slice(body);
    message[48..52].copy_from_slice(ts);
    for i in 0..8 {
        message[52 + i] = ((seed[i] | (seed[i] << 8)) >> shift) as u8;
    }
    message[60..64].copy_from_slice(&[0xa0, 0x01, 0, 0]);
    let m: [u32; 16] = std::array::from_fn(|i| word_le(&message[i * 4..i * 4 + 4]));
    let sv: [u32; 64] = BRANCH2_SV.map(|x| x.rotate_right(count_v1));
    let start: [u32; 4] = [0x79e0f2fb, 0xc8b52570, 0xebc2f8cd, 0x7c104d93]
        .map(|x: u32| x.rotate_right(count_v2));
    let end_count = count_v2.wrapping_add(6) & 255;
    let end: [u32; 4] = [0x19be4866, 0xe85986b4, 0xe19b326e, 0x71d1d7d4]
        .map(|x: u32| x.rotate_right(end_count));
    let orders = &BRANCH2_ORDERS[index * 64..index * 64 + 64];
    let shifts = [
        [7u32, 12, 17, 22],
        [5, 9, 14, 20],
        [4, 11, 16, 23],
        [6, 10, 15, 21],
    ];
    let (mut a, mut b, mut c, mut d) = (start[0], start[1], start[2], start[3]);
    for kind in 0..4 {
        for i in 0..16 {
            let offset = kind * 16 + i;
            let word = m[orders[offset] as usize];
            let shift = shifts[kind][i & 3];
            let val = sv[offset];
            match i & 3 {
                0 => a = md5_v3_step(kind, a, b, c, d, word, shift, val),
                1 => d = md5_v3_step(kind, d, a, b, c, word, shift, val),
                2 => c = md5_v3_step(kind, c, d, a, b, word, shift, val),
                _ => b = md5_v3_step(kind, b, c, d, a, word, shift, val),
            }
        }
    }
    let updated = [a, b, c, d];
    let mut out = Vec::with_capacity(20);
    for i in 0..4 {
        out.extend_from_slice(&(start[i].wrapping_add(updated[i]) ^ end[i]).to_le_bytes());
    }
    out.extend_from_slice(&medusa_sum_md5(&out).unwrap().to_le_bytes());
    out
}

fn branch0(iv: u32, query: &[u8; 32], body: &[u8; 16], ts: &[u8; 4], khronos: u32) -> Vec<u8> {
    let low = iv & 15;
    let index = ((low * 171) >> 9) as usize;
    let iv1 = BRANCH0_IV1[index];
    let count_v1 = iv1.wrapping_add(khronos).wrapping_add(1) & 255;
    let count_v2 = iv1.wrapping_add(khronos);
    let tt: [u32; 64] = BRANCH0_TT.map(|value| value.rotate_right(count_v1));
    let shift = count_v2.wrapping_add(2) & 7;
    let seed = [0xfau32, 0x45, 0x61, 0xd7];
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(query);
    data[32..48].copy_from_slice(body);
    data[48..52].copy_from_slice(ts);
    for i in 0..4 {
        data[52 + i] = ((seed[i] | (seed[i] << 8)) >> shift) as u8;
    }
    data[56..64].copy_from_slice(&[0, 0, 0, 0, 0, 0, 1, 0xa0]);
    let mut di = [0u32; 128];
    for i in 0..16 {
        di[i] = word_be(&data[i * 4..i * 4 + 4]);
    }
    let mut di0 = di[0];
    for i in 0..112 {
        let di1 = di[i + 1];
        let di14 = di[i + 14];
        let r1 = di1.rotate_left(14) ^ di1.rotate_left(25) ^ (di1 >> 3);
        let r2 = di14.rotate_left(13) ^ di14.rotate_left(15) ^ (di14 >> 10);
        di[16 + i] = di0.wrapping_add(di[i + 9]).wrapping_add(r1).wrapping_add(r2);
        di0 = di1;
    }
    let init: [u32; 8] = [
        0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f,
        984304912, 3005047866, 2874125293, 2152413264,
    ].map(|value: u32| value.rotate_right(count_v2 & 31));
    let chosen = BRANCH0_CHOSEN[index];
    let mut d = init;
    for i in 0..chosen[0] {
        let base = iv1.wrapping_add(i as u32);
        let n0 = di[(base & 127) as usize];
        let n1 = ((d[chosen[3]] ^ d[chosen[4]]) & d[chosen[1]]) ^ d[chosen[3]];
        let n2 = d[chosen[1]].rotate_left(26) ^ d[chosen[1]].rotate_left(21)
            ^ d[chosen[1]].rotate_left(7);
        let n4 = n0.wrapping_add(n1).wrapping_add(n2)
            .wrapping_add(tt[(base & 63) as usize]).wrapping_add(d[chosen[5]]);
        let n5 = d[chosen[2]].rotate_left(30) ^ d[chosen[2]].rotate_left(19)
            ^ d[chosen[2]].rotate_left(10);
        let n6 = (d[chosen[2]] & d[chosen[6]])
            | ((d[chosen[2]] | d[chosen[6]]) & d[chosen[7]]);
        let n7 = n5.wrapping_add(n6);
        let old = d[chosen[9]];
        d.rotate_right(1);
        d[chosen[10]] = n7.wrapping_add(n4);
        d[chosen[8]] = old.wrapping_add(n4);
    }
    let mut digest = [0u8; 32];
    for i in 0..8 {
        digest[i * 4..i * 4 + 4].copy_from_slice(&d[i].wrapping_add(init[i]).to_be_bytes());
    }
    let mut folded = [0u8; 16];
    for i in 0..16 {
        folded[i] = digest[i] ^ digest[i + 16];
    }
    let mut result = folded.to_vec();
    result.extend_from_slice(&medusa_sum_md5(&folded).unwrap().to_le_bytes());
    result
}

/// HashF13 combines a 32-byte query SM3, a 16-byte body MD5, and a 32-bit
/// little-endian timestamp. Depending on the selector it returns 20 or 36 bytes.
pub fn medusa_hash_f13(query: &[u8; 32], body: &[u8; 16], ts: &[u8; 4], khronos: u32) -> Vec<u8> {
    let iv = medusa_get_iv(
        medusa_get_iv(medusa_get_iv(0x20230928, query), body), ts);
    let low = iv & 15;
    let branch = low - (((low * 171) >> 9) * 3);
    match branch {
        0 => branch0(iv, query, body, ts, khronos),
        2 => branch2(iv, query, body, ts, khronos),
        _ => {
            let mut out = Vec::with_capacity(36);
            out.extend_from_slice(&query[..16]);
            out.extend_from_slice(body);
            let mut source = Vec::with_capacity(48);
            source.extend_from_slice(query);
            source.extend_from_slice(body);
            out.extend_from_slice(&medusa_sum_md5(&source).unwrap().to_le_bytes());
            out
        }
    }
}

