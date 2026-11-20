# Hongguo DL — 專案進度與當前目標

更新：2026-11-16。**這是唯一的進度／交接文件**；歷史階段與失敗紀錄保留於 Git history，不再另外維護逐次流水帳。CENC、ByteVC2 的設計細節仍分別放在 [CENC 技術說明](cenc-progressive-to-fmp4.md)、[ByteVC2 技術說明](bvc2-wasm.md)。

## 階段總覽

| 大階段 | 狀態 | 主要成果／界線 |
| --- | --- | --- |
| **1. 網頁產品與下載流程** | 已完成核心 | GitHub Pages + Cloudflare Worker、播放／畫質選擇、佇列、ZIP/MP4、取消與進度恢復；仍需真實 Android Firefox 大批次驗收 |
| **2. CENC 低延遲串流核心** | 已完成核心 | HTTP 206 有界讀取、Librempeg WASM 解密並無損轉封裝 fMP4、MSE 播放、跨緩衝 Seek／續播、背壓／清理；合成 Chromium／Firefox 及 1800 秒壓測通過 |
| **3. 真實 HEVC 端到端播放** | **目前階段：部分通過，Seek 回歸不穩定** | 真實 CDN 206、真實 HEVC/AAC 轉封裝／FFmpeg 解碼、macOS WebKit 1080p 首影格已通過；120 秒遠距 Seek 曾 PASS，但最新 CI 停於 86.65 秒而 FAIL。**瀏覽器實際 AAC 聲音、reload 續播、整集播畢皆未完成驗收** |
| **4. ByteVC2 串流與下載** | 實驗性實作已合併 | PR #10 已合併；五種輸出、953 KiB 合成來源 EOF 前起播與 24 秒未緩衝 Seek 皆通過。真實 BTY2 與實際裝置仍未驗收；播放一律先走增量串流，整集轉碼僅在增量路徑不可用時作為備援（Issue #22 已移除 `bvc2_stream` 網址參數） |
| **5. 跨裝置與產品穩定性** | 待驗收 | Windows／Android 的 HEVC 能力與實播、真實長片 RAM／CPU、弱網、來源過期與跨模式回歸 |

## 當前階段 Goal

**證明真實紅果 HEVC 1080p 在支援 HEVC MSE 的瀏覽器可以穩定觀看**：來源合法可讀、EOF 前有真實畫面、音訊確實可輸出、遠距跳轉與重新開啟能恢復、影片能播畢。區分「來源 403／429」、「裝置不支援」、「媒體管線故障」與「測試工具誤判」，**不以 CI 綠燈或單一指標代替完整驗收**。

### 已確認的實測證據

- **ByteVC2 → VVC 無損重新封裝（2026-11-20）**：Librempeg `bvc2` 與 `vvc` 解碼器共用同一套 H.266 解碼／CBS 語法，差異只在 `bvc2`／`bv2C` 封裝；來源為 ByteVC2 且選 VVC 時，`bvc2_convert` mode 3 改為把 NAL 長度改寫成 start code 後以 `vvc1`／`vvcC` 輸出，不經 VVenC，失敗才退回重新編碼（`bvc2_last_remuxed()` 可查）。本機以 emsdk 3.1.74 重建並發布 WASM；合成 BVC2 兩種 `bv2C` 佈局均重新封裝成功，Annex B NAL 序列與原始 VVC 逐位元組相同、原生 Librempeg VVC 解碼 96 影格，約 150–180 ms（重新編碼約 4.7 s）；Chromium 五種下載輸出通過。**真實 ByteVC2 片源尚未驗證**：當日 App 片源接口（部署與本機 Worker、多部影集）皆回 HTTP 200 空響應，與 11/16 起 Live Worker smoke 失敗一致。
- **影集續播／順播與 CI 行為契約（2026-11-16）**：新增每影集的最後播放游標，保留舊逐集歷史的遷移；輸入影集 ID 或點歷史影集會直接播放並續播。自然下一集／下一集按鈕從零開始，手動選集沿用該集位置；就緒才寫入新的觀看起點，避免舊零時間保護恢復過往時間。下一集 WASM 從零預備，手動交接可沿用 Worker／raw cache seek 到保存處。本機單元 **317 PASS**；Chromium 操作流程已驗證送出即播、reload／跨影集游標及可信自然 EOF 後從零；Chromium／Firefox 實際 CENC 自動／手動預載交接分別驗證約 0 秒／第 4 秒起播且不重取媒體。Firefox ByteVC2 已確認第二個 MSE 是下一集未掛載預載（closed、0 buffer），目前影片 open／1 buffer；切下載後清單為空，五種輸出均通過。CI 改驗證 MSE 所有權與清理、CENC 分步驟文字，保留首影格與下載限制；增加原生操作流程及手動預載續播案例。

- **匿名裝置重用與 Beta 播放等待提示（2026-11-16）**：裝置資料由瀏覽器 localStorage 保存，與代理 Worker 網址無關；新增 POST /api/device 初始化／背景更新，正常 App 取源以標頭沿用 did／iid／安裝識別。更新保留既有 ID，6／12 小時為更新排程而非到期日；空白 200 不再觸發換裝置。移除取源固定間隔、全域佇列及跨請求拒絕狀態。註冊、各 App API 及媒體 UA 的設定集中於 device-profile.js，App 版本統一為已分析 APK Manifest 的 7.4.5.32／74532；SDK 協定與硬體樣板不冒稱已抓包確認。提示只顯示當前前景等待層，必要下載未命中才覆蓋處理提示，背景預載不覆寫；重試開始不再帶前次錯誤前綴。Beta 文字分出裝置註冊、網頁／App 片源畫質候選查詢、CDN 候選、MP4 檔頭／moov／byte 範圍與必要影片下載，預載候選耗盡不再直接終止前景播放：交接會在剩餘額度內重新查畫質／片源，僅試新 URL，真正滿額則顯示 PLAYBACK_STEP_LIMIT。各步驟嘗試次數獨立、含預載，最多 20 次；可多輪刷新新的同畫質 URL，若沒有新候選仍提早停止。429 依 Retry-After 倒數後重試同一候選；APK 尚無完整 429 runtime 證據。101 集 Log 指向 CDN 開頭 64 KiB 慢／卡住，metadata 改為 10 秒閒置期限＋30 秒總上限，避免晚到的 206 標頭吃掉本文預算。**本機驗證 PASS**：317 個單元測試、前端 build、Worker dry-run、Chromium 裝置跨 reload／跨使用者隔離與 502 恢復提示、原生 no-referrer／403 代理接續、實際 CENC WASM 的慢速來源、24→25 預載復原、預載耗盡後前景取得新候選恢復、舊 URL 不重送及滿 20 次不追加查詢。**尚未驗證**：新識別重用策略在真實 CDN／連看情境是否減少 502；真實 CDN／裝置仍須另行驗收；Worker 部署需另外執行。設計見 [播放資料流](playback-data-flow.md)。

- **來源／解密**：公開來源可能同時出現 403 和 206，有限輪替新取得、相同畫質／編碼的候選可找到合法 206；[真實 metadata 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43343959663) **PASS**。429 須等待服務端 Retry-After 或有界退避，不能無等待連續重送。
- **真實檔案轉封裝與解碼**：[實際 WASM + FFmpeg 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43350204732) **PASS**，來源 EOF 前就產生 fMP4；真實 HEVC 影格可解，AAC 經 FFmpeg 解碼在 0 秒及 120 秒區間有非靜音音量。**這不直接證明 WebKit 的音訊輸出**。
- **真實瀏覽器畫面／Seek**：[macOS WebKit 首影格](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43348194611) **PASS**：1080p、實際解碼影格、時間前進、無 media error；[延伸實測](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43349532681) **120 秒未緩衝 Seek 與後續影格 PASS**，但整個 job 因 AAC 測量未通過而是 failure。
- **WebKit MSE Web Audio 測量已判定不可靠**：[合成對照及真實 HEVC 驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43354990348) 中，已知有聲的 native MP4 RMS=0.089815，但**同一 AAC 的 H.264 MSE RMS=0**；真實 HEVC MSE 亦為 0，兩者影片均正常前進。這符合 [WebKit Bug 266922](https://bugs.webkit.org/show_bug.cgi?id=266922) 和 [Bug 256445](https://bugs.webkit.org/show_bug.cgi?id=256445) 已知的 `MediaElementAudioSourceNode`／MSE 問題。**不能用 MSE RMS=0 推論實際無聲；真實裝置能否聽到聲音仍 NOT TESTED**。瀏覽器已看到第一畫格；已修正遠距 Seek 舊影格計數誤判，並在 [WebKit 重新驗收](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43355534407) 中再次 **PASS** 120 秒新影格；有聲輸出仍明確為 `NOT TESTED`。
- **最新 WebKit Journey CI 失敗（不可視為端到端 PASS）**：[run #43356037576](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43356037576) 已完成、結論 **FAIL**。第一個真實集數取得來源遇到六次 403；改測另一集後，1080p 首影格與時鐘前進通過（觀測到 206 × 4、403 × 7）。但 120 秒遠距 Seek 等候後，`currentTime=86.65`、`buffered=[40.52,115.45]`、`mediaError=null`，未達目標且測試斷言失敗。**這只證明這次 Seek 未成功，尚不能斷定根因是 CDN、WASM、MSE 或測試計時；reload／續播／實際 EOF 因先前斷言失敗未執行。**
- **合併與合成回歸**：[PR #7](https://github.com/IvanaGyro/hongguo-dl/pull/7) 已合併，CENC Worker 結束競態修復後 Chromium MOV 警訊歸零，Chromium／Firefox 反覆 Seek 的 AAC PCM 回歸通過；[PR #9](https://github.com/IvanaGyro/hongguo-dl/pull/9) 已合併，包含 CDN 403 有界重試、載入狀態與整檔備援警告；[PR #10](https://github.com/IvanaGyro/hongguo-dl/pull/10) 已合併。合成結果與真實 WebKit 驗收分開記錄。

## Pending work（依優先順序）

0. **P0 — 修復 1080p HEVC 串流起播卡頓與不必要的整集下載 fallback（新增）**：使用者實測「正在取得影片來源…」耗時過長，且 CENC→fMP4/MSE 可能被整片下載取代。先於頁面底部增加可複製的安全診斷 Log，量測來源、Range、WASM、MSE 與媒體事件；接著追查串流為何失敗。將 1080p HEVC 略過無關的 ByteVC2 WASM 探測；來源失敗不轉用全片備援（#23 起整檔備援只在處理失敗時啟用，含 HEVC）。**使用者實機 Log（2026-11-13）已收到**：第 13 集來源 API 約 6.7 秒，6 次 1080p HEVC metadata Range 均 HTTP 403；第 42 集 API 約 4.2 秒，備選來源 206、成功解密並產生 fMP4，1920×1080 首影格與約 13.52 秒 MSE buffer 均成立，但第 3／6 個 Worker 媒體 Range 失敗（舊版只記 `RANGE_ERROR`，尚不知該段 HTTP 狀態），隨後 MSE 報解碼錯誤。已在 `main` 加入精確 Worker Range HTTP 錯誤代碼與可複製記錄、兩次上限的「先有成功 206 才重試中途 403」、僅同畫質 HEVC 官方來源輪替、候選耗盡最多刷新 API 一次、429 禁止重試；1080p 不再檢查無關 ByteVC2 資產，也不再偷偷整集下載。另外定位到 Worker `/api/source` 在 `quality=auto&codec=auto` 時會先檢查網頁版來源（timeout 4.5 秒），再透過 App API 取得多種畫質；與實測 API 耗時 4.2–6.7 秒相符，但仍需新 Log 才能量化各項延遲。**目前所有畫質與編碼查詢統一從 App 取得完整來源清單，篩選由前端處理；同一集跨畫質重用來源快取，不使用任意 30 秒期限，僅媒體失敗／候選耗盡時刷新。** **尚待真實瀏覽器再次驗收，不能宣稱已修復所有 CDN 403 或穩定播畢。** CDN 403／206 根因與重試政策另以 [Issue #11](https://github.com/IvanaGyro/hongguo-dl/issues/11) 追蹤，與端到端驗收 Issue #8 區分。
1. **P0 — 確認實際可聽的音訊輸出**：已用完全合成的 native MP4／H.264 MSE 對照證實 WebKit `MediaElementAudioSourceNode` 無法可靠量測 MSE AAC；請改用可收聽／OS 音訊 loopback 的真實裝置，驗證聲音及音畫同步。勿因 Web Audio RMS=0 修改 AAC 管線。
2. **P1 — 修復 Seek 偶發失敗並完成真實 HEVC 播放旅程**：起播與早先的 120 秒 Seek 曾 PASS；最新 [WebKit Journey CI](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43356037576) 在約 90 秒等候後仍停在 86.65 秒（buffered 只到 115.45 秒），**不得把先前 PASS 當作穩定通過**。先針對 Seek 期間的 HTTP Range／片段請求、WASM 解密與轉封裝耗時、MSE append／buffered／`waiting` 事件做分階段時間戳與失敗分類，再重跑真實 120 秒 Seek；`tests/live-hevc-journey.mjs` 已實作 reload／進度恢復／實際 EOF 驗收，但此次因前置 Seek 斷言失敗而**未執行，不是通過或失敗**。重複切集／取消、音畫同步與資源使用仍待實機驗收。
3. **P2 — 實際裝置與來源穩健性**：Windows／Android 有 HEVC MSE 能力的瀏覽器實播，沒有能力時正確提示；對來源 403、429、過期、Range 失敗做有限重試與可理解的訊息，測試弱網及記憶體。
4. **ByteVC2 驗收**：[PR #10](https://github.com/IvanaGyro/hongguo-dl/pull/10) 已合併；[合成長樣本測試](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43355352198) **PASS**：953,299-byte 來源、第一個完整 fMP4 片段於傳輸 96,504 bytes 時產生；瀏覽器首影格於 913,904 bytes 出現（約 96%，性能仍需改進），24 秒未緩衝 Seek、五種輸出、取消清理通過。真實 BTY2、音畫同步、CPU/RAM 仍待驗收。

- **來源並行與前端快取（2026-11-13）**：前端以 `/api/health.sourceChannels` 決定新版 `channel=web|app` 並行或舊版循序查詢；第一個有效結果先嘗試播放，較慢的結果追加候選／更新選單。App 來源在 `main` 的 Worker 已移除 `quality`、`codec` 查詢參數與篩選，前端每集共用一份不寫入磁碟的來源快取；切畫質不再重取 source。播放選單依當集已知來源動態建立；下載模式**取第一個 `available=false` 集數的來源**初始化整批共用的動態畫質選單，個別集數不符合所選畫質時由該下載工作報錯。**正式 Worker 仍須另行部署**（GitHub Actions 僅做 dry-run），發布前舊版 Worker 因前端固定用 `auto/auto` 仍可相容；來源 API 延遲與真實全片播放還需驗收。
- **CDN 直連與代理備援（2026-11-13）**：播放 CENC HTTP Range／ByteVC2 增量串流、一般 MP4 及下載流程，先檢查/使用 CORS 可讀的直連 CDN；CORS 或 Range／存取拒絕時改用 `/api/media` 代理，429 不藉切換代理規避。僅在同一 URL「直連失敗但代理成功」後，才於頁面工作階段偏好該主機走代理。正式 GitHub Pages origin 對單一**未受限制第 2 集**全 5 候選實測：直連 **403×5**、代理有效 **206×5**；對第一個**可能受限制第 6 集**全 10 候選實測：直連 **403×10**、代理 **403×10**。`channel=web` 皆未找到公開片源。測試只讀 16 bytes/URL，不代表整集播放成功；詳細證據見 [Issue #11](https://github.com/IvanaGyro/hongguo-dl/issues/11)。測試頁已從正式 Pages 移至 `tests/manual-cdn-cors-probe.html` 保存，避免公開頁面反覆觸發 CDN 請求。
- **App 空回應重試（2026-11-13）**：`/api/source` 僅接受 `sid`／`vid`／`channel`（舊的多餘 `quality`／`codec` 忽略以相容舊客戶端）；App HTTP 200 空回應改為同一簽署端點最多再試一次、最後再試 legacy，合計最多 3 次、固定短延遲、共享 12 秒 request deadline。僅 `EMPTY_RESPONSE` 重試，403／429／業務拒絕一律不重試。正式 Worker 需另行部署；新增定向測試。
- **「可能受限制」標籤不是播放驗證**：`worker/worker.js` 取官方 `seriesDetail.accessible_episode_cnt`，僅把超出前 N 集的分集標 `available=false`；欄位缺失即未知。下載模式預設不勾選，但仍允許選取／播放，不可直接視為 DRM 或付款證據。網頁片源的 `protectedPlayback`、`publicVideoSeo.available` 僅影響是否接受公開 SEO URL。

## 介面設計

- 深色與淺色主題（頂列按鈕切換，`src/theme.js`；選擇存於 `localStorage` 的 `hongguo-dl-theme-v1`，未選時跟隨系統），樣式集中於 `src/styles.css`（單一檔案），沒有整條頂列。字體為自架的 Chiron GoRound TC（`@fontsource-variable/chiron-goround-tc`，無第三方請求）。
- 四個品牌色即狀態語言：橘 `#FD7528`＝主要動作／正在播放，杏 `#F0B16B`＝進行中，梨綠 `#C4E384`＝已選取（原標誌色 `#BEC891` 彩度偏低，於深色底顯得混濁，故保留色相、提高彩度與明度），薄荷 `#9BDFC0`＝已完成。
- 沒有首頁：開啟即為播放模式，搜尋欄固定在標誌與模式切換之間。既有瀏覽器測試以 `window.__HONGGUO_START_MODE = 'download'`（`addInitScript`）維持原本的下載模式起始條件。
- `index.html` 只調整排列（搜尋列在橘色區塊、模式切換在頂列、設定與診斷集中於頁尾），所有 id 與控制項不變；版面驗收見 `tests/design-layout.browser.mjs`。

## 工作原則與驗收入口

- **下一集媒體預載**：CENC／ByteVC2 增量模式預載下一集實際影片。當本集 WASM 處理完成即開始 lookahead（不必等最後 45 秒）；若處理尚未完成，既有接近結尾門檻仍可先取得索引並啟動原始資料下載。下一集 Worker 的解密／轉封裝／轉碼須等待本集 `mse.done`；下載不受此 CPU gate 限制。預載最多一集、沿用原始資料快取上限（通常 32 MiB），清晰 fMP4 prefix 在 4 MiB 門檻停止 ACK，容許最後一個完整片段跨過門檻。切集重用同一個 Worker、raw cache 與已處理片段，再掛上可見播放器的 MSE；取消／換影集會終止背景 Worker 並釋放 URL。當本集重新進行索引 seek，暫停下一集的片段 ACK，最多讓已在處理的單一片段完成，原始資料下載仍可繼續。整集 BVC2 備援／無法安全預建的 EME 路徑仍只預取 metadata，不把第二個 CDM 掛到本集播放器。新增 `prefetch.begin/stage/prepared/handoff/failed` 紀錄；handoff 後的 stage 重新歸屬目前播放，保留媒體錯誤與效能資訊。CI 用合成加密影片驗證 Chromium／Firefox 的真實第 13→14 集接續、處理先後、重用來源／資料；production worker 證明先完成 raw download 再允許 WASM，且 forward/back seek 繼續使用快取。真實 CDN／Windows 裝置切集延遲與記憶體仍需實測。 原始 HTTP 封包可能跨入檔尾 moov；快取寫入後必須重疊套回 initialRanges 的權威 metadata，避免 ByteVC2 bv2C 正規化被 CDN 原始內容覆寫。production ByteVC2 worker 的「先下載、再轉碼、再前後 seek」已在本機驗證。WebKit Journey 僅對最終停止／不支援狀態提前結束，不能把尚在重試的「失敗」訊息當成最終失敗；首影格、續播時間與真實 EOF 斷言維持。

- **Windows Firefox HEVC 排除調查已定位（2026-11-15）**：使用者的 Surface／Firefox ARM64 在 `about:support` 顯示 `media.hardware-video-decoding.failed=true`、`HARDWARE_VIDEO_DECODING` 被 `FEATURE_FAILURE_SANITY_TEST_FAILED` 封鎖；Profiler 顯示 DXVA disabled/blacklisted、HEVC 無可用 decoder。清除失敗設定並重新啟動後，使用者確認硬體解碼恢復 available 且影片可播。暫時的 HEVC admission 診斷模式已移除，所有入口統一使用正常的瀏覽器支援過濾。保留 metadata codecString、`mse.codec-check` 的 hvc1/hev1 支援結果、`mse.output-codec` 及 EME 失敗名稱，供後續排查；不新增 HEVC 軟體轉碼或整集備援。自我測試最初失敗原因與是否復發仍未知。

- **瀏覽器測試介面契約**：編碼診斷為 `schema: 2`，分開記錄視訊／音訊、合併 MSE 與檔案播放；舊版 `schema: 1` 斷言須同步更新。播放器的原生畫質／速度 `select` 刻意隱藏，互動驗收應使用設定按鈕、第二層選項及關閉按鈕，不可對隱藏 select 使用 `selectOption()`。切換影集／重新載入會重設畫質，測試若要求固定 1080p 應明確經由可見選單選取，不能依賴儲存的畫質偏好。
- **真實 EOF 驗收**：自動下一集永遠開啟；以捕獲階段記錄上一集的可信 `ended` 事件、結尾時間與解碼影格，並檢查該集的完成紀錄，不可假定事件處理後播放器仍停在上一集。不得用人工 `ended` 事件或跳到結尾取代實際播畢。

- 一般改動直接提交 `main`（若使用者特別指定 PR，依當次要求）；變動先跑對應單元、建置與 GitHub Actions，再更新**本文件**。避免同時編輯 ByteVC2 agent 負責的程式。
- 真實 HEVC：[WebKit 端到端](../.github/workflows/live-hevc-webkit.yml)、[有界 WASM／FFmpeg 驗證](../.github/workflows/live-cenc-wasm-proof.yml)；合成回歸：[CENC Browser CI](../.github/workflows/cenc-browser.yml)。使用者可追蹤 [Issue #8](https://github.com/IvanaGyro/hongguo-dl/issues/8)。
- **安全與判定**：測試只用有權存取的來源；不保存 signed URL、金鑰、Cookie 或影片片段；PASS、FAIL、NOT TESTED 分開陳述。過往細節由 Git history／Actions 查證，不再累積逐 commit 日誌。

- **520 背景下載與必要讀取交接（2026-11-16）**：背景 HTTP 失敗到達前若已有解碼器等待，保留等待者並以必要讀取流程重連；不把背景錯誤直接傳給解碼器，也不消耗其重試額度。新增固定時序回歸測試，318 個單元通過；Chromium／Firefox 真實 CENC 520 同位置恢復、不重建 MSE 均通過。CI 斷言允許背景下載停止後恢復或必要讀取重試兩種內部路徑。

- **下載層擁有 CDN／取源策略（2026-11-16）**：download-source-session.js 集中片源查詢、私有 CDN 網址、同畫質候選輪替、失敗名單與刷新額度；第二層只取得不含網址的媒體參照及格式資訊，預載交接沿用第一層同一下載工作，不複製或重設網址狀態。第一層不接收目前播放集數、播放位置或前景／預載身分；只在實際 body I/O 窗口內估算需求速率。速度不足、403／429、5xx、連線逾時等下載失敗不在原 CDN 重試，立即輪替；候選耗盡立即重查片源，仍保留 20 次分步驟上限與舊失敗網址排除。解碼錯誤不淘汰健康來源。329 個單元通過；六種 CENC 慢速／預載恢復、Firefox 520 換源、原生 429 與裝置保存、ByteVC2 轉碼／seek／五種輸出及 MSE 清理、手動預載續播與影集觀看進度均有本機瀏覽器驗證。

- **整檔讀取與備援順序（#23）**：播放備援與下載佇列的整檔讀取改由媒體 Worker 的同一個來源／位元組快取組出（`whole-file` 需求），不再由主執行緒另開下載。備援順序固定為原生 EME → WASM 串流 → 整檔處理，只有處理失敗才往下；CDN 403／429／Range 等來源失敗交由候選輪替。串流不可用或播放中處理失敗時，媒體 Worker 交給整檔備援繼續使用，同一 HTTP 回應與快取不重複下載。本機 Chromium 驗證：串流不可用與播放中 SourceBuffer 失敗兩種備援都只用 1 個媒體請求；Firefox 與真實 CDN 仍待 CI／實測。

- **原生 EME 改走 MSE（#24）**：移除把加密網址交給 `<video src>` 的 `eme-progressive` 路線。已分段 CENC 由媒體 Worker 從快取直通原始加密片段給 MSE，瀏覽器 Clear Key 解密；分段索引支援 `sidx`／`mfra`，沒有索引改走 WASM 串流。MediaKeys 掛上後不再拆除，每集一個 session；金鑰系統失敗時同一個 Worker 改走 WASM 串流。本機 Chromium（GPAC 產生的 H.264/AAC 加密 fMP4）驗證：sidx／mfra／無索引三種起播、未緩衝 seek、下一集 EME 預載交接（1 個請求）、EME 後清晰直播與 WASM 轉封裝在 MediaKeys 已掛上時照常播放、金鑰系統拒絕時改走 WASM。Firefox、HEVC 與真實紅果已分段來源仍待 CI／實測。

- **使用者工作慣例（2026-11-16）**：每次完成程式修改與適當驗證後，自動 commit 並 push 到 main，無須再詢問；commit 訊息包含修改原因及實作方式。僅提交本次工作，保留使用者原有未提交修改。
