# Hongguo DL — 專案進度與當前目標

更新：2026-11-13。**這是唯一的進度／交接文件**；歷史階段與失敗紀錄保留於 Git history，不再另外維護逐次流水帳。CENC、ByteVC2 的設計細節仍分別放在 [CENC 技術說明](cenc-progressive-to-fmp4.md)、[ByteVC2 技術說明](bvc2-wasm.md)。

## 階段總覽

| 大階段 | 狀態 | 主要成果／界線 |
| --- | --- | --- |
| **1. 網頁產品與下載流程** | 已完成核心 | GitHub Pages + Cloudflare Worker、播放／畫質選擇、佇列、ZIP/MP4、取消與進度恢復；仍需真實 Android Firefox 大批次驗收 |
| **2. CENC 低延遲串流核心** | 已完成核心 | HTTP 206 有界讀取、Librempeg WASM 解密並無損轉封裝 fMP4、MSE 播放、跨緩衝 Seek／續播、背壓／清理；合成 Chromium／Firefox 及 1800 秒壓測通過 |
| **3. 真實 HEVC 端到端播放** | **目前階段：部分通過** | 真實 CDN 206、真實 HEVC/AAC 轉封裝／FFmpeg 解碼、macOS WebKit 1080p 首影格與 120 秒遠距 Seek 通過；**瀏覽器實際 AAC 聲音、reload 續播、整集播畢尚未通過完整驗收** |
| **4. ByteVC2 串流與下載** | PR #10 整合／驗收中 | 五種輸出與增量串流已實作；增量播放須以 `bvc2_stream=experimental` 明確選用。長片合成驗收與真實 BTY2、裝置記憶體仍待確認 |
| **5. 跨裝置與產品穩定性** | 待驗收 | Windows／Android 的 HEVC 能力與實播、真實長片 RAM／CPU、弱網、來源過期與跨模式回歸 |

## 當前階段 Goal

**證明真實紅果 HEVC 1080p 在支援 HEVC MSE 的瀏覽器可以穩定觀看**：來源合法可讀、EOF 前有真實畫面、音訊確實可輸出、遠距跳轉與重新開啟能恢復、影片能播畢。區分「來源 403／429」、「裝置不支援」、「媒體管線故障」與「測試工具誤判」，**不以 CI 綠燈或單一指標代替完整驗收**。

### 已確認的實測證據

- **來源／解密**：公開來源可能同時出現 403 和 206，有限輪替新取得、相同畫質／編碼的候選可找到合法 206；[真實 metadata 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343959663) **PASS**。不得對 429 持續請求。
- **真實檔案轉封裝與解碼**：[實際 WASM + FFmpeg 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43350204732) **PASS**，來源 EOF 前就產生 fMP4；真實 HEVC 影格可解，AAC 經 FFmpeg 解碼在 0 秒及 120 秒區間有非靜音音量。**這不直接證明 WebKit 的音訊輸出**。
- **真實瀏覽器畫面／Seek**：[macOS WebKit 首影格](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43348194611) **PASS**：1080p、實際解碼影格、時間前進、無 media error；[延伸實測](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43349532681) **120 秒未緩衝 Seek 與後續影格 PASS**，但整個 job 因 AAC 測量未通過而是 failure。
- **WebKit MSE Web Audio 測量已判定不可靠**：[合成對照及真實 HEVC 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43354990348) 中，已知有聲的 native MP4 RMS=0.089815，但**同一 AAC 的 H.264 MSE RMS=0**；真實 HEVC MSE 亦為 0，兩者影片均正常前進。這符合 [WebKit Bug 266922](https://bugs.webkit.org/show_bug.cgi?id=266922) 和 [Bug 256445](https://bugs.webkit.org/show_bug.cgi?id=256445) 已知的 `MediaElementAudioSourceNode`／MSE 問題。**不能用 MSE RMS=0 推論實際無聲；真實裝置能否聽到聲音仍 NOT TESTED**。瀏覽器已看到第一畫格；當次 120 秒 Seek 測試因誤用舊累計影格判定而失敗，已修正等待新影格並重新驗證中。
- **合成回歸**：[PR #7](https://github.com/IvanaGyro/hongguo-dl/pull/7) 已合併，CENC Worker 結束競態修復後 Chromium MOV 警訊歸零，Chromium／Firefox 反覆 Seek 的 AAC PCM 回歸通過；與真實 WebKit 音訊驗收分開記錄。

## Pending work（依優先順序）

1. **P0 — 確認實際可聽的音訊輸出**：已用完全合成的 native MP4／H.264 MSE 對照證實 WebKit `MediaElementAudioSourceNode` 無法可靠量測 MSE AAC；請改用可收聽／OS 音訊 loopback 的真實裝置，驗證聲音及音畫同步。勿因 Web Audio RMS=0 修改 AAC 管線。
2. **P1 — 完成真實 HEVC 播放旅程**：保留已通過的起播／120 秒 Seek；補真實 reload 續播、播到 EOF、重複切集／取消，並觀察音畫同步與資源使用。
3. **P2 — 實際裝置與來源穩健性**：Windows／Android 有 HEVC MSE 能力的瀏覽器實播，沒有能力時正確提示；對來源 403、429、過期、Range 失敗做有限重試與可理解的訊息，測試弱網及記憶體。
4. **平行工作 — ByteVC2**：PR #10 已新增明確 opt-in 與大於 512 KiB 的真正長 VVC 編碼合成素材，用來驗證 EOF 前第一影格、未緩衝 Seek、取消及五種輸出；CI 仍須通過。這不是實際 BTY2 正例，真實來源與 CPU/RAM 仍待驗收。

## 工作原則與驗收入口

- 一般改動直接提交 `main`（若使用者特別指定 PR，依當次要求）；變動先跑對應單元、建置與 GitHub Actions，再更新**本文件**。避免同時編輯 ByteVC2 agent 負責的程式。
- 真實 HEVC：[WebKit 端到端](../.github/workflows/live-hevc-webkit.yml)、[有界 WASM／FFmpeg 驗證](../.github/workflows/live-cenc-wasm-proof.yml)；合成回歸：[CENC Browser CI](../.github/workflows/cenc-browser.yml)。使用者可追蹤 [Issue #8](https://github.com/IvanaGyro/hongguo-dl/issues/8)。
- **安全與判定**：測試只用有權存取的來源；不保存 signed URL、金鑰、Cookie 或影片片段；PASS、FAIL、NOT TESTED 分開陳述。過往細節由 Git history／Actions 查證，不再累積逐 commit 日誌。
