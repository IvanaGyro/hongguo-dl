# Rust cryptographic computation kernel

This crate is the first stage of migrating the project's **computational**
functions out of JavaScript. The production Cloudflare Worker loads
`dist/hongguo_crypto.wasm`, compiled from `src/lib.rs` for
`wasm32-unknown-unknown`.

## Implemented

- SM3 hashing used by the Worker signing path (Rust, dependency-free).
- **Simon 72-round permutation** used to encrypt Argus 551 signing blocks.
  A full Argus message is encrypted in one Rust/WASM call.
- **Ladon 34-round key expansion and block permutation**, shared by playback
  `x-ladon` and App `x-helios` signatures with exact output compatibility.
- **Gorgon 20-byte RC4-like mixing and bit reversal**, retaining the
  upstream state mutation exactly rather than replacing it with standard RC4.
- **Medusa XM-XOR** byte permutation and dependent postmix, with independent
  golden output and varying-length parity tests.
- **Medusa custom AES V3**, including time-dependent S-box selection, unusual
  key expansion, row permutations, block mixing, and byte bit injection.
  All four time variants and different input lengths are checked against the
  original JavaScript implementation.
- **Medusa IV selector and 12-byte checksum**, preserving JavaScript's
  unsigned 32-bit wrapping and shift semantics.
- **Medusa hashF13 all three branches**, including both branch-specific
  hash compression algorithms and the variable 20/36-byte outputs.
  The tables are pinned in `src/medusa_f13.rs` and Rust is tested against
  the original JavaScript for representative inputs from all branches.
- Stable ABI: `rust_alloc`, `rust_dealloc`, `rust_sm3`,
  `rust_simon_encrypt`, `rust_ladon_transform`, `rust_gorgon_transform`,
  `rust_medusa_xmxor`, `rust_medusa_aes_v3`, `rust_medusa_get_iv`,
  `rust_medusa_sum_md5`, `rust_medusa_hash_f13`.
- Thin memory-copy bridge at `worker/rust-sm3.cjs` shared by the real
  Worker entrypoint and the golden-vector tests.
- SM3 official vectors; Simon, Ladon/Helios, Gorgon, XM-XOR, and checksum
  fixed vectors; full Argus/Ladon/Gorgon byte-for-byte parity checks, plus
  Medusa AES-V3, XM-XOR, and F13 direct comparisons with the vendor JS code.
  Cloudflare workerd cold-start verification is also required.
- Pinned Rust 1.99.1 and byte-for-byte precompiled WASM verification.

## Why precompile and check in the .wasm file?

Cloudflare Workers Builds presently runs `bun run deploy:worker` from the
GitHub repository. It does not need a Rust toolchain: Wrangler uploads the
checked-in binary as a WebAssembly module. CI compiles the source and compares
it byte-for-byte with the shipped binary; any source/binary mismatch fails.
To intentionally update the binary, run:

```sh
rustup toolchain install 1.99.1
rustup target add wasm32-unknown-unknown --toolchain 1.99.1
cargo +1.99.1 test --manifest-path rust/crypto/Cargo.toml --locked
cargo +1.99.1 build --manifest-path rust/crypto/Cargo.toml --release --locked --target wasm32-unknown-unknown
cp rust/crypto/target/wasm32-unknown-unknown/release/hongguo_crypto.wasm rust/crypto/dist/
```

## Deliberate scope boundary

Argus and Ladon **round-based computation** now runs in Rust/WASM in
production. JavaScript still assembles protobuf/query parameters, computes
MD5 and AES through native `node:crypto`, and handles the browser/Worker
interfaces; it does not perform the heavy Simon/Ladon loops on the deployed
Worker. The JavaScript reference implementations remain so golden tests can
detect protocol regressions.

Medusa's XM-XOR, custom AES-V3, IV/checksum, and all hashF13
branches now run in Rust. Its protobuf assembly, transport encoding,
randomness, MD5 via native `node:crypto`, and other platform integration
remain in JavaScript. Other app-signature variants and browser HLS
orchestration have also not been fully migrated. The FFmpeg.wasm core
already runs native **C compiled to WebAssembly**, not video codecs
implemented in JavaScript; reimplementing its codecs in Rust is unnecessary.

Rust/WASM does not eliminate the need for minimal JavaScript platform glue:
browser file access, Worker `fetch` handlers, streams, and importing Wasm
remain exposed through JavaScript APIs.
