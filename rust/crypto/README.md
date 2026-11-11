# Rust cryptographic computation kernel

This crate is the first stage of migrating the project's **computational**
functions out of JavaScript. The production Cloudflare Worker loads
`dist/hongguo_crypto.wasm`, compiled from `src/lib.rs` for
`wasm32-unknown-unknown`.

## Implemented

- SM3 hashing used by the Worker signing path (Rust, dependency-free).
- **Simon 72-round permutation** used to encrypt Argus 551 signing blocks.
  A full Argus message is encrypted in one Rust/WASM call.
- **Ladon 34-round key expansion and block permutation**, with exact
  compatibility against the original JS signer.
- Stable ABI: `rust_alloc`, `rust_dealloc`, `rust_sm3`,
  `rust_simon_encrypt`, `rust_ladon_transform`.
- Thin memory-copy bridge at `worker/rust-sm3.cjs` shared by the real
  Worker entrypoint and the golden-vector tests.
- SM3 official vectors, Simon and Ladon fixed vectors, full Argus/Ladon
  signed request byte-for-byte parity tests (including body signatures),
  plus Cloudflare workerd cold-start verification.
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

Medusa, Gorgon, other app-signature variants, and browser HLS orchestration
have **not** been ported to Rust. The FFmpeg.wasm core is already native
**C compiled to WebAssembly**, not media processing implemented in JavaScript;
reimplementing the codecs in Rust is unnecessary.

Rust/WASM does not eliminate the need for minimal JavaScript platform glue:
browser file access, Worker `fetch` handlers, streams, and importing Wasm
remain exposed through JavaScript APIs.
