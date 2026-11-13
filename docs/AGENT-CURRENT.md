# Hongguo DL — 目前狀態（2026-11-13，階段 73）

> **工程規範**：直接提交 `main`，不建立 PR。新改動應有針對性測試，區分 pending／success／failure；不記錄 signed URLs、金鑰或真實私有媒體。每階段更新 AGENT-PROGRESS，保持交接短版。

## 近期可證實結果

- **階段 73：批次 ZIP 匯出 Service Worker 啟動／ACK 可取消**：[4d34056](https://github.com/IvanaGyro/hongguo-dl/commit/4d340566b0536dff867ce389f96d0c49d4032831)：`triggerArchiveDownload` 改接收 `AbortSignal`，在 SW register、ready、controllerchange、MessageChannel ACK 等待及 fallback 讀取時都能中止；已移交但未開始下載的 SW ZIP 記錄可透過 `{cancel:id}` 刪除；**取消不得觸發記憶體 fallback 或下載 anchor**。新增 `tests/archive-download.test.mjs`（故意阻塞 SW.ready、SW ACK 的取消回歸）。[主 CI #43336436570](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43336436570) **completed/success**；[Firefox #43336436624](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43336436624)、[CENC Browser #43336436548](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43336436548) 初查未完成。未修改影音編碼器與 ZIP 格式。

- **階段 72：下載取得片源 API 也傳遞 AbortSignal + 真實導覽測試**：[2c334e0](https://github.com/IvanaGyro/hongguo-dl/commit/2c334e079079e6c8ddd57d8d9c6ac307c60cc63a) 修正 `src/main.js:runJob` 原先呼叫 `getSource` 少傳 `signal` 的問題；新增 `tests/queue-pagehide.firefox.mjs`：延遲 `/api/source` 模擬在途請求，驗證 synthetic pagehide 確實觸發 AbortError、佇列保留 `INTERRUPTED`、BFCache 模擬返回後不自動重試、**只有使用者點擊重試才新發送 source**；接著執行真正的 `about:blank` 導覽並 `goBack()`，驗證返回後佇列不復活。測試記錄 `pageshow.persisted`，可能是 BFCache，也可能是 reload，兩者須區分；**不宣稱一定實際命中 BFCache**。Firefox CI workflow 已納入新 E2E。**[Firefox #43335942046](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43335942046) completed/success**：合成延遲 API 的 abort、手動重試、真正歷史導覽均 PASS；`pageshow.persisted=false`，**實際是 reload，不能宣稱 BFCache hit**。[主 CI #43335942065](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43335942065) success；CENC Browser #43335941895 需另確認。

- **階段 71：下載佇列 pagehide 生命週期修正**：[04c60c4](https://github.com/IvanaGyro/hongguo-dl/commit/04c60c4b6df8a5fd218f07979573bea76d3c383b) 新增 `src/queue-lifecycle.js` 可測試的集中清理：abort active jobs、停止 retry timers、abort bulk export；`src/main.js` pagehide 將未完成項目標記 `INTERRUPTED` 並持久化，`pump` 在頁面暫停期間不啟新工作、BFCache 返回後不自動重試。補 `tests/queue-lifecycle.test.mjs` 覆蓋五種 busy 狀態及 idempotence，並防止 abort 後的 late success/error 覆寫狀態。**此版 [主 CI #43333897868](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43333897868) completed/success、[Pages #43333897778](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43333897778) success**；[Firefox #43333897837](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43333897837) 與 [CENC Browser #43333897775](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43333897775) fast/long 現已全數 completed/success。這是隊列主程式關閉改動，無解碼器修改。

- **階段 70**：[2652b17](https://github.com/IvanaGyro/hongguo-dl/commit/2652b17e23f73119dc5354e73b1874c9aa843045) 修正播放頁 `pagehide`：儲存進度、取消預取、主動 `disposeSource()`（終止 CENC Worker／Range／MSE URL），並透過 token 防止舊 callback 復活。BFCache `pageshow.persisted` 返回時重開同一集且保持暫停、保留 1.25× 等設定。Firefox 瀏覽器測試新增合成 `pagehide/pageshow` 驗證。**Firefox #43333339704 和 CENC Browser fast #43333339682 已 completed/success**，long 也已 completed/success；主 CI #43333339692、Pages #43333339698 completed/success。
- **前一個完整 CENC Browser 實證**：[Browser #43302492613](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43302492613) fast/long 都 completed/success：Chromium/Firefox 初次與 5 個遠距 Seek、90% reload、3 次 mode cycles 後實際 AAC PCM 有聲，55s 跳轉保持 1.25×；Chromium 有 8 個 MOV 診斷僅發生於過渡階段，steady/PCM 無警訊，Firefox 為 0；120s pause Range 9→9、300s/1800s 合成片完整播畢並有界 MSE。
- **MOV 訊息**：轉為獨立 [Issue #6](https://github.com/IvanaGyro/hongguo-dl/issues/6)，附重現，暫不再擴充 AAC 路徑。
- **WASM proof**：[WASM #43298585708](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43298585708) 70s H264/AAC 7、35、55、63s seek、FFmpeg `-xerror` 解碼及 direct vs 256KiB HTTP window clear-fMP4 byte parity PASS；1080p synthetic HEVC 的 WASM→FFmpeg 正例已通過。

## 後續優先

- 核對階段73 Firefox archive download/ZIP E2E 和 CENC Browser 結果；若失敗，先看確切 log 修正，不降低原有測試門檻。
- stage71 已處理下載佇列 pagehide／active jobs／重試計時器／批次匯出。下一步應找另一個可觀測、與影音解碼無關的需求缺口；不要為了測試數量而擴張已通過的項目。
- 目前 **NOT TESTED**：可合法取得 HTTP 206 的真實紅果 HEVC CENC、Windows／Android 裝置 HEVC MSE 實播與 AAC、真正 ByteVC2 bitstream 成功解碼／CPU/RAM。CI 合成正例不可代替這些驗收。

詳盡進度：[AGENT-PROGRESS.md](AGENT-PROGRESS.md)、[CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)。

**文件更新不是停止條件。**
