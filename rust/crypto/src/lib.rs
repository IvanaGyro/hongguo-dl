//! SM3 (GB/T 32905) implemented in Rust, without JS crypto or dependencies.
//! This low-level ABI targets wasm32-unknown-unknown and is also natively testable.
//! Pointer-based exports are only called from our trusted JS Worker bridge.

const INITIAL_STATE: [u32; 8] = [
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
    0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

pub fn sm3(input: &[u8]) -> [u8; 32] {
    let mut padded = Vec::with_capacity((input.len() + 72) & !63);
    padded.extend_from_slice(input);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&(input.len() as u64).wrapping_mul(8).to_be_bytes());

    let mut state = INITIAL_STATE;
    for block in padded.chunks_exact(64) {
        let mut words = [0u32; 68];
        for (i, chunk) in block.chunks_exact(4).enumerate() {
            words[i] = u32::from_be_bytes(chunk.try_into().expect("4-byte word"));
        }
        for i in 16..68 {
            let x = words[i - 16] ^ words[i - 9] ^ words[i - 3].rotate_left(15);
            words[i] = x ^ x.rotate_left(15) ^ x.rotate_left(23)
                ^ words[i - 13].rotate_left(7) ^ words[i - 6];
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0u32..64 {
            let t = if i < 16 { 0x79cc4519_u32 } else { 0x7a879d8a_u32 };
            let a12 = a.rotate_left(12);
            let s1 = a12.wrapping_add(e).wrapping_add(t.rotate_left(i)).rotate_left(7);
            let s2 = s1 ^ a12;
            let ff = if i < 16 { a ^ b ^ c } else { (a & b) | (a & c) | (b & c) };
            let gg = if i < 16 { e ^ f ^ g } else { (e & f) | (!e & g) };
            let j = i as usize;
            let t1 = ff.wrapping_add(d).wrapping_add(s2)
                .wrapping_add(words[j] ^ words[j + 4]);
            let t2 = gg.wrapping_add(h).wrapping_add(s1).wrapping_add(words[j]);
            d = c;
            c = b.rotate_left(9);
            b = a;
            a = t1;
            h = g;
            g = f.rotate_left(19);
            f = e;
            e = t2 ^ t2.rotate_left(9) ^ t2.rotate_left(17);
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s ^= v;
        }
    }

    let mut output = [0u8; 32];
    for (i, value) in state.iter().enumerate() {
        output[i * 4..i * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    output
}

#[no_mangle]
pub extern "C" fn rust_alloc(len: usize) -> *mut u8 {
    use std::alloc::{alloc, Layout};
    let Some(layout) = Layout::array::<u8>(len.max(1)).ok() else {
        return std::ptr::null_mut();
    };
    // JS must call rust_dealloc on every pointer, even when a later call fails.
    unsafe { alloc(layout) }
}

#[no_mangle]
pub unsafe extern "C" fn rust_dealloc(ptr: *mut u8, len: usize) {
    use std::alloc::{dealloc, Layout};
    if ptr.is_null() { return; }
    if let Ok(layout) = Layout::array::<u8>(len.max(1)) {
        dealloc(ptr, layout);
    }
}

/// # Safety
/// Both pointers must address valid wasm linear memory; destination must have
/// at least 32 writable bytes. The Worker wrapper enforces these conditions.
#[no_mangle]
pub unsafe extern "C" fn rust_sm3(input: *const u8, len: usize, output: *mut u8) -> u32 {
    if input.is_null() || output.is_null() { return 1; }
    let data = std::slice::from_raw_parts(input, len);
    std::ptr::copy_nonoverlapping(sm3(data).as_ptr(), output, 32);
    0
}


// The 551 Argus signing cipher uses a Simon-like 72-round permutation.
// Keys and blocks are little-endian, matching the upstream JS implementation.
// This is protocol compatibility logic, not a general-purpose authenticated cipher.
pub fn simon_encrypt_blocks(key: &[u8; 32], plaintext: &[u8]) -> Option<Vec<u8>> {
    if plaintext.len() % 16 != 0 { return None; }
    let mut expanded = [0u64; 72];
    for (i, part) in key.chunks_exact(8).enumerate() {
        expanded[i] = u64::from_le_bytes(part.try_into().unwrap());
    }
    const Z: u64 = 0x3dc94c3a046d678b;
    for i in 4..72 {
        let mut tmp = expanded[i - 1].rotate_right(3) ^ expanded[i - 3];
        tmp ^= tmp.rotate_right(1);
        let bit = (Z >> ((i - 4) % 62)) & 1;
        expanded[i] = !expanded[i - 4] ^ tmp ^ bit ^ 3;
    }
    let mut output = Vec::with_capacity(plaintext.len());
    for block in plaintext.chunks_exact(16) {
        let mut x = u64::from_le_bytes(block[..8].try_into().unwrap());
        let mut y = u64::from_le_bytes(block[8..16].try_into().unwrap());
        for &round_key in &expanded {
            let next_y = x ^ (y.rotate_left(1) & y.rotate_left(8))
                ^ y.rotate_left(2) ^ round_key;
            x = y;
            y = next_y;
        }
        output.extend_from_slice(&x.to_le_bytes());
        output.extend_from_slice(&y.to_le_bytes());
    }
    Some(output)
}

// Ladon 551 block transform. JS still derives the MD5 and formats the
// parameters; all 64-bit key expansion and 34 encryption rounds run in Rust.
pub fn ladon_transform(md5_ascii: &[u8; 32], plaintext: &[u8]) -> Option<Vec<u8>> {
    if plaintext.len() % 16 != 0 { return None; }
    let mut words = [0u64; 4];
    for (i, chunk) in md5_ascii.chunks_exact(8).enumerate() {
        words[i] = u64::from_le_bytes(chunk.try_into().unwrap());
    }
    let mut table = [0u64; 35];
    table[0] = words[0];
    let mut queue = std::collections::VecDeque::from([words[2], words[3]]);
    let (mut b0, mut b8) = (words[0], words[1]);
    for i in 0..34 {
        let mut x8 = b8.rotate_right(8).wrapping_add(b0) ^ (i as u64);
        queue.push_back(x8);
        x8 ^= b0.rotate_left(3);
        table[i + 1] = x8;
        b0 = x8;
        b8 = queue.pop_front().expect("Ladon queue always has elements");
    }
    let mut output = Vec::with_capacity(plaintext.len());
    for block in plaintext.chunks_exact(16) {
        let mut a = u64::from_le_bytes(block[..8].try_into().unwrap());
        let mut b = u64::from_le_bytes(block[8..16].try_into().unwrap());
        for &round_key in table.iter().take(34) {
            b = round_key ^ a.wrapping_add(b.rotate_right(8));
            a = b ^ a.rotate_left(3);
        }
        output.extend_from_slice(&a.to_le_bytes());
        output.extend_from_slice(&b.to_le_bytes());
    }
    Some(output)
}

/// # Safety
/// JS must allocate valid, disjoint WebAssembly memory for each input and
/// output pointer. The output buffer must have capacity for len bytes.
#[no_mangle]
pub unsafe extern "C" fn rust_simon_encrypt(
    key_ptr: *const u8, input_ptr: *const u8, len: usize, output_ptr: *mut u8,
) -> u32 {
    if key_ptr.is_null() || input_ptr.is_null() || output_ptr.is_null()
        || len % 16 != 0 || len > 16 * 1024 * 1024 { return 1; }
    let key: &[u8; 32] = &*(key_ptr as *const [u8; 32]);
    let input = std::slice::from_raw_parts(input_ptr, len);
    let Some(encrypted) = simon_encrypt_blocks(key, input) else { return 2; };
    std::ptr::copy_nonoverlapping(encrypted.as_ptr(), output_ptr, len);
    0
}

/// # Safety
/// JS must supply a valid 32-byte MD5-hex ASCII digest and disjoint,
/// allocated plaintext/output buffers of exactly len bytes.
#[no_mangle]
pub unsafe extern "C" fn rust_ladon_transform(
    digest_ptr: *const u8, input_ptr: *const u8, len: usize, output_ptr: *mut u8,
) -> u32 {
    if digest_ptr.is_null() || input_ptr.is_null() || output_ptr.is_null()
        || len % 16 != 0 || len > 16 * 1024 * 1024 { return 1; }
    let digest: &[u8; 32] = &*(digest_ptr as *const [u8; 32]);
    let input = std::slice::from_raw_parts(input_ptr, len);
    let Some(encrypted) = ladon_transform(digest, input) else { return 2; };
    std::ptr::copy_nonoverlapping(encrypted.as_ptr(), output_ptr, len);
    0
}


// Gorgon legacy signing mixer. The peculiar state update (s[i] = s[j],
// without swapping s[j]) is protocol-defined and must not be "fixed"
// to conventional RC4. Includes the dependent reverse-bit finishing pass.
pub fn gorgon_transform(input: &[u8; 20], random: u16) -> [u8; 20] {
    let key = [
        0x4a, 0x40, 0x16, (random >> 8) as u8,
        0x47, 0x6c, 0x01, random as u8,
    ];
    let mut state = std::array::from_fn::<_, 256, _>(|i| i as u8);
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(state[i]).wrapping_add(key[i % 8]);
        state[i] = state[j as usize];
    }
    let mut output = *input;
    j = 0;
    for (index, value) in output.iter_mut().enumerate() {
        let i = index + 1;
        let x = state[i];
        j = j.wrapping_add(x);
        let y = state[j as usize];
        state[i] = y;
        *value ^= state[y.wrapping_add(y) as usize];
    }
    for i in 0..20 {
        let value = output[i].rotate_left(4);
        let next = if i + 1 < 20 { output[i + 1] } else { output[0] };
        output[i] = !((next ^ value).reverse_bits() ^ 20);
    }
    output
}

/// # Safety
/// Input and output point to separate valid 20-byte buffers in wasm memory.
#[no_mangle]
pub unsafe extern "C" fn rust_gorgon_transform(
    input_ptr: *const u8, random: u32, output_ptr: *mut u8,
) -> u32 {
    if input_ptr.is_null() || output_ptr.is_null() || random > 65535 { return 1; }
    let input: &[u8; 20] = &*(input_ptr as *const [u8; 20]);
    let out = gorgon_transform(input, random as u16);
    std::ptr::copy_nonoverlapping(out.as_ptr(), output_ptr, 20);
    0
}


// Medusa XM-XOR byte permutation. This deliberately preserves the vendor's
// unusual reverse-order write and dependent post-mixing, with u8 wrapping
// arithmetic equivalent to the JavaScript bitwise operations.
pub fn medusa_xmxor(data: &[u8], key: &[u8; 32]) -> Option<Vec<u8>> {
    if data.len() < 5 { return None; }
    let n = data.len();
    let mut encoded = vec![0u8; n];
    for (i, &value) in data.iter().enumerate() {
        let at = (i * 4) & 28;
        let d0 = key[at];
        let d1 = key[at + 1];
        let mut d2 = value.rotate_left(4).wrapping_add(d0);
        d2 = !d2 ^ d1;
        d2 = d2.rotate_left(3);
        d2 = d2.wrapping_add(d1) ^ d0;
        encoded[n - i - 1] = !d2;
    }
    let last = encoded[n - 1] ^ encoded[n - 2];
    let first = encoded[0];
    encoded[0] = (!last).wrapping_add(first);
    encoded[1] = (encoded[0] ^ encoded[n - 1] ^ 254).wrapping_add(encoded[1]);
    encoded[2] = encoded[2].wrapping_add(
        last.wrapping_sub(first) ^ encoded[1].rotate_left(3) ^ 2
    );
    for i in 0..n - 4 {
        let temp = encoded[i + 2].rotate_left(3) ^ encoded[i + 1] ^ ((i + 3) as u8);
        encoded[i + 3] = (!temp).wrapping_add(encoded[i + 3]);
    }
    encoded[n - 1] ^= encoded[n - 2];
    let mut sum = 0u8;
    for i in 0..n - 1 {
        sum = sum.wrapping_add(encoded[i + 1]);
    }
    encoded[0] = (encoded[0] ^ encoded[1]).wrapping_add(sum);
    Some(encoded)
}

/// # Safety
/// All pointers must address correctly sized, disjoint, allocated Wasm memory.
/// key_ptr points to 32 bytes; data_ptr/out_ptr each point to len bytes.
#[no_mangle]
pub unsafe extern "C" fn rust_medusa_xmxor(
    key_ptr: *const u8, data_ptr: *const u8, len: usize, output_ptr: *mut u8,
) -> u32 {
    if key_ptr.is_null() || data_ptr.is_null() || output_ptr.is_null()
        || !(5..=16 * 1024 * 1024).contains(&len) { return 1; }
    let key: &[u8; 32] = &*(key_ptr as *const [u8; 32]);
    let data = std::slice::from_raw_parts(data_ptr, len);
    let Some(encoded) = medusa_xmxor(data, key) else { return 2; };
    std::ptr::copy_nonoverlapping(encoded.as_ptr(), output_ptr, len);
    0
}


// Medusa AES-V3 is a vendor-specific transform, NOT AES-128-CBC. The SDK
// dynamically selects a 256-byte S-box and changes row/column permutations
// according to khronos & 3. The caller provides that selected S-box.
const MEDUSA_CON2: [[usize; 4]; 4] = [
    [1, 0, 2, 3], [2, 0, 3, 1], [0, 1, 3, 2], [1, 0, 2, 3],
];
const MEDUSA_ORDER: [[usize; 16]; 4] = [
    [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
    [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
    [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
    [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
];
const MEDUSA_INIT: [u32; 4] = [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f];

fn medusa_aes_v3_round_keys(box_values: &[u8; 256], key: &[u8; 16], variant: usize) -> [[u8; 4]; 12] {
    let init = MEDUSA_INIT[variant];
    let mut expanded = [0u8; 48];
    for i in 0..4 {
        for j in 0..4 {
            expanded[i * 4 + j] = init.to_le_bytes()[j] ^ key[i * 4 + j];
        }
    }
    let mut rounds = 8u32;
    for i in 4..12 {
        let at = 4 * (i - 1);
        let (mut a, mut b, mut c, mut d) = (
            expanded[at], expanded[at + 1], expanded[at + 2], expanded[at + 3]
        );
        if i & 3 == 0 {
            // JS >> is a sign-preserving 32-bit shift, but only the low byte
            // participates in this key-expansion expression.
            let shifted = ((init as i32) >> (rounds & 24)) as u8;
            let t = shifted ^ box_values[b as usize];
            b = box_values[c as usize];
            c = box_values[d as usize];
            d = box_values[a as usize];
            a = t;
        }
        rounds += 2;
        expanded[at + 4] = a ^ expanded[at - 12];
        expanded[at + 5] = b ^ expanded[at - 11];
        expanded[at + 6] = c ^ expanded[at - 10];
        expanded[at + 7] = d ^ expanded[at - 9];
    }
    std::array::from_fn(|i| expanded[i * 4..i * 4 + 4].try_into().unwrap())
}

fn medusa_aes_v3_block(
    mut rows: [u8; 16], box_values: &[u8; 256],
    keys: &[[u8; 4]; 12], variant: usize,
) -> [u8; 16] {
    let con = MEDUSA_CON2[variant];
    // addCon(rows, keys.slice(0,4))
    for i in 0..4 {
        for j in 0..4 {
            rows[i * 4 + j] ^= keys[i][con[j]];
        }
    }
    for round in 1..3 {
        // sub: substitute the bytes, then permute rows
        let prev = rows.map(|b| box_values[b as usize]);
        for i in 0..4 {
            rows[i * 4..i * 4 + 4].copy_from_slice(&prev[con[i] * 4..con[i] * 4 + 4]);
        }
        // shift rows using the vendor's 16-element index map
        let old = rows;
        for i in 0..16 {
            rows[i] = old[MEDUSA_ORDER[variant][i]];
        }
        if round == 1 {
            // shiftCon: permute columns within each row.
            let old = rows;
            for i in 0..4 {
                for j in 0..4 {
                    rows[i * 4 + j] = old[i * 4 + con[j]];
                }
            }
            // vendor AES-like column mixing
            for j in 0..4 {
                let t = rows[j] ^ rows[4 + j] ^ rows[8 + j] ^ rows[12 + j];
                let u = rows[j];
                let xt = |x: u8| (x << 1) ^ if x & 0x80 != 0 { 0x1b } else { 0 };
                let a = rows[j];
                let b = rows[4 + j];
                let c = rows[8 + j];
                let d = rows[12 + j];
                rows[j] ^= t ^ xt(a ^ b);
                rows[4 + j] ^= t ^ xt(b ^ c);
                rows[8 + j] ^= t ^ xt(c ^ d);
                rows[12 + j] ^= t ^ xt(d ^ u);
            }
        }
        // addCon(rows, keys.slice(round*4))
        for i in 0..4 {
            for j in 0..4 {
                rows[i * 4 + j] ^= keys[round * 4 + i][con[j]];
            }
        }
    }
    // add(rows, keys.slice(4)) -- exact vendor operation, not round 3.
    for i in 0..4 {
        for j in 0..4 {
            rows[i * 4 + j] ^= keys[i + 4][j];
        }
    }
    rows
}

/// Produces the vendor's 1-byte prefix followed by the input with modified
/// bit positions. Requires 31 complete 8-byte source groups (248 bytes).
pub fn medusa_aes_v3_encrypt(
    source: &[u8], box_values: &[u8; 256], key: &[u8; 16],
    iv: &[u8; 16], khronos: u32,
) -> Option<Vec<u8>> {
    if source.len() < 248 { return None; }
    let variant = (khronos & 3) as usize;
    let keys = medusa_aes_v3_round_keys(box_values, key, variant);
    let mut plain = [0u8; 32];
    for i in 0..31 {
        let at = i * 8;
        plain[i] = ((source[at] >> 4) & 2)
            | (source[at + 1] & 64)
            | ((source[at + 2] >> 2) & 1)
            | ((source[at + 3] << 3) & 128)
            | ((source[at + 4] >> 1) & 4)
            | ((source[at + 5] << 3) & 16)
            | ((source[at + 6] << 5) & 32)
            | ((source[at + 7] >> 4) & 8);
    }
    plain[31] = 1;
    let mut expanded_key = [0u8; 32];
    let mut previous = *iv;
    for i in 0..2 {
        let block = std::array::from_fn(|j| plain[i * 16 + j] ^ previous[j]);
        let next = medusa_aes_v3_block(block, box_values, &keys, variant);
        expanded_key[i * 16..(i + 1) * 16].copy_from_slice(&next);
        previous = next;
    }
    let mut out = Vec::with_capacity(source.len() + 1);
    out.push(expanded_key[31]);
    out.extend_from_slice(source);
    for (i, &k) in expanded_key.iter().enumerate().take(31) {
        let at = 1 + i * 8;
        out[at] = (out[at] & !0x20) | ((k << 4) & 0x20);
        out[at + 1] = (out[at + 1] & !0x40) | (k & 0x40);
        out[at + 2] = (out[at + 2] & !0x04) | ((k << 2) & 0x04);
        out[at + 3] = (out[at + 3] & !0x10) | ((k >> 3) & 0x10);
        out[at + 4] = (out[at + 4] & !0x08) | (k.wrapping_add(k) & 0x08);
        out[at + 5] = (out[at + 5] & !0x02) | ((k >> 3) & 0x02);
        out[at + 6] = (out[at + 6] & !0x01) | ((k >> 5) & 0x01);
        out[at + 7] = (out[at + 7] & !0x80) | ((k << 4) & 0x80);
    }
    Some(out)
}

/// # Safety
/// box_ptr, key_ptr, iv_ptr point to 256, 16 and 16 valid bytes.
/// data_ptr points to len bytes, out_ptr points to at least len + 1 writable
/// bytes in disjoint wasm allocations.
#[no_mangle]
pub unsafe extern "C" fn rust_medusa_aes_v3(
    box_ptr: *const u8, key_ptr: *const u8, iv_ptr: *const u8, khronos: u32,
    data_ptr: *const u8, len: usize, out_ptr: *mut u8,
) -> u32 {
    if box_ptr.is_null() || key_ptr.is_null() || iv_ptr.is_null()
        || data_ptr.is_null() || out_ptr.is_null()
        || !(248..=16 * 1024 * 1024).contains(&len) { return 1; }
    let box_values: &[u8; 256] = &*(box_ptr as *const [u8; 256]);
    let key: &[u8; 16] = &*(key_ptr as *const [u8; 16]);
    let iv: &[u8; 16] = &*(iv_ptr as *const [u8; 16]);
    let data = std::slice::from_raw_parts(data_ptr, len);
    let Some(encrypted) = medusa_aes_v3_encrypt(data, box_values, key, iv, khronos)
    else { return 2; };
    std::ptr::copy_nonoverlapping(encrypted.as_ptr(), out_ptr, len + 1);
    0
}


// Medusa selector/init checksums. Integer shifts and overflow match
// JavaScript's unsigned 32-bit bitwise operations exactly.
pub fn medusa_get_iv(mut iv: u32, data: &[u8]) -> u32 {
    for (i, &byte) in data.iter().enumerate() {
        if i & 1 == 0 {
            iv = (iv >> 4) ^ iv ^ (iv << 6) ^ byte as u32;
        } else {
            iv = !((iv >> 7) ^ iv ^ (byte as u32 | (iv << 12)));
        }
    }
    iv
}

pub fn medusa_sum_md5(data: &[u8]) -> Option<u32> {
    if data.len() < 12 { return None; }
    let mut check = 0x20220420u32;
    for (i, &byte) in data.iter().take(12).enumerate() {
        let temp = if i & 1 == 0 { (check >> 3) ^ check }
                   else { (check >> 5) ^ check };
        check = if i & 1 == 0 { (byte as u32) ^ (check << 7) }
                else { (byte as u32) | (check << 11) };
        if i & 1 != 0 { check = !check; }
        check ^= temp;
    }
    Some((check | 4) ^ 0x01000000)
}

/// # Safety
/// data_ptr must be valid for len bytes, even when len is zero (JS always
/// allocates a non-null buffer). Returns the unsigned 32-bit selector.
#[no_mangle]
pub unsafe extern "C" fn rust_medusa_get_iv(
    iv: u32, data_ptr: *const u8, len: usize,
) -> u32 {
    if data_ptr.is_null() || len > 16 * 1024 * 1024 { return 0; }
    medusa_get_iv(iv, std::slice::from_raw_parts(data_ptr, len))
}

/// # Safety
/// data_ptr must be valid for at least 12 bytes of WASM linear memory.
#[no_mangle]
pub unsafe extern "C" fn rust_medusa_sum_md5(data_ptr: *const u8, len: usize) -> u32 {
    if data_ptr.is_null() || !(12..=16 * 1024 * 1024).contains(&len) { return 0; }
    medusa_sum_md5(std::slice::from_raw_parts(data_ptr, len)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn simon_matches_external_golden_vector() {
        let key: [u64; 4] = [
            1111111111111111111, 2222222222222222222,
            3333333333333333333, 4444444444444444444,
        ];
        let mut key_bytes = [0u8; 32];
        for (i, word) in key.iter().enumerate() {
            key_bytes[i * 8..i * 8 + 8].copy_from_slice(&word.to_le_bytes());
        }
        let mut block = Vec::new();
        block.extend_from_slice(&1234567890123456789u64.to_le_bytes());
        block.extend_from_slice(&9876543210987654321u64.to_le_bytes());
        let output = simon_encrypt_blocks(&key_bytes, &block).unwrap();
        let left = u64::from_le_bytes(output[0..8].try_into().unwrap());
        let right = u64::from_le_bytes(output[8..16].try_into().unwrap());
        assert_eq!((left, right), (6071150433487837324, 2027321285990159935));
        assert!(simon_encrypt_blocks(&key_bytes, b"wrong-length").is_none());
    }

    #[test]
    fn ladon_matches_fixed_independent_vector() {
        let digest = *b"de0b56f1b46af782a3c13a78476be326";
        let mut input = b"1700000000-1611921764-1967".to_vec();
        let pad = 16 - input.len() % 16;
        input.extend(std::iter::repeat_n(pad as u8, pad));
        let got = ladon_transform(&digest, &input).unwrap();
        let want = [
            0xa3,0x3b,0x63,0xb6,0xd6,0x9c,0xe2,0x14,
            0x5e,0x64,0xf2,0x6c,0x3e,0xbf,0x32,0x91,
            0x9b,0xba,0x07,0xb8,0xb0,0x1c,0x14,0x26,
            0xcc,0x87,0x56,0x2b,0xe1,0xb4,0xcb,0x07,
        ];
        assert_eq!(got, want);
        assert!(ladon_transform(&digest, b"bad-length").is_none());
    }

    #[test]
    fn gorgon_legacy_rc4_matches_fixed_vectors() {
        let bytes = std::array::from_fn::<_, 20, _>(|i| i as u8);
        let hex = |value: [u8; 20]| value.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(hex(gorgon_transform(&bytes, 0)),
            "7c6ea4f8fd1b19a64fb5f17cf2c09ce864510400");
        assert_eq!(hex(gorgon_transform(&bytes, 0x1234)),
            "aa1bde6f7b948ad7823d322065098be5ba8a2733");
        assert_eq!(hex(gorgon_transform(&bytes, 0xffff)),
            "cb95f3729edc67f5cf7a645210f698674fd40085");
    }

    #[test]
    fn medusa_xmxor_matches_vendor_golden() {
        let mut key = [0u8; 32];
        for (i, b) in key.iter_mut().enumerate() { *b = ((i * 19 + 5) & 255) as u8; }
        let input: Vec<u8> = (0..32).map(|i| ((i * 23 + 3) & 255) as u8).collect();
        let out = medusa_xmxor(&input, &key).unwrap();
        let got: String = out.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(got, "dcfab15d2dc75f251f7aff27d678bd714ba88d42b99621222e3cf81d6c69c793");
    }

    #[test]
    fn medusa_xmxor_is_deterministic_and_rejects_invalid_lengths() {
        let mut key = [0u8; 32];
        for (i, b) in key.iter_mut().enumerate() { *b = (i * 19) as u8; }
        assert!(medusa_xmxor(b"abcd", &key).is_none());
        let original = b"medusa-signature-protocol".to_vec();
        let output = medusa_xmxor(&original, &key).unwrap();
        assert_eq!(output.len(), original.len());
        assert_ne!(output, original);
        assert_eq!(output, medusa_xmxor(&original, &key).unwrap());
        assert_ne!(output, medusa_xmxor(b"medusa-signature-protocoL", &key).unwrap());
    }

    #[test]
    fn medusa_aes_v3_handles_all_four_variants() {
        let box_values = std::array::from_fn::<u8, 256, _>(|i| i as u8);
        let key = [0x51u8; 16];
        let iv = [0x82u8; 16];
        let data: Vec<u8> = (0..299).map(|i| (i * 13 & 255) as u8).collect();
        for khronos in 0..4 {
            let output = medusa_aes_v3_encrypt(&data, &box_values, &key, &iv, khronos).unwrap();
            assert_eq!(output.len(), data.len() + 1);
            assert_ne!(&output[1..], data);
            assert_eq!(output, medusa_aes_v3_encrypt(&data, &box_values, &key, &iv, khronos).unwrap());
        }
        assert!(medusa_aes_v3_encrypt(&data[..247], &box_values, &key, &iv, 1).is_none());
    }

    #[test]
    fn medusa_iv_and_sum_md5_match_vendor_vectors() {
        let data: Vec<u8> = (0..32).map(|i| ((i * 29 + 1) & 255) as u8).collect();
        assert_eq!(medusa_get_iv(0x20230928, &data[..0]), 0x20230928);
        assert_eq!(medusa_get_iv(0x20230928, &data[..4]), 0x3853833e);
        assert_eq!(medusa_get_iv(0x20230928, &data[..12]), 0xdec0b87f);
        assert_eq!(medusa_get_iv(0x20230928, &data[..16]), 0xcaad61ff);
        assert_eq!(medusa_get_iv(0x20230928, &data[..32]), 0xd7ccee29);
        assert_eq!(medusa_sum_md5(&data[..32]), Some(0x99a979e5));
        assert!(medusa_sum_md5(&data[..11]).is_none());
    }

    #[test]
    fn sm3_abc_standard_vector() {
        assert_eq!(
            hex(&sm3(b"abc")),
            "66c7f0f462eeedd9d1f2d46bdc10e4e2" .to_string()
                + "4167c4875cf2f7a2297da02b8f4ba8e0"
        );
    }

    #[test]
    fn sm3_64_byte_standard_vector() {
        let input = b"abcd".repeat(16);
        assert_eq!(
            hex(&sm3(&input)),
            "debe9ff92275b8a138604889c18e5a4d" .to_string()
                + "6fdb70e5387e5765293dcba39c0c5732"
        );
    }

    #[test]
    fn sm3_multi_block_deterministic_and_distinct() {
        let first = vec![0x51; 1024];
        let mut second = first.clone();
        second[1023] ^= 1;
        assert_eq!(sm3(&first), sm3(&first));
        assert_ne!(sm3(&first), sm3(&second));
        assert_ne!(sm3(b""), sm3(b"\0"));
    }
}
