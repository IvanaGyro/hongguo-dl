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

- 階段 2：合併 main — **完成**，詳見下方紀錄。
- 階段 3：合併後原始碼與部署確認 — **完成**；主分支新觸發的瀏覽器 CI 結果另待確認。
- 階段 4：實際 1080p HEVC + CENC 早期起播、seek、Android Firefox 驗證 — 尚未完成，已提供具體交接計畫。

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

## 階段 2 — 合併 feature 到 main（完成）

- 已建立 [PR #4](https://github.com/IvanaGyro/hongguo-dl/pull/4)；GitHub 初次嘗試合併回報 add/add conflict。
- 衝突僅出現在 `scripts/cenc-stream-remux.c` 和 `scripts/build-cenc-stream-wasm.sh`，因為 main 先前誤加入兩份重複且未測的實驗檔案。
- **選擇已驗證的 feature 版本**：先在 main 將兩檔更新為與 feature 完全相同的 blob SHA，提交 `6ab4016a7f9695f8bbefe12de502ec08d51b299a` 與 `84320658c70941456abb53aa841b1e9218b90778`；沒有強制改寫歷史。
- 然後 GitHub PR merge 成功，merge commit：[`bb9d808c32838ff853f305acfd43de8122fb1c8b`](https://github.com/IvanaGyro/hongguo-dl/commit/bb9d808c32838ff853f305acfd43de8122fb1c8b)。保留 main 和 feature 兩邊父系提交歷史。
- 本文件已透過 feature 進入 main，以後每個完成的階段都持續直接更新 main 上的同一份文件。
- **下一步**：只檢查一次合併後重要 GitHub Actions jobs 與 Pages deploy 狀態；若尚未完成寫「進行中」，不要等待迴圈卡住。驗證主分支必要檔案與測試未遭覆蓋。

## 階段 3 — 合併完整性、部署與 CI 觸發修正（已完成本階段核對）

- 逐一比較 `main` / `feature/cenc-avio-mse-stream` 的 **10 個關鍵檔案 blob SHA**（兩份 C/build、兩份 CENC Worker/adapter、fMP4 assembler、clear-key、player、瀏覽器測試與兩個 workflows），在修正 workflow 觸發條件之前**全部一致**。
- [GitHub Pages run #216](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230424434)（merge `bb9d808`）及 [#217](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230544892)（首次進度日誌 `26cf4f6`）**已成功部署**。
- 合併後 [WASM proof #9](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230424222) 已確認 **completed successfully**（main merge `bb9d808`）；feature 版對照 [HEVC/AAC WASM #43220527985](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43220527985) 亦為 success。
- 重要 CI 修復：先前 `.github/workflows/cenc-browser.yml` 的 push 條件**只有 feature 分支**，因此 main 不會自動重新驗證。已在 main 以 [`fdab8ae`](https://github.com/IvanaGyro/hongguo-dl/commit/fdab8ae7dec15e29b48be7f733e4eb22d5a2aef6) 加入 `main`。修改剛提交，新的 main 瀏覽器測試需另外確認；不可將先前 feature run 冒充 main run。
- **下一個代理工作**：查看最新的 `Progressive CENC MSE real-frame browser acceptance` 主分支 run 一次。若已完成，記錄結論和 run URL；若尚在執行，就不要連續阻塞等待。後續主要工作是實際 HEVC 首影格、Android Firefox 實測、seek / 長片記憶體。
- **已知 CI 發布缺口**：`.github/workflows/cenc-wasm-stream.yml` 的自動 WASM 發布步驟僅允許推送 feature 分支；現在已經 merge main，日後若修改 C/WASM 建置需評估將成功驗證的 WASM 產物也發到 main（並避免重複觸發）。目前 main 含已驗證的 feature 二進位資產。

### 階段 3 最後一次 CI 狀態快照（2026-11-12 Asia/Taipei）

- [Main WASM proof #9](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230424222)：**success**。
- [Main browser acceptance #13](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230870775)，提交 `fdab8ae`：**completed successfully**，已確認 browser job status=completed/conclusion=success。合成 H.264/AAC 的 Chromium/Firefox EOF 前首影格測試通過；不代表真實 HEVC 已驗證。

## 階段 4 — 盤點剩餘工作及下一個 session 計畫（本階段研究與交接已完成；實作待做）

- 已根據 main 原始碼與兩項成功 CI，建立 [docs/NEXT-SESSION-PLAN.md](NEXT-SESSION-PLAN.md)，提交 [28c978c](https://github.com/IvanaGyro/hongguo-dl/commit/28c978cbe4fba07041d1ffa44acce35549310f0f)。包含優先順序 P0–P7、每階段程式檔案、驗收條件、測試矩陣、風險與交接規則。
- 已核對 **Main browser acceptance #13 成功**，更新上方原本 in_progress 的過時資訊；Main WASM proof #9 亦成功。
- **程式碼尚未解決**：真實 HEVC 1080p 端對端尚未驗證；無未緩衝位置的 Range seek；MSE 舊範圍沒有 eviction；錯誤時 Worker/ACK 未保證立即清理；Main WASM publishing 在 workflow 只針對 feature 分支；ByteVC2 沒有真實影格驗證，仍是整檔轉碼。
- 下一個 session 先執行 [NEXT-SESSION-PLAN.md 第 4 節](NEXT-SESSION-PLAN.md)：建立新功能分支，確認合成 CI 基線與 main 資產發布的一致性，更新進度檔，再開始真實 HEVC 測試；勿直接認定 CI 意味真實紅果 HEVC 可播。

- 已同步修正過時的 [CENC 技術研究文件](cenc-progressive-to-fmp4.md)，不再把已實作的瀏覽器 WASM/MSE 標記為「尚未實作」；修正提交 [44d96e1](https://github.com/IvanaGyro/hongguo-dl/commit/44d96e165d9a3d13373430c95aa755a5768cbc5d)。
- 本輪工作僅盤點、寫入驗收計畫及更新文件，**未修改核心播放器程式碼、未執行真實 HEVC 播放測試**。下個 session 請以最新 main 為準。

## 階段 5 — 2026-11-12 新 session：P0/P7 發布一致性，P3 有界讀取與取消（已提交，CI 未確認）

- **基準 HEAD：** `main 19cba39a68e3462f01015bf3ff32958efd52e6b9`；新分支 `fix/cenc-wasm-publish-and-stream-stability`，不直接改 main。
- **確認歷史基準**：Main WASM proof [#9](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230424222) 與合成 Chromium/Firefox browser [#13](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43230870775) 結論均 success，僅代表**既有 main 合成素材**，不是本分支新功能驗收。
- **P7 已實作（待驗證）**：`scripts/cenc-wasm-bundle.mjs` 發布後同時產生兩份二進位及 `public/cenc/manifest.json` SHA-256 憑證，包含 C bridge、build shell 的指紋、Librempeg 與 Emscripten pin；main/PR CI 與 Pages 部署前要求來源與資產匹配，main proof 額外重建並 byte compare。WASM workflow 僅在 CENC 功能分支驗證通過後寫回**該功能分支**，必須經 PR 合併 main，不再自動直接發布 main；保留原始架構，不重新造 CENC demux。
- **P7 關鍵提交**：`440a3fb`（發布腳本）、`c0ff04f`（manifest mismatch 測試）、`742f821`（WASM workflow）、`f4e9bc7`（PR CI gate）、`841d93d`（Pages gate）、`61dc05b`（browser acceptance gate）。
- **P3 已實作（待驗證）**：`src/http-range.js` 使用 bounded streaming reader 而不是 `response.arrayBuffer()`，檢查 206、Content-Range、Content-Length、超量／截斷；`src/cenc-bundle.js` 與 Worker 以 SHA-256 比對發佈的 mjs/wasm 並使用 content-addressed URL；`src/cenc-remux.js` 對等待 sourceopen / SourceBuffer 更新增加 abort，失敗立即終止 Worker 並嘗試 MSE decode error，append 前移除舊區間，QuotaExceeded 最多再嘗試一次。
- **P3 關鍵提交**：`4f23d3b`、`6d1f67b`、`8c89244`、`c44c851`、`cf36375`、`f9dd343`、`750381a`、`e1bd2ee`、`2b33ca9`；配套測試 `tests/http-range.test.mjs`、`tests/cenc-bundle.test.mjs`、`tests/mse-eviction.test.mjs`。
- **P0 證據矩陣**：`docs/CENC-TEST-MATRIX.md`（`30deccf`），明確區分合成／真實／瀏覽器裝置，附完整可重現指令和有界實測要求。
- **測試狀態**：本回合 GitHub 原始碼已寫入，但新分支的 `bun test`、Vite build、WASM rebuild、Chromium／Firefox acceptance 與 Pages **尚未得到本分支成功結論**。本地容器沒有 GitHub DNS／Bun，無法直接 clone、`bun ci`；以 PR 的 Actions 為正式驗收；不得把先前成功的 main CI 記為新分支成功。
- **真實 HEVC／ByteVC2**：尚未執行片源下載或播放；無 URL、KID、key、影片內容寫入 repo；不以 Ubuntu 轉封裝的成功推斷 Windows/Android 硬體解碼。
- **已知未完成**：Worker C 端沒有按時間 `avformat_seek_file` 跳到 RAP，unbuffered seek 仍屬 P2 未完成；真實 1080p HEVC EOF 前首影格、完整音畫、300s+ 記憶體壓測、ByteVC2 真實解碼仍未通過驗證。MSE eviction/abort 是初版修補，須通過自動及瀏覽器壓測。
- **下一步**：建立 PR 並確認 CI URL 與初次 status；不要輪詢未完的工作；若檢查失敗只讀取失敗步驟。WASM workflow 若完成驗證將 JS、WASM、manifest 一起提交到 feature branch；其 `GITHUB_TOKEN` 提交不會觸發後續 CI，必須再以人工／agent commit 觸發 PR checks。CI 成功後合併 PR，之後對真實片源做有限探測、實際 HEVC 測試與 P2 seek。

## 階段 6 — 2026-11-12 P1 片源 metadata 與結構化 codec 辨識（已提交；實片源連線未成功）

- [PR #5](https://github.com/IvanaGyro/hongguo-dl/pull/5) 已建立，涵蓋階段 5 發布一致性和串流穩定性修補。
- **新分支驗證**：`0086496fc3ac06cb077aae24ccac3cb30445d6a5` 的 [PR CI #43236464613](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43236464613) 與 [PR WASM proof #43236464666](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43236464666) 均 **completed/success**；這只驗證當時提交的合成素材、測試、manifest 與編譯，不代表後續提交也已通過。
- **codec metadata**：新增 `src/mp4-track-formats.js` (`8973ba9`) 和 `tests/mp4-track-formats.test.mjs` (`c81af50`)，循 moov/trak/mdia/minf/stbl/stsd 與加密 sample entry 的 sinf/frma 分辨 HEVC/AVC/AAC 等格式；`src/clear-key.js` (`319a08f`) 改用結構化 hasAac，偵測來源宣告與實際 sample entry codec 不一致時拒絕錯誤 MIME。測試命令 `node --test tests/mp4-track-formats.test.mjs tests/clear-key.test.mjs`。
- **真實片源有限探測**：將 `.github/workflows/live-cenc-layout.yml` (`f1e6600`) 加入 CENC feature 分支 trigger；只執行一支既有 bounded 來源探測，最大 2 個 CDN candidates、6 個 Range、3 MiB 名目量，不下載影片或記錄 URL/key。
- **真實探測結果：FAIL / SOURCE ACCESS**，[Actions #43237370059](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43237370059) 已完成失敗：兩個 CDN candidate 的 HTTP Range 均回 **403**，沒有成功取得媒體位元組；未達 demux、HEVC 解碼或首影格階段。這不是 CENC remux 或 HEVC decoder 失敗的證據；禁止改標 PASS，也不無限重試被拒絕的 CDN。
- **瀏覽器觀察**：公開 Pages 的遠端 Linux Chromium 首集 UI 曾顯示 `Librempeg ByteVC2 → H.264 轉碼中…`；不是 HEVC 播放證據，也沒有可信任的完成影格與 A/V 同步驗收。該工作階段已關閉。
- **已知後續**：須在使用者授權且來源可成功回 206 的環境進行實際 1080p HEVC／Android 測試；如無法存取，先以合成有界測試驗證錯誤、RAM、取消及 seek，再對真實片源區分 HTTP 403、格式或 decoder。
- **PR 合併條件**：最新 commit 必須重新確認 PR CI、WASM proof、必要的瀏覽器 acceptance；若尚進行中就記錄並繼續可獨立工作，不等待 Actions 日誌。尚未開發 `avformat_seek_file` 的 unbuffered seek。

## 階段 7 — 2026-11-12 使用者明確改為直接 main 提交（已執行；後續 CI 部分進行中）

- **最新使用者指示（覆寫上文階段 5/6 的 PR 計畫）**：不建立或透過 PR 合併。日後直接在 `main` 實作、測試、提交，並在每階段直接更新本文件。不要再開 PR。
- [PR #5](https://github.com/IvanaGyro/hongguo-dl/pull/5) 已關閉且 **未經 PR merge**。
- 原 `fix/cenc-wasm-publish-and-stream-stability` 已確認相對 `main 19cba39` **ahead 23 / behind 0**，使用 expected SHA lease 直接 fast-forward `main` 至 `69c3fcf97c1024fd62a3761f6fcc80280d7634f4`；沒有 force push 或改寫歷史。功能內容（SHA256 manifest、Runtime JS/WASM 檢查、Bounded Range、MSE eviction/cancel、stsd/frma 解析及相關 tests）均進入 main。
- **新 main 已驗證**：`69c3fcf` 的 [main CI](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238138286) **success**、[main 合成 Chromium/Firefox CENC browser](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238138456) **success**、[Pages](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238138325) **success**；仍非真實 HEVC、Android Firefox 或 ByteVC2 解碼通過的證據。
- **後續 main 直接提交**：`b98522f43d987c0ae05dc0f5f32427bf93b7bd1b` 將 `.github/workflows/cenc-wasm-stream.yml` 改成 **合成 WASM 解碼通過後直接於 main 發布 JS/WASM/manifest**；若 commit 有差異，以 `gh workflow run pages.yml --ref main` 重新觸發部署，因 `GITHUB_TOKEN` push 不會自動觸發 Pages。此方式不經 PR。**新 workflow 實際「有需要重建二進位」的 publish/dispatch 分支尚未驗證**。
- `7d053a77baf970294f43e71141306a83067f3456` 更新 [docs/NEXT-SESSION-PLAN.md](NEXT-SESSION-PLAN.md) 將舊 PR 交接規則明確標記為過時。
- **CI 狀態快照**：`b98522f` [CI](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238419942) **success**、[Pages](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238419638) **success**、[WASM proof](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238420071) **in_progress**；`7d053a7` [CI](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238573530) **success**、[Pages](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238573441) **in_progress**。不輪詢日誌，不把未完工作當 PASS。
- **下一步仍按優先順序**：用有權存取並返回 HTTP 206 的真實 1080p HEVC 片源確認 MSE / A/V / EOF 前起播（目前先前 CDN 403，尚未成功）；P2 跳轉未緩衝處需 RAP 定位與 AVFormat seek；P3 300 秒以上 RAM/取消壓測；之後才做 ByteVC2 真實影格驗證與低延遲轉碼。保留下載佇列、ZIP/MP4、播放紀錄、解析度及連播。

## 階段 8 — 2026-11-12 P2 indexed RAP seek WASM 第一階段（已提交，驗收進行中）

- **只在 main 直接提交**。接手基準 `main 2ad9d69b632981b47cd594dd341be7192e31faf2`；先確認 [Main CI #43238807620](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238807620) 與 [Pages #43238807969](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238807969) 已 success，另 [main WASM proof #43238420071](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43238420071) success（這是**修改 Seek 前**的基準）。
- **已提交的底層實作**：`4baf31d3` 在 `scripts/cenc-stream-remux.c` 增加 `cenc_stream_remux_at(file_size, key, start_seconds)`，MOV sample index 經 `av_seek_frame(..., AVSEEK_FLAG_BACKWARD)` 定位 preceding RAP，維持輸出時間戳；保留 `cenc_stream_remux` 舊入口。 `4d9c8635` 將新入口加到 WASM exports。
- **已提交的驗收**：`7e478e86`、`a5292995` 允許 `scripts/verify-cenc-stream-wasm.mjs` 以 6 秒 Seek 讀取且確認第一 moof 前跨至較後的 Range；`b6c31290` 擴充 `.github/workflows/cenc-wasm-stream.yml` 生成本地 12 秒合成 HEVC/AAC CENC、對 6 秒 Seek 的輸出執行 ffmpeg 解碼及 ffprobe PTS 範圍檢查。**尚未將 seek UI 接入瀏覽器**，因此不能稱 P2 已完成。
- **CI 狀態快照**：最新 `b6c31290` 的 [WASM proof](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43243404626) **queued**、[CI](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43243404391) **in_progress**、[Pages](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43243404853) **queued**。先前 `a529299` 的 [CI](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43243326468) 和 [Pages](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43243326452) **failure**：可能是 C/build source 指紋已變、main 發布資產尚未更新（請檢查失敗 job 才能確認，不能當成唯一原因）。
- **建置同步警示**：source 改動會立即使 `public/cenc/manifest.json` 的 pins 不匹配；唯有新 WASM proof 先成功並將 assets/manifest 直接推 main 後，Pages gate 才能通過。不要用舊成功 run 代替新 C/WASM seek 驗證，也不要讓多個同時執行的舊 WASM run 覆蓋更新的 manifest。必須先確認 main 真正對應同一組 JS/WASM 指紋。
- **下一步**：一次檢查最新 WASM job 完成結果，若 fail 僅看失敗步驟；若 success 核對 main 的 JS/WASM/manifest，然後把 Worker 的 `startSeconds`、MSE 的 source duration 與播放器的 unbuffered seek／進度恢復接上，新增合成 H.264/Firefox/Chromium seek 測試。再做 300s+ RAM/取消壓測。真實 HEVC 目前有 HTTP 403 片源存取限制，ByteVC2 尚未實機解碼驗證。

## 階段 9 — 2026-11-12 Seek 時間戳問題診斷與測試（已提交，仍非最終完成）

- **真實證據是合成素材**：`b6c31290` 的 [WASM proof #43243404626](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43243404626) 已完成 **failure**，但同一執行中的 `cenc_stream_remux_at(6)` 確實請求後段的 HTTP Range（first moof 前約 174958/270757 bytes；`firstMoofHadNonzeroRange=true`），並通過 `ffmpeg -i output -f null -` 可解碼測試；**不代表時間軸正確**。
- 失敗步驟的 `ffprobe` 首個 video PTS 只有 `0.208333`，後續 `0.125000` 等，並非原本約 6 秒時間軸；Librempeg MOV muxer 同時警告 first DTS nonzero 且 moov 已寫入，建議 `delay_moov`。之前驗收腳本的 `split(/\\s+/)` 多餘跳脫造成 NaN，`ba5d11e9` 已修正解析。
- **已提交修正**：`afffdfa8` 對非零 Seek 路徑加入 `+delay_moov+frag_discont`，要求 muxer 在看到第一個 RAP 後才寫 moov，宣告前面缺少的 fragments；維持非 seek 原始路徑。**此修改尚未驗收成功，需檢查最新 WASM proof 的 packet PTS 與瀏覽器的 MSE 行為。**
- **新時間軸元件**：`f617a350` 新增 `mvhd` 片長解析；`73b8f8f4` 補足 32/64-bit 測試；`615c5fba` 將電影 duration 放入 CENC metadata；`1c1afa63`、`6d22d4a0` 新增 pure `cenc-seek` 的 buffered 判定和 clamp 續播單元測試。尚未把 Worker startSeconds、SourceBuffer.duration、player.seeked 與 reload restoreTime 串接起來，不可寫 P2 PASS。
- **並發編譯保護**：`4bdefec7` 在 CENC WASM workflow 引入 `concurrency.cancel-in-progress`，避免舊版 WASM proof 與最新改動一起重建；建置後若驗證失敗不能 publish。未修改下載佇列／ZIP/MP4／自動下一集等流程。
- **CI/Pages 狀態**：更新 C/build 之後 source manifest 尚未由通過新驗收的 WASM bundle 更新，因此 [CI #43244524743](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43244524743) 等顯示 failure；至少 [CI #43243953431](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43243953431) 已確認失敗在 bundle source check。這是**實際部署阻礙**，不能略過。最新 [WASM proof #43244358148](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43244358148) 為 **in_progress**；若其 PTS 驗收失敗，只修失敗點，若通過則等待三件資產/manifest 同步到 main 後重新確認 Pages 成功。
- **下一步 P2/P3**：先完成 backend 6 秒 Seek 產物非零 PTS 的合成驗收；再在 Node/瀏覽器端加入非零 startSeconds、full movie duration、非緩衝區 seek worker restart，測試 10/50/90%、reload、切集取消、音訊與圖像恢復。後續真實 1080p HEVC 仍需有 206 的授權片源，之前 403 不是解碼器失敗；ByteVC2 尚未實際解碼驗證。

## 階段 10 — 2026-11-12 P2 播放器 seek / reload 接線與合成瀏覽器驗收（程式已提交，CI 尚未通過）

- **截至本階段 main 原始碼提交**：`0d3718fd` 在 `src/cenc-remux-worker.js` 使用新 `cenc_stream_remux_at` 進行 source RAP 時間跳轉；`41448a02` 在 `src/cenc-remux.js` 新增 `startSeconds`、完整 MSE `duration`、`seekTo()` 重新建立 Worker/MediaSource。
- `e4c83d32` 將 CENC probe 取得之 `mvhd` duration 及儲存時間傳至 remux。 `dbe427f4` 於 `src/player.js` 載入初期以觀看記錄直達目標 RAP；正在播放時，對 **不在既有 buffered range** 的時間點取消舊串流、開新 MSE/Worker，保留進度、播放速度、原編碼及自動播放；對 buffered seek 保留瀏覽器內部跳轉。未改下載佇列、ZIP/MP4、下載快取及下一集邏輯。
- **合成瀏覽器測試已提交**：`cac3132e` 在 `tests/cenc-stream.browser.mjs` 增加 55 秒跨未緩衝區跳轉的 source Range／MSE 驗收；`b171ab13` 在 workflow 生成 70 秒 H.264/AAC 合成加密片並分別跑 Chromium/Firefox；`be166de5` 加入重新整理後仍在 55 秒附近起播、Range 指向後段的續播檢查。
- **已確定的回歸**：`e4c83d32` 的 [browser #43245321951](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43245321951) 曾 fail：合成 H.264 開始時 MOV muxer 報告 `No meaningful edit list ... empty_moov` 及 nonzero audio DTS。因非 seek 時不應固定關閉自動負時間戳修正，已以 `b483f1fe` 改為只有 `startSeconds > 0.5` 才設定 `AVFMT_AVOID_NEG_TS_DISABLED`，保留正常播放原有行為。此修正仍待新 bundle 與瀏覽器驗證，不能標記已解決。
- **既有驗收**：前一版 [Seek WASM proof #43244358148](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43244358148) 已 **completed success**，證明合成 6 秒 RAP、輸出解碼及 PTS；原 JS/WASM manifest 與 Pages 已於 [#43244842438](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43244842438) 成功發布。該成功 **發生在後續 `b483f1fe` 正常起播修復之前**，不能證明新 bundle。
- **CI 最新快照**：`b483f1fe` 的 [WASM proof #43245818741](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43245818741) **in_progress**；`b171ab13` [browser #43246111292](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43246111292) **failure**，核對 failure step 在 `Verify published WASM ABI manifest and asset hashes`（C 原始碼變更後尚未發布新 JS/WASM），**不是影片 seek browser assertion 失敗**；`be166de5` [browser #43246276628](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43246276628) **in_progress**、[CI #43246276886](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43246276886) **in_progress**、[Pages #43246276843](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43246276843) **in_progress**。
- **下一步**：確認 b483 的 WASM proof 成功後，由 Actions 直接發布 JS/WASM/manifest 至 main；再透過 main commit 啟動新版瀏覽器 acceptance。若 70s seek / reload 測試失敗，必須先讀 failed job 的具體斷言再修復，禁止宣稱 P2 PASS。再完成 300 秒與 30–60 分鐘合成記憶體/取消壓測。真實 1080p HEVC 與 ByteVC2 仍 NOT TESTED／HTTP 403 導致無法驗收。

## 階段 11 — 2026-11-12 Chromium 非緩衝 Seek 通過，reload 續播失敗待排除（已檢查失敗 CI）

- **主分支基準**：`d603fdd5` 的 [CI #43246560794](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43246560794) **success**、[Pages #43246560752](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43246560752) **success**。僅代表程式測試與部署，非新版 seek 瀏覽器驗收。
- **實際瀏覽器驗證 [#43246560754](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43246560754)**：**completed/failure**；已查閱該次唯一失敗 job。內部子項：
  - PASS — Chromium 合成 15s H.264/AAC CENC：來源 EOF 前首影格、連續播放 >1.5 秒。
  - PASS — Firefox 合成 15s H.264/AAC CENC：同上。
  - PASS — **Chromium 合成 70s H.264/AAC CENC：55s unbuffered RAP seek**。測試確認 `duration=70`、新觸發 5 個媒體 Range、最高新起點 `3904565` bytes，較來源一半更後方，影格可繼續顯示。
  - FAIL — **Chromium 55s 跳轉後重新整理頁面之續播**：在 `tests/cenc-stream.browser.mjs:206` 等待 `currentTime >54.5`、解碼 `videoWidth=480`、`readyState>=2` 時 90 秒逾時。該 job 在進到 Firefox 70s seek 測試之前停止；**Firefox 新 seek NOT TESTED**。
- **診斷增補**：`a6c8a9d8` 為 reload 失敗分支新增 status、SourceInfo、currentTime、duration、buffered 時段、已儲存進度值、最近的 Range 起迄與匿名錯誤種類；不輸出 URL/key。下個 browser run 若失敗，請直接讀此一段診斷，不要猜測 progress/decoder/HTTP 哪個環節有問題。
- **P3 快速失敗測試**：`46a201e4` 新增 HTTP 403/416/429 每次只請求一次、回應 body cancel，以及 AbortSignal 已取消時不讀媒體的單元測試（本提交的 CI 尚未確認結果）。
- **P2 尚未完成**：Chromium remote seek 已有合成成功證據，reload 不通；Firefox remote seek 尚未驗證，真實 HEVC/Android 仍有 HTTP 403 存取限制。下一步優先修復 reload 實際失敗原因，再跑完兩種瀏覽器與 10/50/90% case；不要將整個 P2 標記 PASS。

## 階段 12 — 2026-11-13 續播 race 與 Range-only retry 修補（main 已提交，瀏覽器回歸待確認）

- **使用者要求**：停止卡在重複 Actions 狀態輪詢，釐清工作並繼續直接修改 main；不建立 PR。
- **唯一有針對性的失敗診斷**：[browser #43247421856](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43247421856)（`a6c8a9d8`）**completed/failure**。先通過 Chromium/Firefox 15s 起播與 Chromium 70s 55 秒遠端 seek。Reload 後的匿名診斷顯示 savedPositions `55.765403 / 70.015999 / completed=false`，但播放器 `status=跳轉失敗：...串流未就緒`、`readyState=0`、`currentTime=0`，接著出現多個 **沒有 Range header** 的整檔備援要求而遭合成 server HTTP 416；失敗與進度記錄消失無關。
- **核心修補 [135eeea](https://github.com/IvanaGyro/hongguo-dl/commit/135eeea03c48494427d7af8c79bebc5843490cdd)**：在 `src/player.js` 新增 `waitForCencResume`，僅 CENC 非零續播在 `restoreTime` 後仍維持 `loading`／停用遠端 `seeking` handler，直至目標時間真正落在 MSE buffered ranges、`readyState >= HAVE_CURRENT_DATA` 且 `currentTime` 已定位到目標，或以 timeout/abort/error 明確失敗。不再把 `loadedmetadata` 或單純 currentTime 指派當成可播成功。
- **避免無界備援**：`retryIncrementalCenc` 對已進入 `cenc-remux` 的同一集、同一次 playback session 的後續重試維持增量串流；若重新建立失敗就明確傳回 CENC_UNAVAILABLE，**不再退回無 Range 的整檔媒體下載**。保留在新集數 `open()` 時重置此記錄與既有失敗次數限制。其他未採用 CENC remux 的下載／播放模式與 ZIP/MP4/畫質／下一集邏輯不變。
- **驗收尚未通過**：這是針對診斷提出的競態修補，需以新 main 的 `tests/cenc-stream.browser.mjs` 驗收 Chromium 55 秒 seek、reload 續播、Firefox 55 秒 seek/續播與主 CI／Pages。不能將舊版通過結果當成修補後通過，也不能宣稱真實 HEVC 1080p／Android/ByteVC2 成功。
- **下一步**：只在新 browser CI 完成且失敗時讀取 *失敗 job* 的診斷一次，優先修正新具體 failure。再增加不同 seek 比例與取消／長時壓測；避免大量真實 CDN 嘗試。CENC WASM 已按原計畫保留，勿重寫。

## 階段 13 — 2026-11-13 停止 Actions 輪詢，修復 reload 續播與取消讀取的競態（已直接提交 main）

- **本輪接手時主分支**：`91f762c6d54ca5522f00bb021a130de74cbc47c2`。僅一次性讀取上次失敗 run [#43247421856](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43247421856) 的失敗 job，沒有輪詢等待。合成 15s Chromium/Firefox 起播與 Chromium 70s 55s unbuffered seek PASS；reload diagnostics 顯示觀看進度已保存 `55.765403s` 但播放器再度觸發錯誤 seek，後續重試發送缺少 Range header 的請求遭 416。Firefox 70s remote seek 尚無 PASS。
- **[135eeea](https://github.com/IvanaGyro/hongguo-dl/commit/135eeea03c48494427d7af8c79bebc5843490cdd)**：`src/player.js` 新增初次 CENC 非零續播的緩衝確認；只有當 `video.buffered` 涵蓋目標時間、`readyState >= HAVE_CURRENT_DATA` 且 `currentTime` 已到目標時才解除 `loading` 保護，防止遲來的 `seeking` 再次重啟 Worker。已進入 CENC 增量播放後，該 episode 的重試不能退回整檔無 Range 下載，若串流路徑失效應明確錯誤。此修正以日誌證據推導，**仍待新增的 Chromium/Firefox reload 瀏覽器測試驗收，不能宣稱 PASS**。
- **[8a166a7](https://github.com/IvanaGyro/hongguo-dl/commit/8a166a755fb7118d8cce966389da9fee4e9cfbf6) + [f201f69](https://github.com/IvanaGyro/hongguo-dl/commit/f201f695b11183565461ef7daa8e2c21f0d9289e)**：`src/http-range.js` 在請求前及 response 收到後檢查 abort，已取消則不 fetch；body `reader.read()` 期間被取消時直接 `reader.cancel()` 並釋放 listener/lock。單元測試新增 pre-aborted 0 請求、正在等串流讀取時取消。這些提交的 [main CI #43266444859](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266444859) **completed/success**、[Pages #43266444867](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266444867) **completed/success**。
- **[3b3de69](https://github.com/IvanaGyro/hongguo-dl/commit/3b3de69af1ea89545064e13535d4d64e21a815ca)**：瀏覽器測試在 reload 前先確定 55 秒的進度已真正寫入 localStorage，reload 故障等待 90 → 40 秒，不再讓同一 bug 長時間占用 job。此版 [main CI #43266588773](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588773) **completed/success**、[Pages #43266588894](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588894) **completed/success**。新增 [browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689) **in_progress（快照，未聲稱 PASS）**。
- **[afb38bf](https://github.com/IvanaGyro/hongguo-dl/commit/afb38bf98696df7bb2f4e4d1a05dc8c236197661)**：`tests/mse-eviction.test.mjs` 增加 60～300 秒、間斷 buffer 的 30 秒倒退視窗政策驗證。**僅純單元政策測試，不等於真實 300 秒播放或 RAM/GPU 壓測通過**。其 [main CI #43266659601](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266659601) 和 [Pages #43266659339](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266659339) 均 **in_progress（快照）**。
- **本地環境**：容器具 Node v22，但 GitHub DNS 不可解析，無法 `git clone` 或在本地直接執行整套 Bun/Playwright；以已回傳的 GitHub CI 結論為準。新的真實 HEVC 1080p 仍受先前 CDN 403 限制，未做更多敏感來源請求；ByteVC2 尚未完成真實解碼驗證。
- **接手下一步**：不輪詢。待已有的 browser job 自行完成後，僅一次確認結果；若 FAIL 只讀失敗 job 中 `CENC reload resume diagnostics`，針對確切錯誤修復，勿再重寫 CENC。接著對 Firefox unbuffered seek、10/50/90% Seek、長影片/取消作合成驗證。所有修改直接提交 main，不建立 PR。

## 階段 14 — 2026-11-13 已完成瀏覽器 55 秒遠端 Seek / reload 驗收（已確認 PASS，下一階段繼續）

- [Progressive CENC browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689) 結果 **completed/success**；已閱讀 job `131351664945` 的實際測試行，並非只看 workflow 綠燈。合成加密 H.264/AAC 素材：
  - Chromium 15s EOF 前首影格：PASS、`playbackSeconds=1.508026`。
  - Firefox 15s EOF 前首影格：PASS、`playbackSeconds=1.535564`。
  - Chromium 70s 55s unbuffered RAP seek：PASS、5 個新 Range、最高 `3904565` byte offset。
  - Chromium 55s reload resume：PASS、6/7? run 輸出確切 `resumedRangeCount=7`。
  - Firefox 70s 55s unbuffered RAP seek：PASS、5 個新 Range、最高 `3904565` byte offset。
  - Firefox 55s reload resume：PASS、`resumedRangeCount=6`。
- 同時 `main aecc9a4` 的 [CI #43266778814](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266778814) **success**、[Pages #43266778629](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266778629) **success**。
- **判定**：P2 主要架構（RAP Range seek、MSE 重建、保存位置與重新開啟）之 55 秒案例 **合成 Chromium/Firefox 已通過**；尚未驗證多重 10/50/90%、切集時取消、長時間 RAM 以及真實 HEVC。下一階段先加多 seek + cancel/stress 的自動回歸；另需真實 HEVC 授權片源 HTTP 206 才能做 P1 最終驗收。
- **重要工作節奏**：使用者明確要求「實作 → 測試 → 改文件 → 繼續下一階段」多輪工作，不要把進度文件視為 session 結束；不開 PR，直接 main，僅在需要解釋具體失敗時讀一次 Actions log。

## 階段 15 — 2026-11-13 Chromium/Firefox 10/50/90% cross-range seek 擴充（程式已提交，接續測試）

- **前一階段 PASS**：既有合成 70 秒 H.264/AAC CENC 的 Chromium/Firefox 55 秒遠端 Seek、reload 續播通過，證據 [#43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689) 之 PASS 行（詳階段 14）。
- **程式 [4256839](https://github.com/IvanaGyro/hongguo-dl/commit/4256839146a535c889544543443de584e2f1d739)**：在 `tests/cenc-stream.browser.mjs` 增加 70 秒片的往返遠端 Seek：先 55 秒及 reload，之後跳 7 秒 (10%)、35 秒 (50%)、63 秒 (90%)；每次檢查目標起初不在 buffered、可再呈現影格、目標附近 MSE buffer、無整檔無 Range 請求、HTTP Range 位移符合索引預期。最後再 reload，要求 90% 處恢復、後段 Range 而不是從頭下載。
- **CI [0980388](https://github.com/IvanaGyro/hongguo-dl/commit/098038822836e02e0ee7a89dc0abd9235272853c)**：`.github/workflows/cenc-browser.yml` 已對 Chromium/Firefox 70 秒 fixture 啟用 `CENC_TEST_MULTI_SEEK=1`。**當前沒有此新增測試的成功結論**；原 55 秒 PASS 不等於這些新案例 PASS。
- **後續**：繼續 P3 實際 300 秒合成長片播畢、舊 MSE range eviction、取消與記憶體邊界驗收；有具體失敗才單次讀取 job logs 並修正。不要停在寫文件，不開 PR。

## 階段 16 — 2026-11-13 P3 實際 300 秒合成 CENC 長片播放測試（程式與 CI 已提交，正在驗收）

- **[1015fc6](https://github.com/IvanaGyro/hongguo-dl/commit/1015fc6500b533586f6088694f8a92ca2089c4b9)**：`tests/cenc-stream.browser.mjs` 新增 `CENC_TEST_STRESS=1`，使用影片元素 8x 速實際播放到 300 秒 EOF，逐次記錄 `buffered` 區間總秒數、ahead 時長、採樣數、影片 error/ended，要求播放結束、沒有整檔無 Range 下載、`maxBufferedSpan < 120s`、`maxBufferedAhead < 90s`。這驗證 MSE window 回收，不等於已測 OS/GPU RSS。
- **[9cbca45](https://github.com/IvanaGyro/hongguo-dl/commit/9cbca45910dc2fcc79b96e779ac59c70e1d6c456)**：Browser workflow 自產 300 秒 480x270、12fps、H.264/AAC CENC progressive 合成 fixture；執行 Chromium 300 秒影片實播與上面有界 MSE 測試。保留既有 Chromium/Firefox 15s EOF 前首影格、70s 55秒/10%/50%/90% RAP seek 和 reload。首次長片測試以 Chromium 進行，Firefox 300 秒及硬體 RAM 仍未驗證。
- **狀態**：以上新 10/50/90% 與 300 秒測試尚未讀取 completed browser run；不得預先標記 PASS。優先繼續強化取消與錯誤恢復，後續若 workflow failed 只讀失敗 step/log 修復，避免輪詢造成工作停滯。

## 階段 17 — 2026-11-13 P1 1080p synthetic proof、metadata abort 與離開播放模式關閉串流（已提交，回歸待確認）

- **metadata HTTP Range cancellation**：`a1533b7` 調整 `src/clear-key.js` metadata/KID Range：abort 時立即 `reader.cancel()`、清理 listener/lock，response 到達但已取消時立即取消，不會等下一個 chunk。`e0fa710` 補上 mock 永遠不送資料的 206 stream，在切集 abort 後應立即 reject 與 cancel 的測試。新測試待 CI 驗證。
- **真正 1080p HEVC CENC 合成 proof（非真實來源）**：`758c524` 擴充 WASM proof workflow：生成 1920×1080 HEVC/AAC CENC encrypted MP4，經 pinned Librempeg WASM 做 stream copy，核對 FFmpeg 輸出可解碼以及 FFprobe video codec/1920×1080、AAC。此為測試新輸出尺寸，**目前尚未取得 CI PASS；不代表任何瀏覽器能解碼 HEVC 或真實 CDN 206**。
- **版本化驗收矩陣**：`0b613d6` 更新 `docs/CENC-TEST-MATRIX.md`，刪掉已過時的 PR / feature 分支工作流程與不正確的 NOT TESTED 舊狀態，記錄 Chromium/Firefox 合成 55 秒 Seek + reload 的成功證據，保留 10/50/90% 和 300 秒為待驗證。
- **離開播放頁釋放串流**：`30537f3` 在 `src/player.js` 新增 `deactivate()`，切換至下載模式時 abort 目前 Episode Worker/Range、停止來源、清除 prefetch 並保存進度；返回播放時重新從 progress 以 Range 建立串流但不強制 autoplay。 `65b539c` 的 `src/main.js` 模式切換改為使用 deactivate 而非純 pause。注意普通播放器內的 pause 仍維持緩衝／backpressure，不會關閉串流。
- **模式切換 E2E**：`0151b15` 在 70s synthetic Chromium/Firefox 回歸後加入從 90% 續播切到 download，斷言 video src 清除且 800ms 不再發出新媒體請求，再切回播放要求成功恢復原位置與 bounded Range。 `0554a29` 增加 main/mode/Range 修改對 `cenc-browser.yml` 的 path trigger。**尚未得到該新增測試的成功結論**。
- **後續**：優先檢查已完成的新增 CI 一次，若失敗只讀失敗 job；修正至通過後再完成 P3 長片 RAM 而非純 buffer 秒數、真實 HEVC 可用端點 / Windows or Android 測試與 ByteVC2；每階段更新文件而不是停工。所有提交直接 main，無 PR。

## 階段 18 — 2026-11-13 跨緩衝區測試修正與 BVC2 安全護欄（已提交，繼續後續工作）

- **[f2a27f1](https://github.com/IvanaGyro/hongguo-dl/commit/f2a27f11deddce3c7d7ddf6f2c043d64b0f6c42e)**：修正新增 10/50/90% 測試可能誤把已緩衝的 35s 當成 remote seek 的問題。改用 `[7,63,35,5,63]`：從 7 秒不會預讀到 63 秒、從 63 秒退到 35 秒也在範圍外、從 35 秒再退到 5 秒，最後才重新前進到 63 秒並驗證 reload。**這是針對測試設計的修復，CI 尚待驗證**。
- **[4803bbb](https://github.com/IvanaGyro/hongguo-dl/commit/4803bbb9496baaf1292e661285927410c91cb898)**：`src/bvc2-worker.js` 改用受限 streaming read helper 讀取最多 32MiB WASM，不再相信 Content-Length 後直接 `response.arrayBuffer()`。避免代理/CDN 以超量回應造成額外配置記憶體。
- **[fffd55c](https://github.com/IvanaGyro/hongguo-dl/commit/fffd55ce50142727c0ddf9b1a7f7cc9397bd9322)**：`scripts/bvc2-transcoder.c` 累計成功取得並送入 encoder 的畫格，若最後 0 張便明確回報 `no decoded ByteVC2 frames`，不再將只含音訊的輸出視為成功轉碼。此為保守防護，不代表實際 BVC2 解碼已通過。
- **[bd9a203](https://github.com/IvanaGyro/hongguo-dl/commit/bd9a2032251f12b7ebc64b1ad70607c9f4dac58c)**：BVC2 workflow 加入 C source trigger，重建 Librempeg+x264 WASM 並以真正 H.264 MP4 合成負例測試必須回報 `input is not ByteVC2`；使用者的真實 ByteVC2 bitstream / 畫格仍尚未驗證，不能改標 PASS。
- **下一步**：CENC browser 10/50/90 + 300s stress、1080p HEVC synthetic WASM、BVC2 negative test 依序取用已完成的結果；若有失敗只讀該失敗步驟。真實 1080p HEVC、Windows/Android 平台、ByteVC2 真實樣本仍是最終目標缺口。工作不因更新文件而停止。

## 階段 19 — 2026-11-13 P2 10/50/90% 與 P3 300 秒真實 Browser 驗收通過（已取得詳細 PASS 證據，繼續 P1 / BVC2）

- [Progressive CENC MSE browser #43279166406](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279166406)，job `131395647875`，**completed/success**；已核對真正 PASS 訊息與數值：
  - Chromium + Firefox 15 秒合成 H.264/AAC CENC：EOF 前第一影格、播放 >1.5 秒均 PASS。
  - Chromium + Firefox 70 秒合成 H.264/AAC：55 秒 unbuffered RAP seek、55 秒 reload resume、依序跨緩衝區 7s (10%) → 63s (90%) → 35s (50%) → 5s → 63s，全部 **PASS**。
  - Chromium + Firefox 從 90% 再 reload：均 PASS；切到下載模式後停止 Worker/Range，返回播放恢復同一集：均 **PASS**。
  - **Chromium 300 秒合成 CENC 實際播畢：PASS**。`video.ended=true`、`videoError=null`、`lastTime=300.021402s`、Range requests `32`、`maxBufferedSpan=78.021402s`、`maxBufferedAhead=41.395255s`、`samples=160`；沒有 unbounded 整檔下載。
- **結論可升級**：P2 Chromium/Firefox synthetic 10/50/90% Seek、reload、UI 模式切換核心案例已通過。P3 已有 Chromium 合成 300s 播畢與 MSE 秒數界限證據；**不是 OS/GPU RSS 高水位，尚未測 30–60 分鐘，也尚未測 Firefox 300s**。
- **P1 1080p proof 一次失敗並已修復**：[WASM #43278673487](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43278673487) 在產生 1080p 合成樣本時因測試 key 輸入 17 bytes（`Invalid encryption key len 17 expected 16`）fail，而非 HEVC decoder fail。已提交 [4099507](https://github.com/IvanaGyro/hongguo-dl/commit/40995072764b86f7a13d7304d462b60daa95b43f) 改為正確 16-byte key。修復後 [WASM #43279575089](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279575089) 最後 snapshot **in_progress**，不可事先標記 PASS。
- **BVC2 驗證**：[workflow #43279446447](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279446447) 最後 snapshot **in_progress**；包含 C decoder 無 frame 拒絕邏輯及 genuine H264 negative fixture。**不是有效 ByteVC2 positive video，仍不得聲稱可用**。
- **後續立即繼續**：更新 `docs/CENC-TEST-MATRIX.md` 的完成欄位，執行 1080p WASM proof 修復驗收、BVC2 negative tests、擴充取消時 Worker 零殘留／Firefox 長片測試或必要硬體檢查；不因本文件完成而停止。所有修改直接 main，無 PR。

## 階段 20 — 2026-11-13 P1 合成 1080p HEVC/AAC 無損 CENC remux PASS（繼續完成後續驗收）

- [Progressive CENC WASM proof #43279575089](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279575089)，job `131396947932`，**completed/success**；已讀實際 PASS 行：合成 `1920×1080 HEVC/AAC CENC progressive MP4` → Librempeg WASM remux clear fMP4，FFmpeg 可解碼，FFprobe 確認 `codec_name=hevc`、`1920×1080`、AAC，`PASS synthetic 1080p HEVC/AAC lossless CENC stream copy`。合成來源首個 moof 前未讀到 HTTP EOF。
- 同 run 的 HEVC 6 秒 seek PTS 驗收 **PASS first output video PTS 6**；Node 測試 **12 pass / 0 fail**。已成功生成、校驗並發布對應 JS/WASM/manifest。
- 此成功已修復前一 run 的**測試夾具加密 key 寫成 17 bytes** 錯誤（[4099507](https://github.com/IvanaGyro/hongguo-dl/commit/40995072764b86f7a13d7304d462b60daa95b43f)），不是 HEVC 修補。
- **嚴格的完成邊界**：**P1 合成 1080p HEVC 無損轉封裝已通過**，但真實紅果 HEVC HTTP 206、Windows 瀏覽器硬體 decoder、Android Firefox、真實音畫/EOF 前起播/完整播畢 **NOT TESTED**；不能把合成 FFmpeg 可解碼誤稱瀏覽器 HEVC 已驗證。
- 下一步繼續：記錄於 CENC test matrix；BVC2 native+x264 false positive/zero-frame 測試仍待單次確認；加強真實設備驗收與產物一致性。

## 階段 21 — 2026-11-13 BVC2 WASM ABI、真 H.264 負例及私密裝置 codec 診斷（持續實作中）

- **BVC2 合成負例已驗收**：[BVC2 Librempeg feasibility #43279446447](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279446447)，job `131396503668`，**completed/success**。Node/Emscripten 載入 decoder registered in WASM、x264 encoder link、invalid MP4 拒絕、真實 H.264 MP4 負例 `PASS BVC2 decoder rejects normal H.264 video`。已由 Actions 將更新後約 4.9 MiB `bvc2-core.wasm` 及配對 JS 直接推回 main，commit `8c5c6cb`（需再核對最新 HEAD 以確保不覆寫其他提交）。
- **不可誤導**：上述 BVC2 **都是 decoder ABI / 負例，不是 ByteVC2 真實正例影格、A/V 同步或速度驗證**；P4 仍受沒有可授權測試 bitstream 限制。既有 Worker 尚是整檔下載 + MEMFS 轉碼，不是低延遲串流轉碼。
- **新增可由 Windows／Android 使用者自行執行的無個資能力診斷**：`d0cd9a4` 新增 `src/codec-diagnostics.js`，查詢 `video.canPlayType`、`MediaSource.isTypeSupported`、1080p `MediaCapabilities.decodingInfo`，對 H.264、HEVC、HEVC Main10、標準 VVC 分別回報；不收 UA、影片 URL、DRM key、裝置 ID，且在報告文字明確標明 declarations 不等於 decode。
- **UI 與測試**：`b994680` 在 index.html 加入「此裝置影片編碼支援檢測」展開區／複製診斷結果；`69d6d76` 補樣式；`cb6bc1e` 在 src/main.js 接本地 UI；`7df7b65` 加 Node mocking tests；`8e64c50` 在 Chromium/Firefox 播放整合測試中驗證報告可生成且不含測試 CENC key。**新 UI browser CI 尚未取得 completed/success，不提前標 PASS**。
- 下一階段繼續實際檢查 UI build / browser 回歸並修正；具真實 HEVC MSE 裝置時可由使用者複製報告做平台解碼能力辨別。此面板不能自動證明真實 1080p HEVC 已可播。

## 階段 22 — 2026-11-13 HEVC 裝置能力診斷已通過 Browser CI；BVC2 JS/WASM 鎖版防護（發布中）

- **裝置診斷 UI 已驗證**：[Chromium/Firefox browser #43280440977](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280440977) **completed/success**，測試腳本實際點開本機編碼支援檢測，核對 schema/HEVC/MSE 項目與不含測試金鑰。 [main CI #43280440942](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280440942) **success**，不是實際裝置解碼測試。
- **BVC2 manifest 工具 [38c3237](https://github.com/IvanaGyro/hongguo-dl/commit/38c3237151d4ebcbc8dd401064b543544fc6d6f5)**：新 `scripts/bvc2-wasm-bundle.mjs` 產出 / 檢查 bvc2-core.mjs / wasm SHA256、C source/build shell 指紋、Librempeg/x264 commits、Emscripten pin。
- **BVC2 runtime [5573c8e](https://github.com/IvanaGyro/hongguo-dl/commit/5573c8ec38aa25f2c534a7a27920ae134ce8cac7) / [24b7c93](https://github.com/IvanaGyro/hongguo-dl/commit/24b7c93020e6706a0e226a232f055d91e9703467)**：Worker 使用 manifest no-store、content-addressed JS/WASM URL、大小有界的 bytes 讀取和 SHA256 驗證，**核驗後才 import/instantiate**。
- **BVC2 發布 [7f362ee](https://github.com/IvanaGyro/hongguo-dl/commit/7f362ee81316b4a9b92db11286bb484ec9a4909a)**：Workflow 在負例通過後將 JS/WASM/manifest 一起提交 main，rebase 後再次驗證指紋防止 stale build，並 dispatch Pages；新增 concurrency cancel-in-progress。此輪 [BVC2 WASM run #43280846374](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280846374) 最後快照 **in_progress**，未聲稱已成功發布。
- **BVC2 版本回歸 [82d8689](https://github.com/IvanaGyro/hongguo-dl/commit/82d8689edec716146532e014ae350c7dcd258b7a)**：本地 make/verify manifest、不匹配 WASM、修改 C 指紋、runtime JS/WASM 交換、錯版 x264 都有測試；[main CI #43280916523](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280916523) **success**（是工具測試，不代表已發布 release）。
- **BVC2 optional availability [4e4826f](https://github.com/IvanaGyro/hongguo-dl/commit/4e4826fb29d178e9bfcbee5619ee70bade0da8f1)**：部署的 manifest 若不存在或錯 MIME，不會假裝 ByteVC2 WASM 已可使用；避免 HTTP 200 的 Pages SPA 回應被誤判。仍缺真實 ByteVC2 bitstream 正例、CPU/RAM、首影格與 A/V。
- **下一步繼續**：待 BVC2 workflow 產物一起寫回 main，驗證 manifest 與部署，再增加 CI/Pages 發布守門；對 P1 真實 HEVC 仍須使用可回 206 的授權片源及 Windows/Android decoder，不能用能力宣告取代成功播放。

## 階段 23 — 2026-11-13 BVC2 發布守門與長片 RSS 量測（新增並待驗收，繼續下一階段）

- **[faefccb](https://github.com/IvanaGyro/hongguo-dl/commit/faefccb47316b7f1a243c8c630d8524f5a0f39c1)、[c26133a](https://github.com/IvanaGyro/hongguo-dl/commit/c26133a1be1766d0d7932b89acad9b01069c09f0)**：`main` 的 CI 與 Pages 加入 `node scripts/bvc2-wasm-bundle.mjs verify`，要求 experimental BVC2 JS/WASM/manifest 及原始碼 SHA256 完整一致，禁止不完整版本部署。須等新 [BVC2 WASM run #43280846374](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280846374) 發布 manifest 後才可通過；之前沒有 manifest 的中間版本 fail 不等於 decoder 壞掉。
- **[3498fd6](https://github.com/IvanaGyro/hongguo-dl/commit/3498fd6f0a4d30539a65b7797fb673621de0c18b)、[5a4397b](https://github.com/IvanaGyro/hongguo-dl/commit/5a4397b21e991296e9a328799c7f8ad30175a8f5)**：在 `tests/cenc-stream.browser.mjs` 的 300 秒 Chromium 合成長片測試中，每 2 秒以 Linux `ps` 取 **Node Playwright test harness + browser 子行程** 的 RSS 合計，記錄起始、peak、末尾、樣本數。這是具真實程序觀測的趨勢，但會重複計入 shared pages、涵蓋 Node harness、不包含 GPU driver 獨立配置，**不可當作精確瀏覽器或 Android 高水位**。現有 MSE 最大秒數/Range/完整播畢 PASS 仍維持；新 RSS 測試待 CI 完成才可記數值。
- **最新驗收守則**：只查已完成的工作一次、失敗再讀該 job 而非重複 poll。真實 HEVC / ByteVC2 positive content 仍需合法可用的片源，現有 403 不是解碼失敗。所有工作直接 main、不開 PR，更新本文件後繼續。

## 階段 24 — 2026-11-13 版本化 BVC2 WASM bundle 完成、positive fixture harness 建立（文件 checkpoint 後繼續）

- [BVC2 pinned bundle workflow #43280846374](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280846374)：**completed/success**，已讀 job `131401378125` 的 `PASS BVC2 decoder rejects normal H.264 video`、`Published verified experimental BVC2 JS/WASM pair and manifest`、`Verified BVC2 WASM/JS fingerprints and build provenance`。新 `public/bvc2/manifest.json` 已實際存在於 main，含 schema=1、兩個編譯產物 SHA256、C/build 指紋及 Emscripten/Librempeg/x264 固定版本。
- **CI/Pages 對應 BVC2 manifest 守門已上線**，例如 [main CI #43281675542](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43281675542) **success**。在 manifest 尚未發布的過渡期間，先前 CI/Pages 曾因來源/產物不一致 failure（為預期的發行阻擋）；不應將它誤判 BVC2 解碼 failure。
- **30 分鐘有界合成影片驗收**：`42744fd` 讓 CENC browser stress 可測 300／1800 秒；`373aa37` 的 workflow 用 480×270 6fps AAC 合成 1800 秒 CENC progressive MP4，16× 加速完整播放，驗證 MSE buffer、無全檔讀取與 Linux RSS 趨勢。最新 [browser #43281729069](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43281729069) 上次快照 **in_progress**，尚未標記 PASS。
- **ByteVC2 真實正例準備工具**：[3893f22](https://github.com/IvanaGyro/hongguo-dl/commit/3893f2231d346e5e9894d2015f6640648919aea1) 新增 `scripts/verify-bvc2-fixture.mjs`：只接收**使用者合法持有的本地檔案**，必要時從環境變數接 AES-CTR key，對 pinned BVC2→x264 WASM 實測、ffprobe 確認 H.264 非零畫格、FFmpeg 真正 decode、記時/RSS、刪除暫存明文；不 fetch signed URL，不提交內容。仍 **沒有真實 ByteVC2 bitstream 正例**，P4 無法標 PASS。
- `docs/bvc2-wasm.md` 已記錄安全驗證方式、上述證據、仍需真實 bitstream 的阻礙；下一步繼續驗收 1800 秒壓測、新 BVC2 bundle + Pages，修正任何實際 failed job，不因 checkpoint 停工。

## 階段 25 — 2026-11-13 30 分鐘回歸失敗：長 MP4 moov 超過 1MiB，已修補並新增邊界測試

- **可重現失敗**：[CENC browser #43281729069](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43281729069)，**completed/failure**，唯一失敗步驟 `Assert browser presents frames before HTTP EOF`。內部 Chromium/Firefox 15s 起播、55s/7s/63s/35s/5s 往返 seek/reload、切換下載模式、Chromium 300s 完整播放均 **PASS**；300s 量到 `maxBufferedSpan=78.021402s`，`processTreeRssMiB: first=769.2, peak=769.2, last=764.1, samples=20`（包含 Node test+browser 子行程及 shared pages）。
- **1800 秒新案例 FAIL 的具體診斷**：1800s 合成 MP4 約 `25,829,221` bytes；`[Hongguo EME] native stream unavailable: no-cenc-kid`，後續落回整檔 fetch，mock 僅允許 Range 故出現 `HTTP_416` 五次、最後 20 秒未能進入 MSE，而非 HEVC/MSE 解碼失敗。最可能原因：長片 `moov` 的 sample table >1MiB，而 `src/clear-key.js` 的 `MAX_MOOV` 過小，`probeCencKid` 因上限回傳 null。
- **修補 [40f324f](https://github.com/IvanaGyro/hongguo-dl/commit/40f324fd94b3c790fbf2bb881da9ef703d3e7101)**：將 metadata moov hard cap 從 1MiB 提至 **8MiB**；仍只發有界 HTTP Range，拒絕超量，並保持最多 4 次 metadata requests。不恢復無界 whole-response allocation。
- **新單元測試 [7e66b0b](https://github.com/IvanaGyro/hongguo-dl/commit/7e66b0bb20f9e0e4bc9ce569bfe7a2eae5649546)**：實造 1.25MiB `moov` 加 KID，期望兩次有界 Range 可取得 key；合成宣告超過 8MiB 的 `moov` 必須一次 header 判定拒絕、不再 fetch。**這是針對具體診斷所做修補，尚待新 1800 秒 Browser CI 通過才可升級 PASS**。
- **README 同步 [01c7d44](https://github.com/IvanaGyro/hongguo-dl/commit/01c7d445578abf81d583b96011ceb6bd43997e02)**：修正過時的「所有 seek／長片緩衝均未驗證」，列出新合成 CENC 55s/10/50/90%、300 秒、1080p HEVC 及 BVC2 negative 的真實 PASS，清楚標示真實來源／Android／ByteVC2 正例缺口。
- **後續**：繼續執行長片 code/test 閉環、新 30min browser proof；若長片 moov >8MiB，再以實際 log 與安全上限評估，不放寬到無界。完整驗收仍需合法真實 HEVC/ByteVC2 bitstream 與設備。

## 階段 26 — 2026-11-13 中斷復原 checkpoint：確認最新成功、待測 1800s，重啟程式碼稽核

- **重讀而非依賴聊天記憶**：此 checkpoint 前的 main HEAD 為 `5c3732fd4c4699204269fb81bfa5b5dc8bbfe7dd`；[CI #43283368259](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283368259)、[Pages #43283367990](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283367990)、[Firefox FFmpeg.wasm browser #43283368069](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283368069) **completed/success**。
- **1800s 狀態不冒稱成功**：[較早的 #43283216947](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283216947) 查詢當下 **in_progress**；[當前 #43283368141](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283368141) **pending**。修正 8MiB moov 後，30 分鐘瀏覽器壓測是否通過**尚未確證**。既有 300s/seek 的成功證據在階段 25。
- **實際重新檢查的程式碼**：`src/clear-key.js` 的 metadata Range 上限 8MiB，`src/bvc2.js` Worker 轉碼採 transferable ArrayBuffer；`src/player.js` 和 `src/main.js` 的呼叫點目前均直接傳新下載的 Uint8Array，未確認實際有共享 cache detachment bug，**不能把風險當成確定 bug**。
- **發現可具體處理的競態**：`transcodeBvc2()` 在初始 `signal.aborted` 檢查與 Worker 建立／註冊 abort listener 之間有時間窗；`worker.postMessage()` 同步 throw 時也可能留下未終止 Worker。下一步補原始碼防護與測試；尚未提交程式碼、尚未跑相關測試。
- **必須同步修正的過時交接**：`docs/NEXT-SESSION-PLAN.md` 的 P2 仍寫「Worker 尚無 seek 路徑」、P3 仍寫「無 MSE eviction」，均已被目前程式碼及合成 CI 推翻；`docs/cenc-progressive-to-fmp4.md` 仍寫 1MiB moov、長片/seek 未測及 WASM 發布未完成。修正時保留歷史脈絡，明確區分 synthetic PASS 與真實裝置 NOT TESTED。
- **使用者作業規則**：所有成果直接提交 `main`，不建立 PR。GitHub 操作可能卡在讀/寫/查詢本身，不僅 Actions；單次獨立讀→修改→提交，避免反覆重試或連續輪詢。**每完成一段程式與驗證就立即再寫下一個 checkpoint，寫完文件還要繼續修復。**

## 階段 27 — 2026-11-13 BVC2 Worker 啟動／取消競態已修補，已提交 7 個回歸案例

- [b57923f](https://github.com/IvanaGyro/hongguo-dl/commit/b57923f1ae69389a1d7ea3d209f2f5ddd1c498d0)：新增 `src/bvc2-job.js`，抽出單次 ByteVC2 Worker 的啟動、傳輸、abort、完成與資源清理，方便 Node 單測。初始化時若 AbortSignal 已在 Worker 建立過程取消，**不會 postMessage**；postMessage 同步拋錯時，會 terminate Worker 並移除 abort listener。驗證 Worker 回傳的影片 buffer 必須為非空 ArrayBuffer。
- [90603dd](https://github.com/IvanaGyro/hongguo-dl/commit/90603dd4ecb9ef74a7c2963d84449fded3e40ee1)：`src/bvc2.js` 改用上述 helper，播放與下載兩路均共用，保留 260MiB 上限、key 驗證及工作專屬 buffer 的可轉移語意；subarray 或 SharedArrayBuffer 改為複製選中範圍再傳，避免無關 bytes 或 DataCloneError。
- [8f9d4c7](https://github.com/IvanaGyro/hongguo-dl/commit/8f9d4c73a5228991a1db7b19a26a080f014d412f)：新增 `tests/bvc2-job.test.mjs` 共 **7** 個測試：正常返回、subarray、建 Worker 期間取消、post 後取消、同步 postMessage throw、空回應、建 Worker throw。
- **驗收狀態**：原始碼與測試已提交 main，測試**尚未取得執行結果**；下一步只核對一次適用 CI 結論，若失敗針對具體錯誤修補。這些是 Worker lifecycle 回歸，**不是 ByteVC2 真實 bitstream 正例解碼成功**。
- **立即繼續**：更新過期的 NEXT-SESSION-PLAN 和 CENC 技術文件，使完成／未完成明確，並把 1800 秒壓測視為獨立的 pending acceptance；文件更新後仍繼續程式與驗收。

## 階段 28 — 2026-11-13 30 分鐘 CENC 合成瀏覽器驗收 PASS，BVC2 lifecycle CI 成功

- **已完成、已讀 log 的 1800 秒實證**：[Browser #43283216947](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283216947)，job `131409687391`，**completed/success**。實際輸出 `PASS chromium 1800-second CENC playback and bounded MSE window`，`maxDurationSeconds=1800.021402`、`lastTime=1800.021402`、`ended=true`、`videoError=null`、`rangeRequests=104`、`samples=530`；`maxBufferedSpan=72.0s`、`maxBufferedAhead=43.555s`。
- 同一 1800s 合成片的首影格測試 **PASS before HTTP EOF**：480×270 H.264/AAC，25,829,221 bytes，首影格已到時下載約 **6.6%**，11 HTTP Range requests；8 MiB moov 補丁對大索引能端到端起播，不再 fallback HTTP 416。
- 同 job 量測的 Linux test harness+Chromium process-tree RSS（粗估、不等於單一 browser/GPU/Android RAM）：`first=802.5 MiB`、`peak=838.8 MiB`、`last=838.2 MiB`、`samples=58`。未出現隨播放 1800s 無限制攀升的明顯跡象，但末尾高於起點，後續仍可檢查 pauses／重複切集；不可宣稱精確的記憶體 leak-free 上界。
- 同 job **300 秒 PASS**：`ended=true`、`maxBufferedSpan=72s`、`ahead=41.127s`、32 Range，RSS first/peak/last=751.7/773.8/773.8 MiB；Chromium/Firefox 55s、7→63→35→5→63s unbuffered seek/續播與模式切換也均有實際 PASS 行。
- **BVC2 新測試驗收**：[CI #43284208866](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43284208866) 對含 7 個 Worker lifecycle tests 的 main commit `8f9d4c7` **completed/success**；[CI #43284268205](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43284268205)、[Pages #43284268437](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43284268437) 亦 **success**。這驗證單元與 build，不等於 BVC2 真實 frame proof。
- **文件已更新**：[NEXT-SESSION-PLAN.md](NEXT-SESSION-PLAN.md) commit [e02dbd4](https://github.com/IvanaGyro/hongguo-dl/commit/e02dbd44b1b549dbfbbf0daf5fba2ede9eaf372a) 清除過時的「沒有 seek/eviction/主分支發布」描述；[cenc-progressive-to-fmp4.md](cenc-progressive-to-fmp4.md) commit [f5fb50c](https://github.com/IvanaGyro/hongguo-dl/commit/f5fb50c6c97e2d70c1dd63d365ae968de95c2789) 更新架構與 8MiB moov；[CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md) commit [f66c66b](https://github.com/IvanaGyro/hongguo-dl/commit/f66c66b7c7945b55df1628ce2e0dcdfcaaae75a8) 正式將 1800s PASS 列入矩陣。
- **未解限制，不能偷換**：真實紅果 1080p HEVC + CENC 的瀏覽器首影格/音畫/播畢、Android Firefox 真實裝置、ByteVC2 合法正例均 NOT TESTED；本次 1800s 仍是 synthetic 6fps H.264，不是 HEVC。
- **下一步不停止**：繼續 code-level 稽核 CENC/Worker 流式網路與取消/失敗狀態，優先找可補回歸的具體問題。勿連續查同一 Actions；如有新發現，先 code+test，立即新增 checkpoint。
