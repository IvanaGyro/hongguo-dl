# Hongguo DL — 目前狀態（2026-11-13；PR #7 已合併、真實 HEVC WASM 解碼 PASS）

> **當前焦點：真正紅果片源在瀏覽器的首影格／音訊**。不要把合成 Browser PASS 混為真實播放 PASS。使用者另有 agent 實作 BVC2 串流及下載，本交接範圍不修改 BVC2；仍直接提交 `main`，不開新的 PR。絕不記錄 signed URL、密鑰、影片 bytes、Cookie。

## 目前實證（優先於歷史階段 74–78）

- **PR #7 已合併**：[PR #7](https://github.com/IvanaGyro/hongguo-dl/pull/7)，merge SHA [49ba72a](https://github.com/IvanaGyro/hongguo-dl/commit/49ba72a876d03ce76f18e247fb85b6605a03133a)。修正 Worker cancel→terminate 的 MOV race，不改 decoder/WASM。主分支 [CENC Browser #43343712331](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343712331) **fast/long completed/success**；Chromium/Firefox rapid seek + 3 mode cycles 各 0 MOV warnings，AAC PCM post-seek Chromium 25 個視窗非靜音、Firefox 24 個，MSE URL／Range 清理通過。[Issue #6](https://github.com/IvanaGyro/hongguo-dl/issues/6) 已關閉。
- **真實加密 HEVC 206／moov/hvcC 已 PASS**：[ae0db3e](https://github.com/IvanaGyro/hongguo-dl/commit/ae0db3e24b74cf491e325571dd65a8c91087db76) 改有限多集數新鮮 source 的 bounded probe；[Live #43343959663](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343959663) **PASS**：前兩集共 4×403，第 3 集候選 1 成功 2×206；6 requests／requested 556730 bytes。真實第 3 集 1080p encrypted HEVC `hvc1` + AAC、KID/hvcC 有效、非分段、fileSize 8594279。拒絕不是普遍性故障，**更換集數／候選可得到 206**。
- **真實紅果 HEVC CENC 解密→WASM→fMP4→FFmpeg 實際影格／AAC 解碼 PASS**：[70a4a2b](https://github.com/IvanaGyro/hongguo-dl/commit/70a4a2b7f2ba998293d45494ba9c46adda3780cd) 新增獨立 [Real HEVC WASM #43344492452](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43344492452) **completed/success**：fresh episode 3 候選 1/2、episode 1 候選 1 得 403；episode 1 下一候選成功，**35×206、3×403，38 requests，總 requested 9098695 bytes**。8,277,562 bytes 的真實 CENC HEVC 檔經 pinned Librempeg WASM 有界 Range 產生**56 個 fMP4 media fragments**，第一個完整片段在僅存取最高 755303 bytes 時出現，**尚未讀完 EOF**；clear fMP4 8,099,216 bytes，FFprobe 1920×1080 HEVC + AAC，FFmpeg `-xerror` 實際解出至少 12 個 HEVC 影格與 3 秒 AAC。真實輸出只保存在 Actions runner `/tmp`，step trap 刪除，無 artifact。
- **真實瀏覽器 HEVC MSE 仍 NOT VERIFIED**：[Browser capability check](https://agent.tinyfish.ai/runs/f0d73805-8310-485f-8975-1197331a691f) 實際 headless browser `MediaSource.isTypeSupported` HEVC + AAC / Main10 + AAC 都 **false**，H264 + AAC true；不應在不能解 HEVC 的環境硬播並誤判回歸。此前真正部署站第 1 集 360p ByteVC2 HTTP403、0:00 無畫面仍為歷史證據，**但不可因此否認現已證實的 HEVC 解密／解碼**。
- **階段82 macOS Apple Silicon／WebKit 真實 Browser 嘗試**：[f116988](https://github.com/IvanaGyro/hongguo-dl/commit/f116988b901ba3d1f8881f8d97a923905457552b) 新增 `tests/live-hevc.webkit.mjs` 與獨立 `macos-15` runner [WebKit #43345639384](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43345639384)，**目前結果 PENDING，不能宣稱 PASS**。能力檢查先於任何影片請求；若 macOS WebKit HEVC MSE 不支援，明確記 `NOT TESTED`；若支援，選 1080p HEVC、觀察真實影格回呼/播放時鐘、HTTP status 計數（不輸出任何簽章 URL/key）。主 [CI #43345639451](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43345639451)、[Pages #43345639414](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43345639414) success。macOS WebKit headless 不能當成所有 Apple Safari/Windows/Android 相容證據。
- **最新驗收連結**：PR #7 main [CI #43343712325](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343712325)、[WASM #43343712362](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343712362)、[Browser #43343712331](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343712331) fast/long 全 PASS；real WASM commit [CI #43344492415](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43344492415)、[Pages #43344492519](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43344492519) PASS。

## 下一優先

1. **真正 HEVC MSE 有支援的環境**（Windows/Android：須先實測 `MediaSource.isTypeSupported` 用源片 hvcC 精確 MIME，不能以 bare hvc1 宣稱）；對真實 1080p CENC 使用原播放器，驗首影格 EOF 前、聲音、pause/seek/resume、end。在這之前 browser playback = **NOT VERIFIED**。
2. 若真實 browser 403，優先輪替候選 CDN 和 refresh API source，有 206 的候選已證實存在；尊重 429 立即停損，不繞過來源授權。注意來源簽章時效，**不要在 CI/log 保存 URL/key**。
3. ByteVC2 streaming/download 是其他 agent 的進行中工作；本階段不碰其 Worker、transcoder、播放器 BVC2 路徑。
4. [Issue #8](https://github.com/IvanaGyro/hongguo-dl/issues/8) 保持 open，結論聚焦 browser first frame/音訊，**不再宣稱所有真實 HEVC Range 都無法接取**。

詳細：[REAL-PLAYBACK-ACCEPTANCE.md](REAL-PLAYBACK-ACCEPTANCE.md)、[AGENT-PROGRESS.md](AGENT-PROGRESS.md)、[CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)。
