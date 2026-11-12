# Hongguo DL — 目前狀態（接手時先讀；2026-11-13）

> **本檔是短版「現在應做什麼」索引，不替代 [AGENT-PROGRESS.md](AGENT-PROGRESS.md) 的可追溯歷史、[測試矩陣](CENC-TEST-MATRIX.md) 或 [技術架構](cenc-progressive-to-fmp4.md)。**
>
> **使用者的固定要求**：直接提交 `main`，不開 PR；每完成一個可驗證工程階段，立即更新 AGENT-PROGRESS（記 commit、PASS/FAIL/PENDING 和 run URL）並繼續做下一階段。**GitHub 的讀取、寫入、Actions 等各種操作都有可能卡住**：不要在同一操作或等待中的 run 上無限制重試／輪詢。若受阻先留下最小可恢復 checkpoint。

## 目前已經成功，不要重做

- **CENC 架構**：既有 Librempeg Asyncify AVIO、bounded HTTP 206 Range、CENC decrypt、HEVC/AAC 無損 stream copy、clear fMP4 MSE；WASM 與 manifest SHA256/build provenance 由 CI/Pages 防止版本錯配。
- **瀏覽器合成正例**：Linux Chromium/Firefox 以 H.264/AAC 加密 progressive MP4 真正顯示影格（HTTP EOF 前），55s 遠距 Seek、7→63→35→5→63s 往返、reload 續播及播放/下載模式切換 PASS。[Browser #43279166406](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279166406)。
- **合成 HEVC 1080p**：1920×1080 HEVC/AAC CENC progressive → pinned Librempeg WASM clear fMP4，FFmpeg 解碼成功，來源 EOF 前首 fragment，6s indexed RAP seek PTS PASS。[WASM #43279575089](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279575089)。**不等於真實瀏覽器 HEVC 解碼成功**。
- **30 分鐘完整播放**：[Browser #43283216947](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283216947)，合成 480×270 H.264/AAC 1800.021s、ended=true、videoError=null、104 HTTP Range、MSE span 最高 72s、ahead 43.56s；首影格時僅取得 6.6% 來源。Linux test harness + browser process-tree RSS first/peak/last 802.5/838.8/838.2 MiB，**不是 Android/GPU RAM**。
- **暫停後 HTTP Range 背壓已 PASS**：[Browser #43285424033](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43285424033)，含 `CENC_TEST_PAUSE=1`，實際 `PASS chromium paused CENC HTTP Range backpressure and playback resume`：pausedAt=1.5784s、3 秒觀察 Range **9→9**、resume 後完整播至 300s（同 run 1800s 也 PASS）。這是 Linux Chromium 合成 H.264/AAC，不是 Android/HEVC 長時間暫停驗證。
- **修正完成**：先前 1800s 因 `moov >1MiB` 導致 KID 未取得、HTTP 416 整檔 fallback；現以有界 8MiB 元資料限制和超限非重試錯誤修復並在上述 1800s synthetic PASS。
- **近期程式修補與回歸**：
  - ByteVC2 Worker startup cancellation / postMessage failure 及 7 單測：`b57923f`、`90603dd`、`8f9d4c7`，[CI #43284208866](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43284208866) PASS。
  - CENC Worker 同步啟動失敗釋放 Object URL / terminate；故障注入單測 `a4ac231`，[CI #43285460654](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43285460654) PASS。
  - ByteVC2 **本機授權正例驗收工具**新增輸出影音 start/end ±1.5s 時間軸檢查與 5 單測，`54fd067`、`cc9474c`、`d241153`，[CI #43285897450](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43285897450) PASS。**尚無真正 ByteVC2 正例樣本！**
  - CENC/BVC2 HEAD 檢測初次失敗不再永久 memoize，成功才快取，同時請求 single-flight；`b8149ce`、`7297b2c`、`e3fd0a2`、`205dc02`，[CI #43286523179](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43286523179) PASS。**不要使用中間有錯誤 regex 的 `effd215` 作為基準**。

## 仍待驗證／不可誤報

1. **更長暫停與反覆切集仍待驗證**：3 秒觀察期的暫停節流已在 Browser #43285424033 正式 PASS，但數分鐘以上的暫停、反覆播放／下載切換、Android 背景凍結與實際 HEVC 尚無等價證據。
2. **真實紅果 HEVC 1080p**：以前有限量探測的 CDN 曾回 HTTP 403；需合法有效 206 來源 + 有 HEVC MSE 解碼的裝置，才能實測 EOF 前起播、影音、seek/完整播畢。無法由 synthetic HEVC FFmpeg proof 推得 Windows/Android 支援。
3. **Android Firefox／Windows HEVC 實機、真實 ByteVC2 正例**：目前無實機/有效授權來源，均 NOT TESTED。ByteVC2 decoder ABI + 普通 H264 負例 PASS 不等於真實影格；BVC2 仍是整檔 MEMFS → x264、有損、實驗性，不是即時無損串流。
4. 記憶體：1800s MSE 有界可證，但 process-tree RSS 只是粗估；長時間暫停、反覆切集、系統 GPU RAM/Android 電耗尚缺實證。

## 下一個工程動作

- **短期 paused-backpressure E2E 已完成**。接下來針對更長暫停/反覆切集、來源 403 與 HEVC 裝置解碼能力的錯誤分類，以及可授權真實片源驗收；只有出現具體失敗才讀必要 Actions log。
- 暫停 PASS 已同步到 [CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)；繼續合法真實 HEVC 及 ByteVC2 bitstream 正例驗收，無來源/裝置不得宣稱完成。
- 避免更動 `scripts/cenc-stream-remux.c`、BVC2 C bridge 或 pinned WASM 二進位，除非能一同重建 manifest 並完整跑 WASM proof；不可以只提交 C 源碼卻沿用舊二進位。
- 永遠使用最新 `main` SHA 和 path blob SHA 做寫入，不覆寫其他 agent 的同時提交；**文件 checkpoint 寫完不是停工條件**。

## 最新工程 checkpoint（階段 39，2026-11-13）

- main 程式修復：[`618bbab`](https://github.com/IvanaGyro/hongguo-dl/commit/618bbab523513ff01ce60143752616c75cc90bf5) 修正 HEVC 單測括號；[CI #43289090142](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43289090142) **completed/success**，包含 Bun 全測試、雙 WASM verify、Vite Pages build、Wrangler dry-run 與 Worker cold-start；本地 Node `--check` PASS。
- [Pages #43289089908](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43289089908) 查詢時 **in_progress**，不是 PASS；後續 docs 或 code push 可能取消早一個 deploy。
- **立即恢復點**：審查 `src/player.js` 對 HEVC 使用泛用 `hvc1` `canPlayType` 的 guard，與 `src/cenc-remux.js` 精確 `hvc1.<profile>...` MSE 判斷的語意，補回歸測試並直接 main 提交。不得用 HEVC MIME 宣告成功推論實際解碼或真實素材驗證。

## 最新工程 checkpoint（階段 40，2026-11-13）

- 新程式碼 main [`08258a8`](https://github.com/IvanaGyro/hongguo-dl/commit/08258a841183b67311c53672a37ac3315cfe960d)：修正 HEVC 在來源選擇時被泛用 `hvc1` `canPlayType` 否決的問題。採用 Main/Main10 **完整 MSE MIME 暫定探測**，實際接受仍以有界 moov hvcC + 精確 MSE 為準；不推論硬體解碼。新增三個 `tests/hevc-rendition.test.mjs` 回歸，本地等價 Node 測試 3/3 PASS。
- 新 [CI #43289873073](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43289873073)、[Pages #43289873079](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43289873079)、[Browser #43289873014](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43289873014) 首次查詢均 **in_progress**；不得冒稱 PASS。上一程式修補的 [CI #43289090142](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43289090142) 確實 PASS。
- **立即恢復點**：檢查 clear fMP4 init HEVC hvcC/sample entry 與建立的 SourceBuffer MIME 一致性，驗證 Seek 帶入同一完整 codec；有具體錯誤才修。真實紅果 HEVC / Android / ByteVC2 正例仍 NOT TESTED。

## 最新工程 checkpoint（階段 41，2026-11-13）

- main [`1b9cb3d`](https://github.com/IvanaGyro/hongguo-dl/commit/1b9cb3d484b63f2f980f7dfb9a1a6afe289d3f6d)：對 clear HEVC fMP4 init 的 sample entry (`hev1`/`hvc1`) 與 hvcC 精確 MIME 做有界一致性檢查，拒絕缺失/錯誤 codec，在 MSE append 前分類錯誤並清理 Worker。新增四個 Node/Bun 單測。
- [CI #43290337102](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43290337102) **PASS**（Bun 全測試 + Vite build + WASM manifest + worker cold-start）；[Pages #43290337124](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43290337124) **PASS**。
- [WASM proof #43290337070](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43290337070) 首次查詢仍 `in_progress`、[Browser #43290337304](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43290337304) `pending`。不能視為 real HEVC / Android 解碼證據。
- **立即恢復點**：增加數分鐘暫停、反覆切集及 abort pending ACK/Range 的定向壓力測試；必要時修 lifecycle。真實授權 HEVC 206/Android/Windows 與 ByteVC2 bitstream 仍 NOT TESTED。
