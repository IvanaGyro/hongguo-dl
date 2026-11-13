# Hongguo DL — 目前狀態（2026-11-13；真實 1080p HEVC WebKit 起播 PASS）

> **重要：真實瀏覽器的 HEVC 首影格已證實成功；真實 AAC PCM／遠距 Seek／整集播畢仍待驗收。** 不要把各種不同通過條件混成「全部功能完成」。使用者有另一個 agent 專責 ByteVC2 串流／下載；本工作不修改 ByteVC2。直接提交 `main`、不開新 PR；不得記錄 signed URL、CENC 金鑰、KID、Cookie、影片或原始音訊資料。

## 已完成且有實測證據

- **PR #7 合併：CENC Worker teardown 與 Chrome 音訊回歸**：[PR #7](https://github.com/IvanaGyro/hongguo-dl/pull/7) merge [49ba72a](https://github.com/IvanaGyro/hongguo-dl/commit/49ba72a876d03ce76f18e247fb85b6605a03133a)，修正取消 Worker 時的 MOV 錯誤競態；[CENC Browser #43343712331](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343712331) fast/long PASS，Chrome/Firefox 快速 Seek/三輪切換的 MOV warning **0**、AAC PCM 非靜音、Range/MSE cleanup 完成。[Issue #6](https://github.com/IvanaGyro/hongguo-dl/issues/6) closed。
- **真實 HTTP 206 + CENC metadata**：[live bounded #43343959663](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343959663) PASS，依序從新的官方 `/api/source` 候選中找到可合法回應 206 的來源：前四筆 403、第三集候選 206，驗 KID、hvcC、AAC，無紀錄 URL/key。
- **真實 HEVC WASM 解密／無損轉封裝 + 嚴格 FFmpeg 解碼**：[real #43344492452](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43344492452) PASS：第一集 HEVC/AAC 原片 8,277,562 bytes，僅拿約 755,303 bytes 的範圍已產生首個 fMP4 media fragment（EOF 前）；總共 56 fragments，FFmpeg `-xerror` 12 個真實 HEVC frames／3 秒 AAC 解碼 PASS；runner /tmp 清除、無媒體 artifact。
- **真實 macOS M1 WebKit 1080p HEVC 瀏覽器解碼首影格 PASS**：初測 [#43346260353](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43346260353) FAIL：MSE 合法 appends 15 次，但 `video.buffered=[0.16,41.979]`，`currentTime=0`、`readyState=1`、0 frames；測試中僅跳到 0.20s 後 [#43346943578](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43346943578) PASS，證明開頭少量 PTS gap 是可重現阻礙。
- **正式產品修正驗收已 PASS，無測試端手動跳轉**：[cenc startup fix 6816825](https://github.com/IvanaGyro/hongguo-dl/commit/6816825538ac99dc56aeed7c566da52572b59ae7)、[mock guard f511684](https://github.com/IvanaGyro/hongguo-dl/commit/f5116843e28fca557a76b794a50b3f1e7733f722)：僅首次 HEVC 從 t=0 起播、當 MSE 第一個 buffered start 落在 0.01–0.5s 才對齊 clock；**不改非零 seek、續播或 H264**。來源第一個 403 可有限切換同畫質/編碼 HEVC CDN 候選 [4197d58](https://github.com/IvanaGyro/hongguo-dl/commit/4197d586374dc1c22ac541c1a19bf8871f38e586)，拒絕自動掉級 ByteVC2、無 429 重試。**[WebKit #43348194611](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43348194611) SUCCESS**：真實第一集 1920×1080，13×206、1×403，`readyState=4`、`currentTime=0.513`、20 個 decoded frames／5 次 requestVideoFrameCallback、MSE errors 0、mediaError null，**測試沒有改 video.currentTime**。
- **合成回歸**：source startup/candidate 補上單元測試，[CI #43347816517](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43347816517)、[Firefox #43347816707](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43347816707) success；真實 macOS 第一影格另獨立驗證。

## 正在進行與下一步

- [extended WebKit #43348620976](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43348620976) **PENDING**：在真實 WebKit 第一影格 PASS 之後，使用受信任瀏覽器 click 建立 Web Audio Analyser，只報 RMS／非靜音窗數（不記錄 PCM）；再真正 seek 到原緩衝外的 120 秒，檢查 Range remux、timestamp、播放與影格。這是下一個最重要的實測，不可在完成前宣稱 AAC／遠距 Seek 真實 PASS。
- **再往後**：驗證 reload resume、完整播放 EOF、長時間記憶體與不同裝置（Windows/Android HEVC MSE），仍需裝置與真實來源存取條件。
- **來源策略**：同個集數／不同 CDN 在同一時段可混合 HTTP403/206（皆已實測）；優先使用官方 API 已授權且可存取候選，最多有限輪替，不繞過來源限制；HTTP429 直接停損。
- **BVC2 分工**：使用者另有 agent 實作串流/下載，這裡只維護 HEVC CENC、驗收腳本與相關文件，不碰其演算法/worker/介面。

詳細：[REAL-PLAYBACK-ACCEPTANCE.md](REAL-PLAYBACK-ACCEPTANCE.md)、[AGENT-PROGRESS.md](AGENT-PROGRESS.md)、[CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)、[Issue #8](https://github.com/IvanaGyro/hongguo-dl/issues/8)。
