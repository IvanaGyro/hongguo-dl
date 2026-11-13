# Hongguo DL — 專案進度與當前目標

更新：2026-11-13。**這是唯一的進度／交接文件**；歷史階段與失敗紀錄保留於 Git history，不再另外維護逐次流水帳。CENC、ByteVC2 的設計細節仍分別放在 [CENC 技術說明](cenc-progressive-to-fmp4.md)、[ByteVC2 技術說明](bvc2-wasm.md)。

## 階段總覽

| 大階段 | 狀態 | 主要成果／界線 |
| --- | --- | --- |
| **1. 網頁產品與下載流程** | 已完成核心 | GitHub Pages + Cloudflare Worker、播放／畫質選擇、佇列、ZIP/MP4、取消與進度恢復；仍需真實 Android Firefox 大批次驗收 |
| **2. CENC 低延遲串流核心** | 已完成核心 | HTTP 206 有界讀取、Librempeg WASM 解密並無損轉封裝 fMP4、MSE 播放、跨緩衝 Seek／續播、背壓／清理；合成 Chromium／Firefox 及 1800 秒壓測通過 |
| **3. 真實 HEVC 端到端播放** | **目前階段：部分通過，Seek 回歸不穩定** | 真實 CDN 206、真實 HEVC/AAC 轉封裝／FFmpeg 解碼、macOS WebKit 1080p 首影格已通過；120 秒遠距 Seek 曾 PASS，但最新 CI 停於 86.65 秒而 FAIL。**瀏覽器實際 AAC 聲音、reload 續播、整集播畢皆未完成驗收** |
| **4. ByteVC2 串流與下載** | 實驗性實作已合併 | PR #10 已合併；五種輸出、953 KiB 合成來源 EOF 前起播與 24 秒未緩衝 Seek 皆通過。真實 BTY2 與實際裝置仍未驗收；增量播放須加 `bvc2_stream=experimental` |
| **5. 跨裝置與產品穩定性** | 待驗收 | Windows／Android 的 HEVC 能力與實播、真實長片 RAM／CPU、弱網、來源過期與跨模式回歸 |

## 當前階段 Goal

**證明真實紅果 HEVC 1080p 在支援 HEVC MSE 的瀏覽器可以穩定觀看**：來源合法可讀、EOF 前有真實畫面、音訊確實可輸出、遠距跳轉與重新開啟能恢復、影片能播畢。區分「來源 403／429」、「裝置不支援」、「媒體管線故障」與「測試工具誤判」，**不以 CI 綠燈或單一指標代替完整驗收**。

### 已確認的實測證據

- **來源／解密**：公開來源可能同時出現 403 和 206，有限輪替新取得、相同畫質／編碼的候選可找到合法 206；[真實 metadata 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343959663) **PASS**。不得對 429 持續請求。
- **真實檔案轉封裝與解碼**：[實際 WASM + FFmpeg 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43350204732) **PASS**，來源 EOF 前就產生 fMP4；真實 HEVC 影格可解，AAC 經 FFmpeg 解碼在 0 秒及 120 秒區間有非靜音音量。**這不直接證明 WebKit 的音訊輸出**。
- **真實瀏覽器畫面／Seek**：[macOS WebKit 首影格](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43348194611) **PASS**：1080p、實際解碼影格、時間前進、無 media error；[延伸實測](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43349532681) **120 秒未緩衝 Seek 與後續影格 PASS**，但整個 job 因 AAC 測量未通過而是 failure。
- **WebKit MSE Web Audio 測量已判定不可靠**：[合成對照及真實 HEVC 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43354990348) 中，已知有聲的 native MP4 RMS=0.089815，但**同一 AAC 的 H.264 MSE RMS=0**；真實 HEVC MSE 亦為 0，兩者影片均正常前進。這符合 [WebKit Bug 266922](https://bugs.webkit.org/show_bug.cgi?id=266922) 和 [Bug 256445](https://bugs.webkit.org/show_bug.cgi?id=256445) 已知的 `MediaElementAudioSourceNode`／MSE 問題。**不能用 MSE RMS=0 推論實際無聲；真實裝置能否聽到聲音仍 NOT TESTED**。瀏覽器已看到第一畫格；已修正遠距 Seek 舊影格計數誤判，並在 [WebKit 重新驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43355534407) 中再次 **PASS** 120 秒新影格；有聲輸出仍明確為 `NOT TESTED`。
- **最新 WebKit Journey CI 失敗（不可視為端到端 PASS）**：[run #43356037576](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43356037576) 已完成、結論 **FAIL**。第一個真實集數取得來源遇到六次 403；改測另一集後，1080p 首影格與時鐘前進通過（觀測到 206 × 4、403 × 7）。但 120 秒遠距 Seek 等候後，`currentTime=86.65`、`buffered=[40.52,115.45]`、`mediaError=null`，未達目標且測試斷言失敗。**這只證明這次 Seek 未成功，尚不能斷定根因是 CDN、WASM、MSE 或測試計時；reload／續播／實際 EOF 因先前斷言失敗未執行。**
- **合併與合成回歸**：[PR #7](https://github.com/IvanaGyro/hongguo-dl/pull/7) 已合併，CENC Worker 結束競態修復後 Chromium MOV 警訊歸零，Chromium／Firefox 反覆 Seek 的 AAC PCM 回歸通過；[PR #9](https://github.com/IvanaGyro/hongguo-dl/pull/9) 已合併，包含 CDN 403 有界重試、載入狀態與整檔備援警告；[PR #10](https://github.com/IvanaGyro/hongguo-dl/pull/10) 已合併。合成結果與真實 WebKit 驗收分開記錄。

## Pending work（依優先順序）

0. **P0 — 修復 1080p HEVC 串流起播卡頓與不必要的整集下載 fallback（新增）**：使用者實測「正在取得影片來源…」耗時過長，且 CENC→fMP4/MSE 可能被整片下載取代。先於頁面底部增加可複製的安全診斷 Log，量測來源、Range、WASM、MSE 與媒體事件；接著追查串流為何失敗。將 1080p HEVC 略過無關的 ByteVC2 WASM 探測，禁止加密 HEVC MP4 靜默轉用全片備援。**使用者實機 Log（2026-11-13）已收到**：第 13 集來源 API 約 6.7 秒，6 次 1080p HEVC metadata Range 均 HTTP 403；第 42 集 API 約 4.2 秒，備選來源 206、成功解密並產生 fMP4，1920×1080 首影格與約 13.52 秒 MSE buffer 均成立，但第 3／6 個 Worker 媒體 Range 失敗（舊版只記 `RANGE_ERROR`，尚不知該段 HTTP 狀態），隨後 MSE 報解碼錯誤。已在 `main` 加入精確 Worker Range HTTP 錯誤代碼與可複製記錄、兩次上限的「先有成功 206 才重試中途 403」、僅同畫質 HEVC 官方來源輪替、候選耗盡最多刷新 API 一次、429 禁止重試；1080p 不再檢查無關 ByteVC2 資產，也不再偷偷整集下載。另外定位到 Worker `/api/source` 在 `quality=auto&codec=auto` 時會先檢查網頁版來源（timeout 4.5 秒），再透過 App API 取得多種畫質；與實測 API 耗時 4.2–6.7 秒相符，但仍需新 Log 才能量化各項延遲。**前端已對明確選擇 1080p 的播放改用既有 `quality=1080p` API（不需重新部署 Worker），以跳過網頁版預探測；部分來源回應不得禁用其他畫質選單。** **尚待真實瀏覽器再次驗收，不能宣稱已修復所有 CDN 403 或穩定播畢。**
1. **P0 — 確認實際可聽的音訊輸出**：已用完全合成的 native MP4／H.264 MSE 對照證實 WebKit `MediaElementAudioSourceNode` 無法可靠量測 MSE AAC；請改用可收聽／OS 音訊 loopback 的真實裝置，驗證聲音及音畫同步。勿因 Web Audio RMS=0 修改 AAC 管線。
2. **P1 — 修復 Seek 偶發失敗並完成真實 HEVC 播放旅程**：起播與早先的 120 秒 Seek 曾 PASS；最新 [WebKit Journey CI](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43356037576) 在約 90 秒等候後仍停在 86.65 秒（buffered 只到 115.45 秒），**不得把先前 PASS 當作穩定通過**。先針對 Seek 期間的 HTTP Range／片段請求、WASM 解密與轉封裝耗時、MSE append／buffered／`waiting` 事件做分階段時間戳與失敗分類，再重跑真實 120 秒 Seek；`tests/live-hevc-journey.mjs` 已實作 reload／進度恢復／實際 EOF 驗收，但此次因前置 Seek 斷言失敗而**未執行，不是通過或失敗**。重複切集／取消、音畫同步與資源使用仍待實機驗收。
3. **P2 — 實際裝置與來源穩健性**：Windows／Android 有 HEVC MSE 能力的瀏覽器實播，沒有能力時正確提示；對來源 403、429、過期、Range 失敗做有限重試與可理解的訊息，測試弱網及記憶體。
4. **ByteVC2 驗收**：[PR #10](https://github.com/IvanaGyro/hongguo-dl/pull/10) 已合併；[合成長樣本測試](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43355352198) **PASS**：953,299-byte 來源、第一個完整 fMP4 片段於傳輸 96,504 bytes 時產生；瀏覽器首影格於 913,904 bytes 出現（約 96%，性能仍需改進），24 秒未緩衝 Seek、五種輸出、取消清理通過。真實 BTY2、音畫同步、CPU/RAM 仍待驗收。

## 工作原則與驗收入口

- 一般改動直接提交 `main`（若使用者特別指定 PR，依當次要求）；變動先跑對應單元、建置與 GitHub Actions，再更新**本文件**。避免同時編輯 ByteVC2 agent 負責的程式。
- 真實 HEVC：[WebKit 端到端](../.github/workflows/live-hevc-webkit.yml)、[有界 WASM／FFmpeg 驗證](../.github/workflows/live-cenc-wasm-proof.yml)；合成回歸：[CENC Browser CI](../.github/workflows/cenc-browser.yml)。使用者可追蹤 [Issue #8](https://github.com/IvanaGyro/hongguo-dl/issues/8)。
- **安全與判定**：測試只用有權存取的來源；不保存 signed URL、金鑰、Cookie 或影片片段；PASS、FAIL、NOT TESTED 分開陳述。過往細節由 Git history／Actions 查證，不再累積逐 commit 日誌。
