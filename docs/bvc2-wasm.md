# BVC2 / ByteVC2 browser decoder: implementation boundary

The upstream [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama/blob/main/docs/bytevc2-playback.md)
uses a **native Librempeg bvc2 decoder**, not an ordinary H.266/VVC
decoder. Its pinned revision is `cb1f8f3eef84999e61b27e2d44664858179bc240`.
That source contains `ff_bvc2_decoder` in `libavcodec/vvc/dec.c`.

The experimental WASM compilation step is intentionally **not installed as a
production player**. It checks whether Emscripten can compile and link that
decoder; a decoder-symbol probe is not evidence that encrypted BVC2 MP4s play.
Before shipping, implement and independently test all of:

1. Run a full, permissioned encrypted BVC2 CENC sample through the native
   decryptor or a separately validated CENC handler. The EME path cannot
   magically make a browser support BVC2.
2. Stream decoded pictures to a renderer, or transcode to browser-supported
   H.264, with correct audio and A/V synchronization. If using x264 in WASM,
   verify the upstream source/relinkable artifacts and license conditions.
3. Compare browser WASM throughput, allocation/high-water memory and first
   frame latency against native Librempeg on *the same sample*. Benchmark on
   target Android hardware; do not extrapolate desktop throughput.
4. Enforce cancellation, bounded memory, source validation, and no network
   requests for CI codec tests.

**Why not rewrite the codec in Rust?** Librempeg already implements BVC2 in C.
Emscripten compiles native C into WASM. Reimplementing a complex video codec
in Rust without verified conformance would introduce substantial correctness
risk. Rust remains appropriate for independent MP4/CENC sample parsing if
profiling shows a meaningful CPU bottleneck. The native EME/Clear Key
streaming path intentionally uses the browser's built-in decryptor rather than
performing AES in JavaScript or Rust.

For browser-supported encrypted H.264/HEVC, `src/clear-key.js` reads bounded
MP4 header ranges and asks the browser CDM to decrypt the media in streaming
mode. It falls back to the existing FFmpeg.wasm implementation on unsupported
browsers. The Firefox workflow generates a synthetic CENC test clip and
verifies actual playback and its observed startup cost.
