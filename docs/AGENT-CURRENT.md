# Hongguo DL — 目前狀態（2026-11-13，階段 64）

> **執行規則**：只在 `main` 直接提交，不建立 PR。每個獨立階段先程式／測試，再更新 `docs/AGENT-PROGRESS.md` 與本短版並繼續。GitHub Actions 狀態只作有限度單次查詢；不可把 pending 寫成 PASS。不得記錄 signed media URL、CENC key、私有影片／使用者識別碼。

## 最新工作及 CI 證據

- **階段 64 Firefox Web Audio 使用者操作修復**：[f1ce714](https://github.com/IvanaGyro/hongguo-dl/commit/f1ce714bdc9f726289e5345b7a86ab21d1358135)。Firefox 的 `AudioContext.resume()` 在未經可信點擊下超時；改由 Playwright 真實點擊、於事件處理器建立／啟動 AudioContext。PCM RMS 門檻不放寬。**本版 Browser fast/long PENDING**：[run #43300329771](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43300329771) 首查 pending。請先看 fast job 結果，有 FAIL 讀確切 log。
- **階段 63 原始 PCM 驗收**：[Browser #43299574104](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43299574104) fast job `131466810901` **FAIL**：Chromium **PCM PASS**，peakRms=`0.0884986`、25/25 視窗非靜音、`videoError=null`；後續 Firefox AudioContext 3s resume timeout，不能將其判定為解碼失敗或 PCM PASS。
- **上版 CENC Browser 全套已驗**：[Browser #43297755488](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43297755488) **fast/long 雙 job completed/success**：兩瀏覽器 synthetic H264/AAC EOF 前首影格、遠距 seek 7→63→35→5→63、reload、三輪播放／下載模式切換（5 個 MSE URL 建立/4 撤銷，播放時鐘繼續前進）。Chromium 切換階段仍有 **9 筆 MOV/AAC demux 診斷**（subsample、corrupt packet、partial file），Firefox 0。long Chromium 120000ms pause Range 9→9、300s played with bounded MSE、1800s ended (104 Range)。
- **pinned Librempeg 正例**：[WASM #43298585708](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43298585708) **completed/success**：合成 70s H264/AAC CENC 的 7、35、55、63s 各獨立 indexed seek；direct AVIO vs Worker-style 256KiB Range window 的 clear fMP4 **逐 byte 相同**，`ffmpeg -xerror` AAC/H264 解碼 PASS。合成 1080p HEVC/AAC remux/FFmpeg decode 也已 PASS，但未證明裝置 HEVC MSE。
- **Firefox 播放器產品驗收**：[Firefox #43295729590](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295729590) **success**：720p ByteVC2-only 不擅自回退到 1080p HEVC、播放器 1.25× 切換保留等測試。

## 架構與剩餘風險

既有 **Librempeg Asyncify AVIO WASM** 解密 progressive CENC MP4 並無損 remux 為 clear fMP4，透過 MSE 播放；`hvc1/hev1` codec tag 依 pinned WASM 實際輸出 init 決定。CENC 來源 403／429／無效 206 不得 fallback 成整檔下載。BVC2 獨立實驗性整檔 WASM 解碼＋x264 路徑，沒有真實 ByteVC2 正例。

**下一個工程動作**：讀階段 64 browser fast 真正結論；Web Audio PCM 初次起播通過後，加入遠距 Seek／模式切換後的**瀏覽器 AAC PCM 正例**，並更精確歸因 Chromium 9 個 MOV demux 訊息；不能簡單忽略 active stream 的 AAC 失敗。必要時修正 tests 與 Worker 取消競態，保留強制合成 E2E。僅在具體失敗時讀相關 Actions log，不連續輪詢。

**外部未驗（NOT TESTED）**：具合法 HTTP 206 的真實紅果 HEVC CENC（先前 CDN 403）、Windows/Android HEVC MSE 實機首影格與 AAC／完整播放、真正 ByteVC2 bitstream frame decode/性能。合成證據不能取代真實裝置。

詳盡追蹤：[AGENT-PROGRESS.md](AGENT-PROGRESS.md)、[CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)、[NEXT-SESSION-PLAN.md](NEXT-SESSION-PLAN.md)。

**文件更新不是停止條件，更新後繼續工程。**
