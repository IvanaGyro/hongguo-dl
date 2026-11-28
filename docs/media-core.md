# 統一媒體核心（Librempeg WASM）

更新：2026-11-28。網頁原本有三套 WASM：FFmpeg.wasm（`@ffmpeg/core` 0.12，整集解密／封裝／轉 H.264、MP4 合併）、`public/bvc2`（Librempeg + 四種編碼器）與 `public/cenc`（精簡 Librempeg，CENC 增量轉封裝）。現在合併為**一個 Librempeg 核心**，放在 `public/media-core/`，所有路徑（播放串流、整集備援、下載、合併）都使用它。

## 組成

| 元件 | 版本（固定 commit） | 用途 |
| --- | --- | --- |
| Librempeg | `cb1f8f3e…` | mov/concat demuxer、mp4 muxer、bvc2/vvc/h264/hevc/aac 解碼、swscale |
| x264 | ffmpegwasm `33cac6b7…` | H.264 |
| x265 3.4 | ffmpegwasm `2bb5520e…` | H.265／HEVC（輸出 `hvc1`） |
| **SVT-AV1 4.3.1** | `ad875ab7…` + IvanaGyro/SVT-AV1 PR #1、#2 | AV1（取代 libaom） |
| VVenC 1.13.1 | `ca1af4a2…` | VVC／H.266 |

C 介面在 `scripts/media-core/`：`avio.c`（Asyncify Range 讀取／fMP4 輸出）、`cenc-remux.c`（`cenc_stream_remux*`）、`transcoder.c`（`media_convert`、`media_concat`、`bvc2_stream`、`bvc2_play` 與舊 `bvc2_*` 相容入口）。`media_core_info()` 回報 ABI（`api=4`）、執行緒上限與已連結的編碼器。

## 多執行緒

同一份原始碼建置兩個變體，由同一份 `manifest.json`（schema 2）以 SHA-256 綁定：

| 變體 | 檔案 | 條件 |
| --- | --- | --- |
| `mt` | `media-core.{mjs,wasm}`（約 17 MiB） | 頁面 `crossOriginIsolated` 且有 `SharedArrayBuffer` |
| `st` | `media-core-st.{mjs,wasm}`（約 16 MiB） | 其他瀏覽器（例如不支援 COEP `credentialless` 的 Safari） |

- GitHub Pages 無法送出 COOP/COEP，因此站內 Service Worker（`public/bulk-download-sw.js`，原本只負責 ZIP 串流）為同源頁面、腳本與 WASM 回應補上 `Cross-Origin-Opener-Policy: same-origin` 與 `Cross-Origin-Embedder-Policy: credentialless`。不攔截 `/api/`、跨來源 CDN 與 Range 請求；`credentialless` 讓跨來源圖片與 CDN 影片（no-cors、不帶 cookie）照常載入。
- 第一次造訪時頁面尚未受 Service Worker 控制；若使用者還沒操作且載入不到 4 秒，`src/cross-origin-isolation.js` 會自動重新整理一次（以 sessionStorage 防止迴圈；自動化測試不重新整理）。之後每次開啟都是隔離狀態。
- 能開就開：每個轉碼工作使用全部邏輯核心（`navigator.hardwareConcurrency`），不因同時下載多集而平分——下載多半在等網路，真正重疊的轉碼交給作業系統排程。沒有人為上限；C 端只保留 x264 的 128 執行緒上限，解碼器依 FFmpeg 建議最多 16。ByteVC2 串流播放的 VVC 解碼與 x264 也使用多執行緒；CENC 轉封裝不需要執行緒。
- 使用哪個變體與執行緒數只寫入 console log（`[media-core] multi-thread core, encoder threads N, pthread pool P`），網頁不顯示。
- **SVT-AV1 4.x 的 `lp` 是 1–6 的平行度等級，不是執行緒數**（≥7 會被夾到 6）。`transcoder.c` 用與 SVT 自己 `lp=0` 相同的對照把核心數換成等級：1 核→1、2→2、3–5→3、6–11→4、12–23→5、24 以上→6。
- Emscripten 的 pthread 必須事先建立 Worker，否則編碼器等待執行緒時可能卡住。載入器依編碼器預先建立 Worker 池（`mediaPoolSize`）。實測 SVT-AV1 4.3 等級 2／3／4／5／6 分別啟動 37／46／59／78／82 個執行緒（720p、1080p 相同），等級 1 完全不建立執行緒——因此單執行緒變體也能使用 SVT-AV1，不再需要 libaom。

### 實測（Chromium headless，4 核，720p30 5 秒 testsrc2，執行緒 4；AV1 當時誤用 `lp=4`，現為等級 3，Node.js 重測 4.7 s）

| 編碼 | st | mt | 加速 |
| --- | ---: | ---: | ---: |
| H.264 superfast CRF 19 | 5.7 s | 2.7 s | 2.1× |
| HEVC superfast CRF 22 | 19.5 s | 6.2 s | 3.1× |
| AV1 SVT preset 10 CRF 30 | 11.8 s | 4.6 s | 2.5× |
| VVC faster QP 30 | 86.6 s | 27.2 s | 3.2× |

`mt` 建立 72 個 Worker 的執行緒池約需 1 秒；HEVC 在 `mt` 由 x265 preset 決定 B-frame，同 CRF 檔案更小（`st` 的同步 x265 無法使用 B-frame／lookahead）。合成畫面不代表真實短劇內容的速度與壓縮率。

## 下載參數（速度／檔案大小滑桿）

H.264、H.265、AV1、VVC 都有與 H.264 相同的單一滑桿，選定值寫入佇列工作並保存在 localStorage（每種編碼各自記憶）。檔名加上 `.h264-<preset>`、`.hevc-<preset>`、`.av1-p<preset>`、`.vvc-<preset>`。

| 編碼 | 停點（preset · 品質值） | 預設 |
| --- | --- | --- |
| H.264（x264, CRF） | ultrafast 18 · superfast 19 · faster 16 · fast 17 · medium 18 · slow 18（VMAF 量測，見 [h264-download-speed-size.md](h264-download-speed-size.md)） | superfast |
| H.265（x265, CRF） | ultrafast · superfast · veryfast · faster · fast · medium，CRF 皆 22 | superfast |
| AV1（SVT-AV1, CRF） | preset 12 · 10 · 9 · 8 · 7 · 6，CRF 皆 30 | preset 10 |
| VVC（VVenC, QP） | faster · fast · medium，QP 皆 30 | faster |

**能不重新編碼就不重新編碼**：整集下載時，若來源已是選定的編碼（H.264→H.264、H.265→H.265、AV1→AV1、VVC→VVC），核心直接複製壓縮封包（CENC 來源同時解密），不套用滑桿；ByteVC2→VVC 一樣直接重新封裝成 `vvc1`，只有標準工具無法描述其參數集時才退回 VVenC 重新編碼。判斷依據是核心讀到的實際來源編碼（直連網址等 metadata 不明的來源也適用）；`media_last_remuxed()` 回報結果，佇列顯示「來源相同，未重新編碼」，檔名不加 preset 後綴。播放用的 ByteVC2 串流不受影響。

H.265／AV1／VVC 在同一編碼內固定品質值，滑桿只交換編碼時間與檔案大小；這些值**尚未做 VMAF 量測**。`media_convert` 在 C 端再驗證一次 preset 名稱與品質範圍。

## SVT-AV1 修補評估

| PR | 內容 | 本專案是否需要 |
| --- | --- | --- |
| #1 `fix(wasm): avoid rebasing fixed Wiener filter kernel pointers` | `svt_av1_wiener_convolve_add_src_c` 把單一 8-tap 濾波器指標遮罩到 256-byte 邊界再相減，是未定義行為；只有在陣列剛好 16-byte 對齊時結果才正確 | **需要**。WASM 只能用 C 路徑（`COMPILE_C_ONLY`），preset ≤ 約 8 啟用 loop restoration 時一定經過這裡。本機實測未修補版通常仍正確（Emscripten 的堆疊對齊剛好滿足），但結果取決於編譯器配置，屬潛在錯誤 |
| #2 `fix(avx2): respect pointer width when copying motion-info grids` | AVX2 版 `svt_copy_mi_map_grid` 以 64-bit 寫入指標，wasm32 會覆寫相鄰格 | 目前的 C-only 建置不編譯 AVX2 檔案，**沒有實際作用**；若日後改用 Emscripten 的 x86 SIMD 模擬（`-mavx2`）就是必要修補，因此一併固定 |

兩個修補以 `git format-patch` 匯出到 `scripts/patches/svt-av1/`，在建置時套用到固定 commit，不依賴 fork 分支持續存在。PR #3／#4（WASM SIMD128 dispatch 與 SATD／平方誤差核心）是效能優化，沒有納入；需要時可另外評估。

本機以未修補／修補兩版 `SvtAv1EncApp`（Emscripten pthread）在 preset 10／6／4 編碼，重建影像與 FFmpeg 解碼結果完全相同（`--recon` 位元一致），多次執行輸出雜湊一致。

## 建置與發布

```sh
bash scripts/build-media-core.sh mt /tmp/media-core   # pthreads
bash scripts/build-media-core.sh st /tmp/media-core   # 單執行緒
bash scripts/build-native-vvc-verifier.sh /tmp/media-core
VVC_FFMPEG=/tmp/media-core/native/librempeg/ffmpeg VVC_FFPROBE=/tmp/media-core/native/librempeg/ffprobe \
  node scripts/verify-video-outputs.mjs /tmp/media-core/dist mt   # 再以 st 執行一次
node scripts/media-core-bundle.mjs publish /tmp/media-core/dist
node scripts/media-core-bundle.mjs verify
```

`.github/workflows/media-core-wasm.yml` 在 `emscripten/emsdk:3.1.74` 容器內做同樣步驟，再用 Chromium 跑 ByteVC2 串流／整檔備援（非隔離與隔離各一次），全部通過後才把二進位提交回來源分支。

## 限制

- 單一核心約 17 MiB，CENC 增量播放第一次載入比原本 1.4 MiB 的 `cenc-core` 大（之後由 HTTP 快取與內容雜湊網址重用）。
- 同時下載多集時，每集各有一個核心與執行緒池；記憶體上限每個核心 2 GiB（可成長的共享記憶體）。
- 解碼器只含 ByteVC2、VVC、H.264、HEVC、AAC；其他編碼的直連影片只能保留原始檔下載。
- Safari／iOS 沒有 COEP `credentialless`，維持單執行緒；Firefox 隔離版尚未在本機實測（CI 只跑 Chromium）。
