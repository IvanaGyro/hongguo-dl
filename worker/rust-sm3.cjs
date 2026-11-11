// Thin, synchronous JS ↔ Rust/WASM ABI bridge for Worker cryptographic math.
// No Worker-global timers, crypto RNG, fetch, or network operations.
const sm3 = require('./vendor/sm3.js');
const { installRustSigningBackend } = require('./vendor/playback-signature.js');

function installRustSm3(wasmModule) {
  const { exports: kernel } = new WebAssembly.Instance(wasmModule, {});
  const { memory, rust_alloc, rust_dealloc, rust_sm3,
    rust_simon_encrypt, rust_ladon_transform, rust_gorgon_transform,
    rust_medusa_xmxor } = kernel;
  if (!memory || !rust_alloc || !rust_dealloc || !rust_sm3 ||
      !rust_simon_encrypt || !rust_ladon_transform || !rust_gorgon_transform ||
      !rust_medusa_xmxor)
    throw new Error('The Rust signing wasm ABI is missing required exports');

  const allocate = length => {
    const ptr = rust_alloc(Math.max(1, length));
    if (!ptr) throw new Error('Rust signing memory allocation failed');
    return ptr;
  };

  function rustSm3(input) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const inPtr = allocate(bytes.length);
    let outPtr = 0;
    try {
      outPtr = allocate(32);
      new Uint8Array(memory.buffer, inPtr, bytes.length).set(bytes);
      const status = rust_sm3(inPtr, bytes.length, outPtr);
      if (status !== 0) throw new Error('Rust SM3 error ' + status);
      return Buffer.from(new Uint8Array(memory.buffer, outPtr, 32));
    } finally {
      if (outPtr) rust_dealloc(outPtr, 32);
      rust_dealloc(inPtr, Math.max(1, bytes.length));
    }
  }

  // Key is the exact 32-byte packed signing key or the MD5 hex ASCII digest.
  // Input consists of whole 16-byte blocks; output length equals input length.
  function transform(exported, key, input) {
    if (!Buffer.isBuffer(key) || key.length !== 32 ||
        !Buffer.isBuffer(input) || input.length % 16 !== 0 ||
        input.length > 16 * 1024 * 1024)
      throw new TypeError('Rust signing requires a 32-byte key and aligned input blocks');
    const keyPtr = allocate(key.length);
    let inputPtr = 0, outputPtr = 0;
    try {
      inputPtr = allocate(input.length);
      outputPtr = allocate(input.length);
      // Always reacquire memory.buffer: Rust allocations may grow linear memory.
      new Uint8Array(memory.buffer, keyPtr, key.length).set(key);
      new Uint8Array(memory.buffer, inputPtr, input.length).set(input);
      const status = exported(keyPtr, inputPtr, input.length, outputPtr);
      if (status !== 0) throw new Error('Rust signing error ' + status);
      return Buffer.from(new Uint8Array(memory.buffer, outputPtr, input.length));
    } finally {
      if (outputPtr) rust_dealloc(outputPtr, Math.max(1, input.length));
      if (inputPtr) rust_dealloc(inputPtr, Math.max(1, input.length));
      rust_dealloc(keyPtr, key.length);
    }
  }
  function gorgonTransform(input, random) {
    if (!Buffer.isBuffer(input) || input.length !== 20 ||
        !Number.isInteger(random) || random < 0 || random > 65535)
      throw new TypeError('Rust Gorgon requires 20 bytes and a 16-bit nonce');
    const inputPtr = allocate(20);
    let outputPtr = 0;
    try {
      outputPtr = allocate(20);
      new Uint8Array(memory.buffer, inputPtr, 20).set(input);
      const status = rust_gorgon_transform(inputPtr, random, outputPtr);
      if (status !== 0) throw new Error('Rust Gorgon error ' + status);
      return Buffer.from(new Uint8Array(memory.buffer, outputPtr, 20));
    } finally {
      if (outputPtr) rust_dealloc(outputPtr, 20);
      rust_dealloc(inputPtr, 20);
    }
  }

  function medusaXmXor(data, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32 ||
        !Buffer.isBuffer(data) || data.length < 5 || data.length > 16 * 1024 * 1024)
      throw new TypeError('Medusa XM-XOR requires a 32-byte key and at least 5 data bytes');
    const keyPtr = allocate(32);
    let inputPtr = 0, outputPtr = 0;
    try {
      inputPtr = allocate(data.length);
      outputPtr = allocate(data.length);
      new Uint8Array(memory.buffer, keyPtr, 32).set(key);
      new Uint8Array(memory.buffer, inputPtr, data.length).set(data);
      const status = rust_medusa_xmxor(keyPtr, inputPtr, data.length, outputPtr);
      if (status !== 0) throw new Error('Rust Medusa XM-XOR error ' + status);
      return Buffer.from(new Uint8Array(memory.buffer, outputPtr, data.length));
    } finally {
      if (outputPtr) rust_dealloc(outputPtr, data.length);
      if (inputPtr) rust_dealloc(inputPtr, data.length);
      rust_dealloc(keyPtr, 32);
    }
  }

  const simonBlocks = (key, input) => transform(rust_simon_encrypt, key, input);
  const ladonTransform = (md5Ascii, input) => transform(rust_ladon_transform, md5Ascii, input);

  // Reject incompatible binaries before installing any production backend.
  const vector = rustSm3(Buffer.from('abc')).toString('hex');
  if (vector !== '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
    throw new Error('Rust SM3 WebAssembly integrity check failed');

  sm3.setRustBackend(rustSm3);
  installRustSigningBackend({ simonBlocks, ladonTransform });
  const appSource = require('./vendor/app-source.js');
  appSource.setRustGorgonBackend(gorgonTransform);
  appSource.setRustXmXorBackend(medusaXmXor);
  return { sm3: rustSm3, simonBlocks, ladonTransform, gorgonTransform, medusaXmXor };
}
module.exports = installRustSm3;
