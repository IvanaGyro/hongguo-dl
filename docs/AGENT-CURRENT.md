# Hongguo DL — 目前狀態（2026-11-13，階段 70）

> **工程規範**：直接提交 `main`，不建立 PR。新改動應有針對性測試，區分 pending／success／failure；不記錄 signed URLs、金鑰或真實私有媒體。每階段更新 AGENT-PROGRESS，保持交接短版。

## 近期可證實結果

- **階段 70**：[2652b17](https://github.com/IvanaGyro/hongguo-dl/commit/2652b17e23f73119dc5354e73b1874c9aa843045) 修正播放頁 `pagehide`：儲存進度、取消預取、主動 `disposeSource()`（終止 CENC Worker／Range／MSE URL），並透過 token 防止舊 callback 復活。BFCache `pageshow.persisted` 返回時重開同一集且保持暫停、保留 1.25× 等設定。Firefox 瀏覽器測試新增合成 `pagehide/pageshow` 驗證。**此版 Firefox #43333339704 與 CENC Browser #43333339682 查詢時仍在執行**；主 CI #43333339692、Pages #43333339698 completed/success。
- **前一個完整 CENC Browser 實證**：[Browser #43302492613](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43302492613) fast/long 都 completed/success：Chromium/Firefox 初次與 5 個遠距 Seek、90% reload、3 次 mode cycles 後實際 AAC PCM 有聲，55s 跳轉保持 1.25×；Chromium 有 8 個 MOV 診斷僅發生於過渡階段，steady/PCM 無警訊，Firefox 為 0；120s pause Range 9→9、300s/1800s 合成片完整播畢並有界 MSE。
- **MOV 訊息**：轉為獨立 [Issue #6](https://github.com/IvanaGyro/hongguo-dl/issues/6)，附重現，暫不再擴充 AAC 路徑。
- **WASM proof**：[WASM #43298585708](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43298585708) 70s H264/AAC 7、35、55、63s seek、FFmpeg `-xerror` 解碼及 direct vs 256KiB HTTP window clear-fMP4 byte parity PASS；1080p synthetic HEVC 的 WASM→FFmpeg 正例已通過。

## 後續優先

- 核對階段70 Firefox lifecycle 及 CENC Browser 結果，有失敗先讀確切 job logs 再修。
- 繼續檢查**下載佇列的 pagehide、active AbortController、retry timer、bulk export**；避免離開時仍下載、BFCache 返回時自動啟動舊佇列。專注生命週期，不更動現有 codec/muxer。
- 目前 **NOT TESTED**：可合法取得 HTTP 206 的真實紅果 HEVC CENC、Windows／Android 裝置 HEVC MSE 實播與 AAC、真正 ByteVC2 bitstream 成功解碼／CPU/RAM。CI 合成正例不可代替這些驗收。

詳盡進度：[AGENT-PROGRESS.md](AGENT-PROGRESS.md)、[CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)。

**文件更新不是停止條件。**
