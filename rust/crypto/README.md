# Rust computation kernel

This crate is the first stage of migrating the project's **computational**
functions out of JavaScript. The production Cloudflare Worker loads
`dist/hongguo_crypto.wasm`, compiled from `src/lib.rs` for
`wasm32-unknown-unknown`.

## Implemented

- SM3 hashing used by the Worker signing path, with a dependency-free
  standard Rust implementation.
- Fixed ABI exports: `rust_alloc`, `rust_dealloc`, `rust_sm3`.
- A narrow memory-copy bridge at `worker/rust-sm3.cjs` used by the
  Cloudflare Worker entrypoint and the golden-vector test.
- Official SM3 vectors, JS-legacy comparison on boundary lengths,
  and Argus hash golden vectors.
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

This migration does **not** yet rewrite Argus/Ladon signing, Medusa, Gorgon,
the browser HLS orchestration, or the FFmpeg engine. Their current algorithms
are still implemented or called through JavaScript; SM3 in the production
Worker uses Rust/WASM, while the legacy JS SM3 remains solely as a test
fallback. The FFmpeg.wasm core is already native **C compiled to WebAssembly**,
not media processing performed in JavaScript, and replacing it with Rust
would require an independent codec implementation or wrapper.

Rust/WASM does not eliminate the need for minimal JavaScript platform glue:
browser file access, Worker `fetch` handlers, streams, and importing Wasm
remain exposed through JavaScript APIs.
