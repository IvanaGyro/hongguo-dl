# 紅果真實影片播放驗收：五輪實測（2026-11-13）

> 此文件記錄**真實公開片源**與**合成 CI** 之間的差異。目標是能實際呈現第 1 個影格、音訊非靜音、時間前進、能 Seek 並播畢；不能將 API 有片源、HTTP 200、WASM 可啟動，或 MSE synthetic PASS 視為真實播放成功。

## 結論

**目前狀態：真實 HEVC 已成功經 pinned Librempeg WASM 解密／轉封裝，FFmpeg 真實 HEVC 影格與 AAC 解碼 PASS；但尚未在支援 HEVC MSE 的瀏覽器驗到實際畫面與聲音。** 以下原始五輪紀錄保留當時的失敗背景（早期兩個候選沒有 206、360p ByteVC2 曾 HTTP403），**不再代表目前沒有真實 206**。後續驗收已在第 3 集取得合法 206/CENC metadata，更進一步在第 1 集候選成功完成 EOF 前的 fMP4 串流輸出與 FFmpeg 解碼。真正 Browser playback 仍未驗證成功。

## 2026-11-13 後續正例（高於原始五輪的歷史狀態）

- [PR #7](https://github.com/IvanaGyro/hongguo-dl/pull/7) 已合併，CENC Worker teardown race 修復。[主 Browser #43343712331](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343712331) Chromium/Firefox fast/long success，取消/Seek 後 MOV warning 0，AAC PCM 恢復非靜音，沒有改動音訊解碼器本身。
- [真實 HTTP206 #43343959663](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343959663) completed/success：輪流 refresh 4 集中可公開存取的 HEVC 來源；集 1/2 共 4 候選回 403；集 3 第一候選成功 2×206，有效 CENC KID、`hvc1`/hvcC、AAC、fileSize **8,594,279 bytes**。6 Range requests，requested **556,730 bytes**，無保存 URL/key。
- [真實 pinned WASM + FFmpeg #43344492452](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43344492452) completed/success：實際另一次 refresh 先 3 個 403，**集 1 下一候選返回合法 206**。正式 pinned Librempeg Asyncify WASM（未解碼影像的 compressed packet copy）接真實有界 Range，input **8,277,562 bytes**，輸出 clear fMP4 **8,099,216 bytes／56 fragments**。**第一個完整 media fragment 在來源最高存取 755,303 bytes 時即完成，明顯在 EOF 之前。** 後續 FFprobe 確認 HEVC 1920×1080 + AAC，FFmpeg `-xerror` 真實解碼 **12 個 video frames、3 秒 AAC**，兩者成功。
- **剩餘**：[實際 browser codec capability](https://agent.tinyfish.ai/runs/f0d73805-8310-485f-8975-1197331a691f) 此測試瀏覽器 `MediaSource.isTypeSupported` 對 HEVC+AAC／HEVC Main10+AAC 都是 `false`，對 H264+AAC 是 `true`。因此未用此不支援的瀏覽器強制測 HEVC 第一影格。瀏覽器實際播放、HEVC 硬體／系統解碼、聲音、Seek 與播放到 EOF **仍未驗證**。
- 真實媒體僅存於 CI runner 暫存檔並以 trap 清除；沒有上傳 artifact、輸出簽章 URL／content key／KID。以上是有效真實片源 **WASM pipeline PASS**，**非真實 browser playback PASS**。

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
