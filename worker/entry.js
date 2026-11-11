// Cloudflare Worker entry: Rust is responsible for SM3 computation.
// The minimal JavaScript bridge only transfers byte arrays to wasm linear memory.
import wasmModule from '../rust/crypto/dist/hongguo_crypto.wasm';
import sm3 from './vendor/sm3.js';
import app from './worker.js';

const { exports: kernel } = new WebAssembly.Instance(wasmModule, {});
const { memory, rust_alloc, rust_dealloc, rust_sm3 } = kernel;
if (!memory || !rust_alloc || !rust_dealloc || !rust_sm3)
  throw new Error('The Rust SM3 wasm ABI is missing required exports');

function rustSm3(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const inPtr = rust_alloc(bytes.length || 1);
  if (!inPtr) throw new Error('Rust SM3 input memory allocation failed');
  let outPtr = 0;
  try {
    outPtr = rust_alloc(32);
    if (!outPtr) throw new Error('Rust SM3 output memory allocation failed');
    new Uint8Array(memory.buffer, inPtr, bytes.length).set(bytes);
    const status = rust_sm3(inPtr, bytes.length, outPtr);
    if (status !== 0) throw new Error('Rust SM3 returned error status ' + status);
    // Rust may grow memory while hashing, so take memory.buffer after the call.
    return Buffer.from(new Uint8Array(memory.buffer, outPtr, 32));
  } finally {
    if (outPtr) rust_dealloc(outPtr, 32);
    rust_dealloc(inPtr, bytes.length || 1);
  }
}

sm3.setRustBackend(rustSm3);
const vector = rustSm3(Buffer.from('abc')).toString('hex');
if (vector !== '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
  throw new Error('Rust SM3 WebAssembly integrity check failed');

export default app;
