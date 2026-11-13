# Hongguo DL — 目前狀態（2026-11-13，階段 71）

> **工程規範**：直接提交 `main`，不建立 PR。新改動應有針對性測試，區分 pending／success／failure；不記錄 signed URLs、金鑰或真實私有媒體。每階段更新 AGENT-PROGRESS，保持交接短版。

## 近期可證實結果

- **階段 71：下載佇列 pagehide 生命週期修正**：[04c60c4](https://github.com/IvanaGyro/hongguo-dl/commit/04c60c4b6df8a5fd218f07979573bea76d3c383b) 新增 `src/queue-lifecycle.js` 可測試的集中清理：abort active jobs、停止 retry timers、abort bulk export；`src/main.js` pagehide 將未完成項目標記 `INTERRUPTED` 並持久化，`pump` 在頁面暫停期間不啟新工作、BFCache 返回後不自動重試。補 `tests/queue-lifecycle.test.mjs` 覆蓋五種 busy 狀態及 idempotence，並防止 abort 後的 late success/error 覆寫狀態。**此版 [主 CI #43333897868](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43333897868) completed/success、[Pages #43333897778](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43333897778) success**；Firefox #43333897837 與 CENC Browser #43333897775 最後查詢仍未完成。這是隊列主程式關閉改動，無解碼器修改。

- **階段 70**：[2652b17](https://github.com/IvanaGyro/hongguo-dl/commit/2652b17e23f73119dc5354e73b1874c9aa843045) 修正播放頁 `pagehide`：儲存進度、取消預取、主動 `disposeSource()`（終止 CENC Worker／Range／MSE URL），並透過 token 防止舊 callback 復活。BFCache `pageshow.persisted` 返回時重開同一集且保持暫停、保留 1.25× 等設定。Firefox 瀏覽器測試新增合成 `pagehide/pageshow` 驗證。**Firefox #43333339704 和 CENC Browser fast #43333339682 已 completed/success**，long 在先前查詢仍 in_progress；主 CI #43333339692、Pages #43333339698 completed/success。
- **前一個完整 CENC Browser 實證**：[Browser #43302492613](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43302492613) fast/long 都 completed/success：Chromium/Firefox 初次與 5 個遠距 Seek、90% reload、3 次 mode cycles 後實際 AAC PCM 有聲，55s 跳轉保持 1.25×；Chromium 有 8 個 MOV 診斷僅發生於過渡階段，steady/PCM 無警訊，Firefox 為 0；120s pause Range 9→9、300s/1800s 合成片完整播畢並有界 MSE。
- **MOV 訊息**：轉為獨立 [Issue #6](https://github.com/IvanaGyro/hongguo-dl/issues/6)，附重現，暫不再擴充 AAC 路徑。
- **WASM proof**：[WASM #43298585708](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43298585708) 70s H264/AAC 7、35、55、63s seek、FFmpeg `-xerror` 解碼及 direct vs 256KiB HTTP window clear-fMP4 byte parity PASS；1080p synthetic HEVC 的 WASM→FFmpeg 正例已通過。

## 後續優先

- 核對階段71 Firefox download/queue 流程及 CENC Browser 完整結果，有失敗先讀確切 job logs 再修。
- stage71 已處理下載佇列 pagehide／active jobs／重試計時器／批次匯出。下一步應找另一個可觀測、與影音解碼無關的需求缺口；不要為了測試數量而擴張已通過的項目。
- 目前 **NOT TESTED**：可合法取得 HTTP 206 的真實紅果 HEVC CENC、Windows／Android 裝置 HEVC MSE 實播與 AAC、真正 ByteVC2 bitstream 成功解碼／CPU/RAM。CI 合成正例不可代替這些驗收。

詳盡進度：[AGENT-PROGRESS.md](AGENT-PROGRESS.md)、[CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)。

**文件更新不是停止條件。**
