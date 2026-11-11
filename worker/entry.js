// Cloudflare Worker entry: Rust/Wasm handles SM3 signature computation.
import wasmModule from '../rust/crypto/dist/hongguo_crypto.wasm';
import installRustSm3 from './rust-sm3.cjs';
import app from './worker.js';

installRustSm3(wasmModule);
export default app;
