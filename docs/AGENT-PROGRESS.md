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
