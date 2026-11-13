# 紅果真實影片播放驗收：五輪實測（2026-11-13）

> 此文件記錄**真實公開片源**與**合成 CI** 之間的差異。目標是能實際呈現第 1 個影格、音訊非靜音、時間前進、能 Seek 並播畢；不能將 API 有片源、HTTP 200、WASM 可啟動，或 MSE synthetic PASS 視為真實播放成功。

## 結論

**真實紅果影片：FAIL / 尚未驗證成功播放。** 針對既有公開測試系列 `7699513062054710296` 的第 1 集，瀏覽器 1080p HEVC / 360p ByteVC2 測試均**沒有**取得可見的第一個影格或向前的播放時間。360p 實播得到上游媒體 HTTP 403；bounded 1080p HEVC metadata probe 的兩個候選都無法建立可驗證的 HTTP 206 範圍回應。這些是當下環境的觀察，**不能因此宣稱所有紅果影片都不能播放，也不能把 HTTP 403 當作解碼器失敗。**

## 五輪工作與證據

| 輪次 | 實作或驗收 | 結果／證據 | 剩餘界限 |
|---|---|---|---|
| 1. 真實網站自動播放 | 部署站 `https://ivanagyro.github.io/hongguo-dl/`，載入 60 集《nova：新星》並點第 1 集，等候 20s+ | **FAIL**：0:00/0:00、無影格；曾停在 ByteVC2→H.264 實驗轉碼。實測記錄 [Browser run 2f5dc5e8](https://agent.tinyfish.ai/runs/2f5dc5e8-f69f-49e6-b7e5-3ba0f62c0d65) | 無法單靠此判定是沒有 source、正在等全片或 decoder 不支援 |
| 2. 真實來源與 206 接取 | 使用者現有 Worker 的公開 `/api/series` 與 `/api/source`（只萃取 codec/quality/加密布林，不保存 URL/key），對第 1 集最多兩個 HEVC 候選作 1MiB/request、6 request／總 3MiB 上限的 metadata probe | API 顯示 **1080p encrypted HEVC**、720/540/480/360p encrypted ByteVC2（10 個候選）。[main 3184c85](https://github.com/IvanaGyro/hongguo-dl/commit/3184c85815868ae3299ef177586967a4d2f59f9d)，[live run #43339207034](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43339207034) **FAIL**：嘗試 2 個候選，取得 0 筆合格 206／0 筆 HTTP status；2 個 transport/probe 錯誤，名目請求 bytes 131072 | GitHub runner 上 20 秒逾時、非已確認 403；無 HEVC moov / hvcC 真實正例 |
| 3. ByteVC2 轉碼階段定位 | 修改 Worker 發送 WASM loading/ready、transcoding、finalizing 實際階段，播放器顯示來源整檔下載進度並說明這不是 EOF 前起播 | [main 1b8b080](https://github.com/IvanaGyro/hongguo-dl/commit/1b8b080b5bb90a146b7d9922a627de6d43186755)；[CI #43339401291](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43339401291) 與 [Firefox #43339401187](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43339401187) success | 本階段只改善正確診斷；未實作 ByteVC2 真正串流或證明真實 frame decode |
| 4. 360p 最低畫質實播 | 真實網站同第 1 集選 360p，觀察約 60 秒；檢查重試與真正 source response | **FAIL**：上游媒體 **HTTP 403**，播放 0:00/0:00、無影格；出現 1/5～5/5 相同錯誤後停止。[Browser run 35c95408](https://agent.tinyfish.ai/runs/35c95408-2dd2-4e25-9977-573cd58caa70) | 這是可觀察的來源拒絕，不能證明 ByteVC2 codec 本身無法解；亦未驗證所有公開集數 |
| 5. 存取錯誤分類與回歸 | Worker 區別 upstream 403、429 與解碼錯誤，避免把 HTTP 403 顯示成 BVC2 問題；前端相容舊 Worker 的 MEDIA_HTTP 403／429 訊息；對 429 停止重試，新增錯誤與無私有 URL 洩漏單元測試 | [main a74869f](https://github.com/IvanaGyro/hongguo-dl/commit/a74869f4500c16c9cb07d9845958098492102e85) 及 [main 63a2733](https://github.com/IvanaGyro/hongguo-dl/commit/63a27334dd6d8eaef17b3618e75a74c3cebf6adb)；前者 [CI #43339962640](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43339962640) success，後者 CI/Pages 以實際 Actions 結論為準 | 分類與 UI 修正**不能解除上游 403 存取限制**；Worker 更新必須獨立部署，前端可先正確分類舊 Worker 回應 |

## 如何重現真實播放（不需任何金鑰）

1. 開啟已部署網站 `https://ivanagyro.github.io/hongguo-dl/?id=7699513062054710296`，等待《nova：新星》60 集 metadata 載入，選「播放」和第 1 集。
2. 在「畫質」明確選 1080p 觀察是否走 encrypted HEVC MSE（請先檢查瀏覽器實際 HEVC MSE/硬解能力）。若裝置不支援 HEVC，記錄 **UNSUPPORTED**，不可視為 remux FAIL。
3. 在非 HEVC 的環境明確選 360p、ByteVC2。觀察「整集下載％」→ WASM loading → ready → transcoding → finalizing；這**不**是串流播放路徑。若收到 HTTP 403，記 **SOURCE_FORBIDDEN**，不要當作 decoder FAIL。
4. 成功驗收需要 `video.readyState` 至少有影格資料，顯示非黑畫面、`video.currentTime` 確實前進、音訊可聽或 PCM 真實非靜音；最後還要測 seek、resume、EOF。有明確觀察結果前，不宣稱 PASS。
5. 在外部 log 僅記 HTTP status、`Range/Content-Range` 合法性、編碼類型、畫質、成功/失敗階段與耗時；**不要記錄 signed media URL、API contentKey、Cookie、影片 payload 或 KID**，也不要為了繞過 403 修改來源授權驗證。

## 阻礙分類與下一步

- **P0：來源驗證** — 測試有權使用、可回應 206 的實際公開媒體來源；若 403，確認是否簽章過期、官方存取限制、來源防盜鏈、區域限制或代理出口限制，**不得假設是哪一種**。應由有權的使用者或可合法測試的環境提供來源。
- **P1：真實 HEVC** — 在 HEVC MSE 能力已確認的 Windows/Android 瀏覽器，經 HTTP 206 → 真實 moov/hvcC/AAC → CENC remux → 真正影格與聲音。GitHub Linux synthetic H264 長測 PASS 不是這條路徑 PASS。
- **P2：真實 ByteVC2** — 第一次成功解碼出真正 frame 前，不應宣稱實驗性 x264 整檔轉碼可用。當前單執行緒同步 WASM 需要完整來源，不能 EOF 前起播。後續需明確決定分段/串流編碼設計、CPU/RAM、真實輸出解碼、音畫同步。
- **P3：自動畫質體驗** — 若 HEVC 不可用且只有 ByteVC2，顯示「需整檔轉碼」的實際等待階段與取消，而不是假裝影片已開始播放；根據有效來源及裝置能力選擇，不要默默以無法解碼的來源取代使用者的畫質設定。

**目前總判定：真實播放 FAIL；合成 CENC 已 PASS；真實片源讀取與 ByteVC2 解碼仍 NOT VERIFIED。**
