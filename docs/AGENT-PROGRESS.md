# Hongguo DL — 交接與進度日誌

> **固定交接入口**：任何 agent 接手本專案，請先閱讀本文件與 [CENC 技術決策](cenc-progressive-to-fmp4.md)，再檢查最新 Git SHA；勿依賴聊天摘要判定最新進度。
>
> **更新規則**：每完成一個可獨立驗證的階段、合併、發布或重大失敗排查，立即提交本文件。列出分支、提交、已實作、已驗證、未驗證、阻礙及下一步。CI 執行中不得寫成成功；避免輪詢 Actions log 卡住。若被中斷，以本文件為交接依據。
>
> 日期：2026-11-12（Asia/Taipei）。

## 階段 1 — 核實既有 AVIO/MSE 分支並準備合併（完成）

- 使用者要求合併 `feature/cenc-avio-mse-stream` 至 `main`，並且明確要求每完成一階段即持續寫入進度。
- 原始分支 HEAD：`0423e485b5866a75cb23ac5e5b5d975a106d50f9`（本文件新增前）。
- 當時 `main` HEAD：`3ef80fa70208473fc6754324558fb75db1890fd0`。
- 兩支從 `9f6a4257d0645b4d7d130837c9b460e277336921` 分岔：feature 多出 29 commits、main 多出 2 commits。
- 唯一「main 獨有」檔案改動是誤先新增、功能重複且未驗證的 `scripts/cenc-stream-remux.c`、`scripts/build-cenc-stream-wasm.sh`；**合併必須採用 feature 已測試的兩份檔案，不能覆蓋成 main 的較早實驗版本**。
- Feature 已實作：Librempeg Asyncify 自訂 AVIO + HTTP Range Worker、clear fMP4 片段組裝與 MSE 播放、播放路徑整合、建置與原生／瀏覽器測試、`public/cenc` WASM。
- 確認 GitHub Actions 成功（檢查 jobs 結論，不等候完整日誌）：
  - [Asyncify WASM + synthetic HEVC/AAC CENC](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43220527985)：**success**。
  - [Chromium/Firefox synthetic H.264/AAC 首影格於下載完前呈現](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43224107343)：**success**。
- 兩項 CI **不是**真實紅果 HEVC 1080p 或 Android Firefox 實機成功證據；真實播放、跨片段 seek、長片記憶體仍未完成。
- 下一步：安全合併 feature 的內容，保留雙親提交歷史，並更新本文件「階段 2」記錄 merge SHA；再次確認新 main 的兩個關鍵原始碼與 feature 相同。

## 後續階段（待填）

- 階段 2：合併 main — 待寫。
- 階段 3：合併後 CI／部署確認 — 待寫。
- 階段 4：實際 1080p HEVC + CENC 早期起播、seek、Android Firefox 驗證 — 尚未完成。

## 待解決風險與驗收條件

- **實際 HEVC**：在支援 HEVC/MSE 的設備上首影格於來源 EOF 前出現，且音畫同步。H.264 合成 CI 不可取代真實 HEVC。
- **ByteVC2**：現有路徑仍為全檔輸入／全檔轉碼，尚未真實影格驗證；不得混入 CENC 無損轉封裝的成功敘述。
- **瀏覽器能力**：Firefox/Chromium 的合成 H.264 測試不代表 Android 或各瀏覽器都支援 HEVC。
- **記憶體和 seek**：壓力測試 300 秒以上，防止 Range、MSE 與 WASM 同時累積整片；測試取消、切集、續播與範圍跳轉。
- **來源憑證**：記錄 log 時禁止輸出實際 CENC key、簽章 URL、影片資料；僅報告 HTTP 狀態、編碼、分段與簡化錯誤類別。

## Agent 接手順序

1. `git fetch origin`，核對 `main` 和 `feature/cenc-avio-mse-stream` 最新 HEAD；先讀本文件最新已完成階段。
2. 確認 `scripts/cenc-stream-remux.c`、`scripts/build-cenc-stream-wasm.sh`、`src/cenc-remux-worker.js`、`src/cenc-remux.js`、`src/fmp4-assembler.js` 的版本，以及相關 Actions workflow。
3. 只在有需要時打開**失敗**作業的必要日誌，不要反覆輪詢尚未完成的 log。若工作中斷，先提交本文件記錄可驗證成果。
4. 任何「已完成」都須附 SHA 或 Actions run；未驗證項目應清楚標示。
