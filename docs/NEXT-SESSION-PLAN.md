# 下一個 Session 執行計畫：Hongguo DL 串流播放與穩定性

> **2026-11-12 使用者最新指示（優先於本文件原先的分支／PR 步驟）：此專案之後由 agent 直接在 `main` 提交，不再建立 PR。** 確認 `main` HEAD 與 CI 再逐階段提交 `docs/AGENT-PROGRESS.md`。已開啟的 PR #5 已關閉（未透過 PR 合併），其 23 個提交已直接 fast-forward 到 main；勿重新開啟或建立替代 PR。

更新日期：2026-11-13（Asia/Taipei）
固定交接入口：docs/AGENT-PROGRESS.md。本文件是**下一階段的工作清單與驗收標準**，不是完成報告。
原始評估基準 main：fdb2039e68819334946fbc1fb44c3cafea6d61d6。後續 agent 應重新確認 HEAD。
專案：https://github.com/IvanaGyro/hongguo-dl


## 最新經實證的狀態（2026-11-13；以下優先於歷史計畫）

- **main 基線**：5c3732fd4c4699204269fb81bfa5b5dc8bbfe7dd 時 CI #43283368259 與 Pages #43283367990 成功；此後仍有直接 main 的新提交，最新 commit / 驗收以 [AGENT-PROGRESS.md](AGENT-PROGRESS.md) 為準。
- **Synthetic PASS**：H.264/AAC CENC Chromium/Firefox 首影格於 EOF 前、遠距 Seek 55 秒、10/50/90% 往返、90% reload；Chromium 300s 完整播放（MSE span peak 78.021s，process-tree RSS 粗量測 first/peak/last 約 769.2/769.2/764.1 MiB）；1080p HEVC/AAC WASM stream copy + FFmpeg decode + 6s RAP seek。
- **30 分鐘已驗證**：1800s 首輪因 moov >1MiB 探測失敗，提升至有界 8MiB 並補單元測試後，[Browser #43283216947](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283216947) 實際 **PASS**：Chromium 合成 H.264/AAC 播至 1800.021s ended=true、104 Range、MSE span max 72s、ahead 43.56s；Linux test harness+browser process-tree RSS first/peak/last 802.5/838.8/838.2 MiB，非 Android/GPU RAM。
- **尚無正例**：真實紅果 HEVC 1080p EOF 前可見影格／聲音／完整播放、Android Firefox 解碼與真實 ByteVC2 正例均尚未驗證。ByteVC2 ABI/非 ByteVC2 負例與 bundle pin PASS，**不等同真實可解**。
- **可靠交接**：每個工程階段直接提交 main，隨即新增 AGENT-PROGRESS checkpoint；GitHub 讀取／寫入／Actions 都可能阻塞，避免同一操作無限重試，不等長跑工作完成才記錄已有成果。

## 0. 使用者期望的最終成果（不可縮減成只有 CI 成功）

- 主要架構仍是純前端 GitHub Pages + Cloudflare Worker 反向代理；播放使用 Video.js 10，下載有佇列及 ZIP/MP4 輸出。支援 URL／多個 ID、畫質與編碼選擇、播放進度與續播、自動下一集，尤其 Android Firefox 不應每集跳出存檔框。
- 實際紅果加密非分段 MP4（典型 1080p HEVC + CENC）：無損、低延遲，在來源尚未下載完整前呈現第一個影格，之後可正常聽聲音、暫停、跳轉、續播、完整播畢。裝置不具備 HEVC 解碼能力時須正確降級或提示，不得虛稱支援。
- 720p 以下部分來源是 ByteVC2，不是標準 VVC；必須確認真正解碼器、實測合法樣本、畫質／效能以及播放體驗。切勿用 VVC 解碼器宣稱可直接解 ByteVC2。
- 保持取消與切集可靠、記憶體有界、來源 HTTP Range 受限、敏感 URL 與 key 不寫 log。純前端不代表不能使用 WASM；已建置 Librempeg 無損 CENC remux 和獨立 ByteVC2→H.264 實驗核心。

## 1. 已確認基線（不要重做）

- [PR #4](https://github.com/IvanaGyro/hongguo-dl/pull/4) 已合併 feature/cenc-avio-mse-stream；merge commit bb9d808c32838ff853f305acfd43de8122fb1c8b。
- [Main progressive CENC WASM proof #9](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230424222)：success。合成 HEVC/AAC progressive CENC MP4 → clear fMP4，stream copy、可解碼、來源 EOF 前已有 moof。
- [Main browser acceptance #13](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230870775)：success。合成 H.264/AAC 非分段 CENC MP4，Chromium/Firefox 在 HTTP EOF 前呈現影格，持續播放 >1.5 秒，使用真正 Range/Worker/MSE。
- GitHub Pages 合併部署成功；以上**沒有**驗證紅果真實 HEVC、Android Firefox、任意 seek、300 秒記憶體或真實 ByteVC2。
- 重要現有程式碼：scripts/cenc-stream-remux.c、scripts/build-cenc-stream-wasm.sh、src/cenc-remux-worker.js、src/cenc-remux.js、src/fmp4-assembler.js、src/clear-key.js、src/player.js；驗收：tests/cenc-stream.browser.mjs、scripts/verify-cenc-stream-wasm.mjs。
- docs/cenc-progressive-to-fmp4.md 的舊段落稱「瀏覽器 WASM 尚未實作」，**已過時**；新 agent 必須依主分支程式碼與上述 CI 為準，並同步修正文檔。
- 測試影集 ID 7699513062054710296：先前有界 metadata 探測得知第 1 集 1080p HEVC + CENC 為非分段 MP4（約 8.28 MB，moov 約 260 KiB），第 30 集 720p 是 ByteVC2；真實來源可能失效、被拒或變化，不能假設一定可取得。不要將簽章 URL 或 key 存入 repo。

## 2. 工作順序、產出與驗收

### P0 — 建立可重現基準與測試結果（先做）

1. **直接在 main 開發並提交，不建立 PR。** 先確認 main HEAD 與最近已完成 CI；針對變動執行 bun run test、bun run build，不重複輪詢 GitHub 或重跑無關的歷史試驗。
2. 做測試矩陣：合成 H.264/AAC (Chromium, Firefox)、合成 HEVC/AAC WASM (Node + FFmpeg decode)、真實 HEVC (Windows 有解碼能力的瀏覽器)、Android Firefox、ByteVC2（僅取得合法真實 sample 後）。每欄明確記 PASS / FAIL / NOT TESTED，區分 container、解碼器與 HTTP 問題。
3. 建立明確的起播性能階段紀錄：來源 API、first metadata byte、完整 moov、WASM ready、first moof、MSE append、first presented frame、first audible sample；同時記 Range 次數/總 bytes、buffered 時間、記憶體趨勢。既有 src/player.js 有部分 startup stages，可擴增但別輸出 signed URL 或 key。
4. 檢查 npm/Bun、Emscripten、Librempeg pin 及 GitHub Pages 實際引用的 WASM 二進位版本；不要僅 HEAD 200 就認定 ABI 一致。

**完成條件：** 新測試矩陣與可重現測試命令存 docs，基線版本、受測瀏覽器／平台／編碼及每個結果可追溯。前後變更可以公平比較。

### P1 — 實際 HEVC 1080p 低延遲播放，最高優先

1. 針對使用者已有權存取的測試集，先有限度 probe /api/source、HTTP Range、moov/stsd/hvcC、encrypted CENC scheme、AAC 音軌、key ID；驗證 cdn 206/Content-Range。不要在 CI 預設每次 push 下載真實集數。
2. **已改為結構化 track 檢測**：src/clear-key.js 使用 inspectMp4TrackFormats() 解析 moov/stsd/frma 並回報 hasAac、videoCodec、audioTracks；仍應使用具合法來源的 HEVC Main10、edit list、AAC 變體驗證精確 codec/profile/level，不可單靠 mime 宣告推論實際解碼。
3. 實際 HEVC 解碼可用的瀏覽器進行首影格／音訊測試，區分 MSE.isTypeSupported、canPlayType、WebAssembly 解密正確與影片硬體 decoder 是否存在。FFmpeg 可完整解碼的 fMP4 也不代表每台 Firefox 都支援 HEVC。
4. 如果第一片段的 DTS/PTS、edit list、ctts、sample entry 或 CENC subsample 導致出錯，先比對 FFmpeg/ffprobe 結果、fMP4 boxes，再修正 scripts/cenc-stream-remux.c。不可任意重編碼原始 HEVC 以掩蓋容器問題。

**完成條件：** 至少一個有 HEVC MSE 解碼能力的實際環境以真實 1080p HEVC CENC 顯示影格、音訊正常、在 HTTP EOF 前起播、能正常播畢；有可重現報告／效能數字。若裝置無 HEVC 支援，明確記「平台不可用」，不可誤判 CENC 失敗。

### P2 — 真正的 seek 與恢復播放，最高優先

**已實作並驗證部分能力，以下改為持續回歸要求**：C/WASM 的 cenc_stream_remux_at() 可從 indexed RAP 附近起讀，播放器在未緩衝區 Seek 重建 Worker/MSE。Chromium/Firefox 合成 H.264/AAC 在 55 秒、10%/50%/90% 往返及 reload 恢復均有 PASS（browser #43279166406）。仍缺真實 HEVC/Android 裝置的同等驗收與長片壓力測試。

1. 第一版優先實作「超出 buffered range 時：取消舊 Worker → 在接近目的時間之前最近的可解碼 RAP/IDR 開始 remux → 新 MediaSource」；可在 C 端以 avformat_seek_file/av_seek_frame 搭配新 mux stream，必要時另以 MP4 sample tables 尋找 RAP。
2. 正確處理 timestamp / edit list / audio pre-roll，確保 video.currentTime 與原片時間軸一致。切集、調畫質、上一集／下一集、重新整理恢復時間，不應從 0 秒重新下載到指定時間。
3. 修正續播與播放器事件的競態：媒體時間軸尚未可用時不可覆蓋既存進度，失敗後重新建立資源要恢復最近有效位置，不能一直重啟同一個無效來源。
4. 測試播放中跳到 10%、50%、90%，跨多個片段來回跳、暫停 seek、重新整理續播，以及源站 Range 反覆失敗時的行為。

**完成條件：** 任何 unbuffered seek 都能重新定向 Range（不是從來源 0 一路轉到目標）；在合理時間恢復畫面與聲音，播放進度正確，取消後沒有殘存網路流。

### P3 — 記憶體、錯誤與取消的穩定性，最高優先

經查主要具體風險：

- src/cenc-remux.js **已使用 MSE eviction 與 ahead backpressure**，合成 Chromium 300 秒完整播放且 MSE buffered span 最高約 78 秒；1800 秒合成 Chromium 已 PASS；仍須驗收長時間暫停、真實設備與 quota 錯誤後的可恢復性，不能只依秒數推定 GPU 記憶體有界。
- 同檔 fail() 目前主要標記 MSE endOfStream('decode')；**沒有立即保證 Worker/Range abort 與 pending ACK 清理**。修正時注意避免 endOfStream、updateend 與 close 之間競態。
- waitSourceOpen / waitAppend 的 Promise 未直接接受 AbortSignal；Worker 結束、切集或 sourceopen 尚未發生時，可能殘留未完成的等待。
- src/cenc-remux-worker.js **已改用 readVerifiedRange() 有界讀取**，執行 HTTP 206/Content-Range/Content-Length 的防護與取消；後續仍需加入 stalled HTTP body、回應過大與切集競態回歸，避免任何備援退回無界整檔下載。
- src/fmp4-assembler.js 單一 box 上限 16 MiB 且拒絕 size=0 / largesize；需用合成大 mdat、跨塊邊界、malformed boxes 確認限制符合實際輸出，不能一律放寬導致 OOM。
- C 端 file size 260 MiB 限額與 WASM 最大記憶體 512 MiB 不等於已證明有界；Asyncify、MP4 moov 索引、網路 cache、MSE buffer、播放下載並行都要量測。

建議改為單一狀態機：initializing → streaming → pausing/ended → failed/canceled → disposed；單一 abort 擁有者；避免 fail 後 worker 繼續讀；error、cancel、done、close 冪等；SourceBuffer.remove 舊區段，QuotaExceeded 時有條件 eviction + retry，不要清掉正在播放的區間。

**完成條件：** 300 秒以上（建議再加 30–60 分鐘合成壓測）不會不斷增加記憶體；暫停不讀完整影片；close/切集後無持續 HTTP 請求；遇 timeout、network abort、錯誤 Content-Range、206 截斷、403、416、429、SourceBuffer error 等可以分類並安全重試／停止；不會無限 fallback。

### P4 — 提升起播與切集速度，不能犧牲 P1–P3

1. 比較 init metadata / moov 取得、WASM 首次下載／compile、Asyncify overhead、first RAP 等階段。避免假定耗時都在解密或「等全集」。
2. 對頻繁重複的 Range 實施有界 window cache、合併相鄰請求、探測 moov 後再開始持續串流；合理預熱下一集的 metadata 和可能的 WASM 模組，但不要隱藏下載全集。
3. 使用可控 4G / 高延遲 throttle 和不同 GOP 長度測量 first presented frame / bytes consumed；針對 fps、GOP、音訊交錯調整 fragment 大小（例如先測 1–2 秒），確保 init/片段完整性。
4. 每次最佳化保留前後對照、p50/p95 以及 cold/warm start；先證明效益再增加複雜度。

**完成條件：** 合成及真實 HEVC 的起播時間有可重現的前後比較，且 seek、RAM、取消、音畫同步沒有退步。

### P5 — ByteVC2 另案驗收，勿與 HEVC 無損重封裝混淆

- 現有 public/bvc2 核心、src/bvc2-worker.js 與 src/bvc2.js 都已存在，但目前是**整檔下載 → WASM MEMFS 解密／解碼 → x264 編碼 → 整檔 Blob**。不是可串流 ByteVC2 播放；此前尚無真實 ByteVC2 影格驗證。
- 先取得合法可測的 ByteVC2 片源或小段測試素材，驗證 bitstream、實際 decoder、畫面色彩與 frame count、AAC 同步、音畫長度、輸出容量與轉換秒數；先確認 decoder 能正確解碼再處理低延遲。
- 真實 ByteVC2 可解後，評估改成同一套分段 AVIO + MSE H.264 輸出，或提供有界整檔模式。限制 WASM 記憶體、CPU、行動裝置耗電，並加上確定的失敗／備援訊息。轉碼有品質損失，UI 不得標記為原畫質無損。
- 可研究 Rust 作為封裝/控制平面，但不要重寫已由 Librempeg 提供的 ByteVC2 解碼器；比較二進位大小與執行效能後再決策。

**完成條件：** 至少一段真實 ByteVC2 在可支援的瀏覽器能穩定顯示影格與聲音，畫質與資源消耗可量化；若選擇分段模式，必須證明 EOF 前起播。

### P6 — 產品流程整合與相容性

- 維持多 ID URL 自動搜尋、畫質／編碼依實際來源連動、原畫質優先、選集進度色塊、reload 續播、預取下一集但不偷下載全集、手動選集與自動連播。別在缺少來源 metadata 時虛構音軌/字幕。
- 驗證下載佇列、並發 1–3、三次連續同錯誤停止、播放模式五次同錯誤停止、單集儲存、ZIP64 串流與 MP4 相容無損合併；下載快取可回饋播放（原有 per-tab Blob cache 有上限，MSE 來源 cache 與下載佇列尚非全面共用）。
- Android Firefox、Windows Firefox/Chromium、Android Chrome 分別檢查 File System Access 支援、播放 codec 能力與儲存流程；不支援 picker 不得每集彈窗。不得把 Firefox 系統不支援 HEVC 誤判成 fMP4 格式損壞。
- 失敗時提供明確的錯誤類別：來源 403/失效、金鑰、HEVC decoder、WASM ABI、MSE append、QuotaExceeded、使用者取消。保留實際選定畫質資訊，禁止悄悄掉畫質。

**完成條件：** 用有證據的測試矩陣把主要播放/下載旅程走完，並記錄無法在 CI 模擬的 Android 實機情況。

### P7 — 建置、發布、CI 與交接機制

1. **已實作並已有成功發布證據**：`.github/workflows/cenc-wasm-stream.yml` 的 main 發布，在合成 HEVC/AAC WASM 解碼成功後，才將 JS/WASM/manifest 一起以 GitHub Actions bot 提交 `main`，並以 `workflow_dispatch` 再部署 Pages。`scripts/cenc-wasm-bundle.mjs` 驗證 binary SHA256 及 pin source，部署前也必須通過版本清單驗證。若 push 先觸發的 CI/Pages 在 bot 更新前失敗，須以後續明確的 main workflow run 結論為準，不得掩蓋。
2. CI 層級：快速 Bun 單元及 Vite build 每次 main push；WASM 合成 HEVC/AAC 在有 C/build 變更時；Chromium/Firefox 合成 H.264 真正首影格與 EOF 檢查；長片 seek/記憶體壓測可使用週期性或夜間 CI。真實片源測試必須限量且不得輸出簽名 URL/key，不能變成每個 push 的大量 CDN 請求。
3. 設定每個階段的停損門檻與可重現失敗用例，避免 agent 卡在輪詢 Actions。對剛觸發的 CI 最多檢查一次即記錄 queued/in_progress + URL；若已失敗再看必要的 job steps/log。不得把 queued 當成功。
4. **每完成一階段，當下直接在 main 更新 docs/AGENT-PROGRESS.md 並 commit**：commit、scope、測試及 run URL、PASS/FAIL/NOT TESTED、已知問題、下一步。若工作卡住或使用者中斷，本文件須足以讓另一 session 接著執行。
5. 同步修正 README、docs/cenc-progressive-to-fmp4.md 的舊敘述，新增測試矩陣文檔。**不建立 PR**，在 main 上確認最新 HEAD、順序提交並以 Actions 進行驗證；若其他 agent 已先提交，先重新讀取和協調變更，不覆蓋其他進度。

**完成條件：** main 的 WASM 與 JS 核心對應、發布可重現、合成測試常態通過；文件不再宣稱未實作之功能，交接紀錄持續更新。

## 3. 風險與優先次序摘要

- **最高優先（P0 / P1 / P2 / P3）**：main baseline、真實 HEVC 起播與音訊、任意 seek/續播、長片有界記憶體及取消/錯誤恢復。
- **並行必要（P7）**：修正 main WASM 產物發佈，避免 C 原始碼改了但網站仍用舊版 wasm。
- **後續優化（P4）**：降低起播時間與請求數，靠實測決策。
- **重要但獨立（P5）**：ByteVC2 真正解碼與後續可串流轉碼。
- **系統整合（P6）**：下載佇列、ZIP/MP4、播放器設定、Android Firefox 與 Firefox 存檔體驗。

## 4. 新 session 的第一個可執行任務

**目前工作入口（2026-11-13）**：1800 秒合成 Chromium CENC 已有明確 PASS（#43283216947），不要重複研究此失敗。直接參考 [AGENT-PROGRESS.md](AGENT-PROGRESS.md) 最新階段及 main HEAD，檢查**含 CENC_TEST_PAUSE=1 的新 Browser run** 是否真有 pause/resume PASS；持續真實 HEVC（需合法 206 來源及 HEVC MSE 裝置）、ByteVC2 正例（需合法 bitstream）、長期取消／例外恢復與效能。合成 Seek/1800s 既已通過，不應誤稱尚未實作。直接提交 main、不開 PR，每個程式與測試階段更新 AGENT-PROGRESS；文件是 checkpoint，不是停止條件。
