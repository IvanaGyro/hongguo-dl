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

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
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
