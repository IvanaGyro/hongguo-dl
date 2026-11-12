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

## 2026-11-13 後續：版本一致性及「真實正例」驗收工具

- [BVC2 experimental WASM #43279446447](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279446447)：專用解碼器與 x264 確實可編譯到 WebAssembly，Node 會拒絕普通 H.264 MP4 和無效位元組；**這是負例，不代表有解出 ByteVC2 實際影格**。
- [BVC2 versioned WASM release #43280846374](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280846374) 已完成成功：正式版本化 `public/bvc2/bvc2-core.mjs`、`bvc2-core.wasm`、`manifest.json`；script 和瀏覽器 Worker 核對 SHA256、原始碼指紋與 Librempeg/x264 pin，拒絕版本混用。CI/Pages 使用 `node scripts/bvc2-wasm-bundle.mjs verify` 守門。
- 給有合法本地 ByteVC2 測試檔案的使用者，**不要把影片、金鑰或明文輸出提交到 GitHub**，可以在自己的電腦執行：

```bash
node scripts/bvc2-wasm-bundle.mjs verify
# 必須先在本機安裝 Node.js 與 FFmpeg/ffprobe；此例是未加密樣本
node scripts/verify-bvc2-fixture.mjs /path/to/authorized-bvc2.mp4
# 若需要 AES-CTR CENC 金鑰，從本機環境變數讀取，不要把金鑰寫在命令紀錄/CI
```

腳本會呼叫同一版公開的 BVC2→H.264 WASM，確認解碼後影片真實有可解碼畫格、FFmpeg 完整解碼、列出 codec、解析度、audio track、轉碼秒數和 Node RSS；清除暫存明文。程式碼不會網路下載來源，也不會記錄 signed URL/金鑰。

**剩餘硬性 PASS 條件**：取得授權真實 ByteVC2 bitstream 後，在 Node native/WASM 和 Android Firefox/Windows 實際播放端驗證首影格、A/V 同步、速度和 RAM 高水位，再決定是否將 whole-file MEMFS 路徑替換為 AVIO streaming / H.264 fMP4 輸出。**目前禁止宣稱實驗性 BVC2 已達正式播放要求。**
