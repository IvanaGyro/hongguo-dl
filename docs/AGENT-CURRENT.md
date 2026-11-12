# Hongguo DL — 目前狀態（接手時先讀；2026-11-13）

> **本檔是短版「現在應做什麼」索引，不替代 [AGENT-PROGRESS.md](AGENT-PROGRESS.md) 的可追溯歷史、[測試矩陣](CENC-TEST-MATRIX.md) 或 [技術架構](cenc-progressive-to-fmp4.md)。**
>
> **使用者的固定要求**：直接提交 `main`，不開 PR；每完成一個可驗證工程階段，立即更新 AGENT-PROGRESS（記 commit、PASS/FAIL/PENDING 和 run URL）並繼續做下一階段。**GitHub 的讀取、寫入、Actions 等各種操作都有可能卡住**：不要在同一操作或等待中的 run 上無限制重試／輪詢。若受阻先留下最小可恢復 checkpoint。

## 目前已經成功，不要重做

- **CENC 架構**：既有 Librempeg Asyncify AVIO、bounded HTTP 206 Range、CENC decrypt、HEVC/AAC 無損 stream copy、clear fMP4 MSE；WASM 與 manifest SHA256/build provenance 由 CI/Pages 防止版本錯配。
- **瀏覽器合成正例**：Linux Chromium/Firefox 以 H.264/AAC 加密 progressive MP4 真正顯示影格（HTTP EOF 前），55s 遠距 Seek、7→63→35→5→63s 往返、reload 續播及播放/下載模式切換 PASS。[Browser #43279166406](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279166406)。
- **合成 HEVC 1080p**：1920×1080 HEVC/AAC CENC progressive → pinned Librempeg WASM clear fMP4，FFmpeg 解碼成功，來源 EOF 前首 fragment，6s indexed RAP seek PTS PASS。[WASM #43279575089](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279575089)。**不等於真實瀏覽器 HEVC 解碼成功**。
- **30 分鐘完整播放**：[Browser #43283216947](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283216947)，合成 480×270 H.264/AAC 1800.021s、ended=true、videoError=null、104 HTTP Range、MSE span 最高 72s、ahead 43.56s；首影格時僅取得 6.6% 來源。Linux test harness + browser process-tree RSS first/peak/last 802.5/838.8/838.2 MiB，**不是 Android/GPU RAM**。
- **修正完成**：先前 1800s 因 `moov >1MiB` 導致 KID 未取得、HTTP 416 整檔 fallback；現以有界 8MiB 元資料限制和超限非重試錯誤修復並在上述 1800s synthetic PASS。
- **近期程式修補與回歸**：
  - ByteVC2 Worker startup cancellation / postMessage failure 及 7 單測：`b57923f`、`90603dd`、`8f9d4c7`，[CI #43284208866](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43284208866) PASS。
  - CENC Worker 同步啟動失敗釋放 Object URL / terminate；故障注入單測 `a4ac231`，[CI #43285460654](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43285460654) PASS。
  - ByteVC2 **本機授權正例驗收工具**新增輸出影音 start/end ±1.5s 時間軸檢查與 5 單測，`54fd067`、`cc9474c`、`d241153`，[CI #43285897450](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43285897450) PASS。**尚無真正 ByteVC2 正例樣本！**
  - CENC/BVC2 HEAD 檢測初次失敗不再永久 memoize，成功才快取，同時請求 single-flight；`b8149ce`、`7297b2c`、`e3fd0a2`、`205dc02`，[CI #43286523179](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43286523179) PASS。**不要使用中間有錯誤 regex 的 `effd215` 作為基準**。

## 仍待驗證／不可誤報

1. **暫停時網路背壓 E2E**：`tests/cenc-stream.browser.mjs` 已新增 `CENC_TEST_PAUSE=1`，並在 `7b46f19` 的 workflow 啟用 300s 合成案例。**須從含該 workflow 變更的 browser run 讀到實際 `PASS chromium paused CENC HTTP Range backpressure and playback resume` 才可標 PASS。** 已完成的 Browser #43285003886 屬更早一版（`b4d9440`），沒有啟用該旗標，不能當證據。[Browser #43285424033](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43285424033) / [#43286523184](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43286523184) 為後續有旗標的候選 run，前次確認仍 in_progress / pending；**重新讀當次狀態後再更新**。
2. **真實紅果 HEVC 1080p**：以前有限量探測的 CDN 曾回 HTTP 403；需合法有效 206 來源 + 有 HEVC MSE 解碼的裝置，才能實測 EOF 前起播、影音、seek/完整播畢。無法由 synthetic HEVC FFmpeg proof 推得 Windows/Android 支援。
3. **Android Firefox／Windows HEVC 實機、真實 ByteVC2 正例**：目前無實機/有效授權來源，均 NOT TESTED。ByteVC2 decoder ABI + 普通 H264 負例 PASS 不等於真實影格；BVC2 仍是整檔 MEMFS → x264、有損、實驗性，不是即時無損串流。
4. 記憶體：1800s MSE 有界可證，但 process-tree RSS 只是粗估；長時間暫停、反覆切集、系統 GPU RAM/Android 電耗尚缺實證。

## 下一個工程動作

- 優先**僅查一次**含 `CENC_TEST_PAUSE=1` 的最新已完成 Browser run，讀該 job 的 PASS 或具體失敗行；若失敗，修最小 bug、補回歸、提交 main。不要被 Actions 查詢卡住。
- 若已 PASS，將 `docs/CENC-TEST-MATRIX.md` 的 pause case、`AGENT-PROGRESS.md` 新 checkpoint 更新，並繼續處理來源 403 / HEVC 解碼路徑的錯誤分類、可授權樣本的最小實機驗收。
- 避免更動 `scripts/cenc-stream-remux.c`、BVC2 C bridge 或 pinned WASM 二進位，除非能一同重建 manifest 並完整跑 WASM proof；不可以只提交 C 源碼卻沿用舊二進位。
- 永遠使用最新 `main` SHA 和 path blob SHA 做寫入，不覆寫其他 agent 的同時提交；**文件 checkpoint 寫完不是停工條件**。
