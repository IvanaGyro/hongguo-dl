// Cloudflare Worker entry: Rust/Wasm computes SM3, Simon, Ladon/Helios and Gorgon signatures.
import wasmModule from '../rust/crypto/dist/hongguo_crypto.wasm';
import installRustSm3 from './rust-sm3.cjs';
import app from './worker.js';

installRustSm3(wasmModule);
export default app;
