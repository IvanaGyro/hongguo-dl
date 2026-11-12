# BVC2 / ByteVC2 browser decoder: implementation boundary

The upstream [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama/blob/main/docs/bytevc2-playback.md)
uses a **native Librempeg bvc2 decoder**, not an ordinary H.266/VVC
decoder. Its pinned revision is `cb1f8f3eef84999e61b27e2d44664858179bc240`.
That source contains `ff_bvc2_decoder` in `libavcodec/vvc/dec.c`.

The experimental Librempeg/x264 WASM bundle is now compiled by CI and
published into `public/bvc2/` for an **experimental** worker-based player
fallback. It is not a validated production BVC2 decoder: a decoder-symbol
probe and an invalid-input rejection test do **not** demonstrate that an
encrypted ByteVC2 MP4 produces correctly decoded pictures.
Before treating it as production-ready, independently verify all of:

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

## 實驗實測（2026-11-12）

- Emscripten 3.1.74 已將固定 Librempeg 原始碼中的 `bvc2` 解碼器
  連結到約 1.8 MiB WASM，並在 Node.js 確認 `avcodec_find_decoder_by_name("bvc2")`
  有效。[CI 編譯成功](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43190032040)。
- [WASM build / ABI CI #11](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43206278599)
  已成功將 Librempeg `bvc2` 解碼器、x264 編碼器及 MP4 demux/mux
  結合為約 4.81 MiB 的 `bvc2-core.wasm`，執行 Node.js smoke test 並發布至
  `main`。**尚未有真實 BVC2 影格、同步與效能的端對端通過紀錄。**
- [CENC Firefox 播放與同片源起播比較](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43189653163)：
  15 秒 H.264 加密測試片，在同一 CI Runner 的單次量測，原生 EME
  1,987 ms，FFmpeg.wasm 1,229 ms。這個極短小樣本反而是 FFmpeg
  較快，且先後測量有冷／暖快取差異；不能用來推論較大影片的
  上線收益。原生 EME 的核心優勢仍是 **不等待整集下載**。
- 對於是否使用 Rust：目前 JS 只讀取最多 1 MiB 的 MP4 metadata，
  網路與 CDM 的系統呼叫遠大於這部分運算。應先量測耗時與
  WASM 初始化／資料複製成本，再評估是否移植 Rust；BVC2 核心
  則已是可編譯到 WASM 的 C，不需要重新實作演算法。

## CENC native browser regression

- `src/clear-key.js` uses bounded HTTP Range MP4 metadata reads, EME Clear Key
  and the standardized Common SystemID PSSH (version 1).
- In the GitHub Actions headless Firefox, a synthetic H.264 CENC MP4 now reaches
  `MediaKeys` with a **usable key**, but the browser reports `MEDIA_ERR_DECODE`
  (3), and the application correctly falls back to whole-file FFmpeg.wasm
  remuxing. Do not claim this proves native EME playback works in Firefox.
- Chromium comparison and real HEVC/browser-device verification are still
  required. The low-latency EME path is **conditionally available**, not a
  guarantee for every HEVC browser or source. Use `原生串流解密` in the
  player source info as the runtime indicator.
