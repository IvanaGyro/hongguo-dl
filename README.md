# Hongguo DL

紅果短劇網頁播放器與下載佇列管理器，採用 **Bun + GitHub Pages 靜態網頁 + Cloudflare Worker API**。支援劇集 ID、官方分享網址與白名單媒體直連網址；提供逐集播放、續播、自動下一集與本機下載佇列（不提供全站搜尋）。請只下載您有權保存的內容。

## 功能

- 逐集選取、批次佇列（同時 1–3 集）、下載百分比與位元組、HLS 分片數、取消、重試、錯誤代碼與原因。
- 播放模式使用 **Video.js 10（`@videojs/html@10.3.0`）** 的播放／暫停、時間軸、靜音、手勢及全螢幕元件；保留專案自訂的上一集／下一集、畫質／編碼、續播、自動下一集與支援時的子母畫面。集數格以整塊背景表示觀看進度。
- 播放來源的畫質和編碼**逐集依實際 metadata 連動**。測試影集第 30 集的 1080p 為加密 HEVC，720p/540p/480p/360p 為加密 ByteVC2。**ByteVC2 與標準 VVC/H.266 不相容**，不能由瀏覽器的 `vvc1` 支援判斷。若 Librempeg WASM 資產未部署，當使用者已選定存在但只有 ByteVC2 的 720p 等畫質時，會保留所選畫質、停用不存在的 HEVC 編碼選項，並明確提示無法播放，**不再靜默改選 1080p**；若資產已部署，則在獨立 Worker 以有界 HTTP Range 讀取 CENC MP4 → ByteVC2 解碼 → x264 編碼 → H.264 fMP4/MSE 串流，保留實際來源畫質標籤並顯示輸出轉碼資訊。**後者仍屬實驗功能，尚未完成真實 ByteVC2 影格驗證，預設不會啟用；僅在網址加入 `bvc2_stream=experimental` 後啟用。預設保留整集下載／WASM 轉碼，會顯示完整下載與轉碼進度警告。**
- **CENC 一般加密 MP4 增量播放（實驗性）**：精簡 Librempeg WASM 透過 HTTP Range 的自訂 AVIO 逐段讀取並解密，保留原有 H.264/HEVC、AAC 壓縮封包，重新封裝為 clear fMP4，經 MSE 播放；不是重新編碼。已在 Chromium 與 Firefox 的合成 H.264/AAC 加密一般 MP4 上確認**第一個影格在來源未下載完時呈現、持續播放超過 1.5 秒**；並在 Node.js WASM 中驗證合成 HEVC/AAC 完整輸出可解碼。**合成素材**已在 Chromium／Firefox 驗證第 7／35／63 秒等未緩衝位置往返 Seek、重新整理續播與播放／下載模式切換；Chromium 合成 300 秒影片完整播畢，MSE 緩衝最大約 78 秒。1920×1080 HEVC/AAC 合成加密樣本已確認 WASM 無損轉封裝與 FFmpeg 解碼。**真實紅果 1080p HEVC 的瀏覽器影格／音訊、Android Firefox、作業系統與 GPU 記憶體仍待驗證**。已分段加密 fMP4 繼續走原生 EME/MSE；在容器／編碼允許時保留既有 FFmpeg.wasm 備援，但 CDN HTTP 403/429、錯誤 206 範圍及其他明確來源失效**不得降級整檔下載**。
- **自動下一集預取**：僅在播放中、接近片尾時準備**下一集一集**（依觀察到的起播耗時調整，約提前 45–90 秒，短片依比例縮短）。若目前走原生加密串流，下一集只預取片源 metadata，**不會偷偷先下載完整下一集**；傳統 FFmpeg 路徑才會在 32 MiB 讀取上限內預轉換。節省數據模式會停用預取，跳集／關閉自動連播會取消。
- 下載模式提供選集佇列、逐集手動儲存、從佇列勾選多集匯出單一 ZIP 或 MP4 無損合併；ZIP 可混合影集，MP4 合併僅接受相容的同一影集。
- Worker 以 **Rust/WASM** 計算 SM3、Argus Simon、Ladon／Helios、Gorgon，以及 Medusa 的 XM-XOR、自訂 AES V3、F13 雜湊與 IV／校驗碼；Bun 負責建置與測試，JavaScript 保留瀏覽器、網路與部分協定組裝 API。
- 未加密且無需轉換的原始影片可直接串流寫入已選取的本機資料夾；加密或需處理的影片使用 FFmpeg.wasm 解密、無損封裝 MP4 或轉 H.264。HLS VOD 清單解析／改寫由可獨立測試的純函式處理。
- 以 `window.showDirectoryPicker()` 是否可使用決定是否直接寫入資料夾，**不依瀏覽器名稱判斷**。Android Firefox 等不支援此 API 的瀏覽器會把已完成分集暫存至 IndexedDB，**不會逐集自動跳出存檔對話框**；使用者自行決定何時逐集儲存或匯出。
- ZIP64 優先透過 Service Worker 串流匯出，無法轉移 ReadableStream 時提供有容量上限的 Blob 備援。
- 最近影集、觀看進度及佇列狀態保存在 localStorage；已完成分集的 Blob 暫存於 IndexedDB。重開網頁後未完成的串流需手動重試，已完成的暫存也可能被瀏覽器回收。影片內容不傳回 GitHub Pages，也不儲存在 Cloudflare。

## 架構與限制

```text
GitHub Pages (Bun/Vite)        Cloudflare Worker           官方來源
   網頁播放器                 /api/series  ----------->  官網分集資料
   下載佇列   ------------->  /api/source  ----------->  App / 公開片源
   FFmpeg.wasm                /api/media   ----------->  影片 CDN (Range)
       |
       +-- localStorage: 最近影集 / 觀看進度 / 佇列狀態
       +-- IndexedDB: 已完成的分集 Blob
       +-- Service Worker 串流 ZIP / MP4 無損合併 / 本機資料夾
```

Worker 是**唯一需要執行的服務端運算**。GitHub Pages 沒有反向代理能力，無法直接替代 Worker。因為是不同網域，Worker 僅允許設定的網站 Origin 存取 API，預設包含 `https://ivanagyro.github.io`（不會因為頁面子路徑而改變 Origin）。亦可設定 Worker 環境變數 `FRONTEND_ORIGINS`，例如 `https://www.example.org,https://another.example.org`。CORS 不是驗證機制，公開部署前仍建議設置 Cloudflare Rate Limiting / WAF。

### 1. 安裝 Bun 與執行驗證

安裝 [Bun](https://bun.sh/) 後，於儲存庫目錄執行：

```sh
bun ci
bun run test
bun run build
```

FFmpeg.wasm 核心由建置腳本 gzip 壓縮成約 9.8 MiB，避免 Cloudflare Worker Assets 的 25 MiB 限制。此版實際部署在 GitHub Pages，不再需要把此檔案放進 Worker。

### 2. 部署 Cloudflare Worker

```sh
bunx wrangler login
bun run deploy:worker
```

記下 Wrangler 提供的 HTTPS Worker 網址，例如 `https://hongguo-dl.<your-subdomain>.workers.dev`。**Worker 只託管 `/api/*`，不託管靜態檔案**。每次更新 Worker 可再執行 `bun run deploy:worker`；不用重新建置 GitHub Pages 前端。

### 3. 部署 GitHub Pages

1. 進入 [此儲存庫 GitHub Pages 設定](https://github.com/IvanaGyro/hongguo-dl/settings/pages)，在 **Build and deployment → Source** 選取 **GitHub Actions**。
2. 在 `main` 分支包含此工作流程之後，`.github/workflows/pages.yml` 會在每次 push main 時，用 Bun 建置並部署 `dist/`；也可在 Actions 手動執行 `workflow_dispatch`。
3. 網站預期網址為 `https://ivanagyro.github.io/hongguo-dl/`，Vite base path 已設定為 `/hongguo-dl/`，FFmpeg.wasm 壓縮核心亦使用此路徑。
4. 在 GitHub 儲存庫 **Settings → Secrets and variables → Actions → Variables** 新增 `PROXY`，內容填入 **Cloudflare Worker 的公開 HTTPS 網域根網址**，例如 `https://hongguo-dl.<your-subdomain>.workers.dev`。下一次執行 `.github/workflows/pages.yml` 時會自動帶入前端的 `VITE_API_ORIGIN`，第一次開啟網站就有預設 API 網址；舊變數 `HONGGUO_WORKER_ORIGIN` 僅作備援。
5. 你可以在網站「**Cloudflare Worker API 設定**」另存自己的 Worker 網址，這個瀏覽器的設定會優先於網站預設。按「**恢復網站預設**」可刪除本機覆寫設定，改用最新 Pages 建置帶入的 `PROXY`。如果 `PROXY` 沒有設定，GitHub Pages 仍需使用者手動填寫。

`PROXY` 是公開的前端建置設定，**不可放 API token、密碼或其他秘密**。新增或修改 `PROXY` 後需重新部署 GitHub Pages，已在瀏覽器儲存的自訂網址則不會自動被覆蓋。

### 本機開發

使用兩個終端機：

```sh
bun run dev:worker   # http://127.0.0.1:8787
bun run dev          # http://localhost:5173
```

Vite 會將本機的 `/api/` 轉發到 Worker。不要在本機設定 `VITE_API_ORIGIN`，即可使用此代理。

## 真實片源低頻 CI 驗證

- [Live Worker source smoke](https://github.com/IvanaGyro/hongguo-dl/actions/workflows/live-worker-smoke.yml) 與一般 CI 分開，**每週一 04:17 UTC** 自動測試 **1 集**；也可以在 Actions → Run workflow 手動選 **1 或 2 集**。不會因每次 push 而對真實來源發送請求。
- 每次執行只取得 **1 次** `/api/series` 分集 metadata，每集 **1 次** `/api/source`，並最多對 **2 個不同 CDN** 分別送出 `Range: bytes=0-255`。1 集最多 4 個請求，手動 2 集最多 7 個。**不下載完整影片、不自動重試、遇到 HTTP 429 立即停止**，測試日誌不輸出簽章 URL 或內容金鑰。
- 驗證官方分集、來源變體、GitHub Pages CORS、206 Partial Content 與 HTTP Range；若 CDN 403 或無法取得有效 206，工作流程會明確失敗，以便區分來源故障與本地 mock 測試。真實播放器解密、Android Firefox 實機與影片接續播放**仍須另外測試**。
- 原有 Firefox 的 60 集 ZIP 測試使用**合成影片／mock 來源**，不會向紅果取得 60 集實際媒體。

## CENC 一般 MP4 增量播放驗證

- [Librempeg Asyncify WASM 編譯與 HEVC/AAC 無損解密重封裝](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43220527985)：合成 HEVC/AAC CENC MP4，來源 114,718 bytes，WASM 在讀取 32,768 bytes 時已輸出第一個片段，完成輸出可由 FFmpeg 解碼。
- [Chromium + Firefox 首影格與持續播放驗證](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43224107343)：合成 1.24 MB 的 H.264/AAC CENC 一般 MP4，使用真正 HTTP Range 與 Worker/MSE；兩者均於來源 EOF 前呈現影格，並持續播放超過 1.5 秒，無整檔下載備援。
- [設計與待測限制](docs/cenc-progressive-to-fmp4.md)。測試以合成內容進行，不能直接推出真實紅果 HEVC 在所有裝置可播放。

## 最新合成串流驗收證據

- [Chromium／Firefox CENC Browser #43279166406](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279166406)：合成 H.264/AAC 加密一般 MP4 在 EOF 前起播，往返 7／63／35／5／63 秒遠端 RAP Seek、90% reload 續播、切換下載模式取消 Worker／Range，兩個瀏覽器均 PASS。
- 同一 Browser CI：Chromium 300 秒合成片完整播放至 300.021 秒，最大 MSE 緩衝跨度 78.021 秒、ahead 41.395 秒，共 32 次有界 Range 請求。這是緩衝時間窗口，**不是**系統 RSS/GPU RAM 精確數據。
- [1080p HEVC/AAC WASM #43279575089](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279575089)：合成 1920×1080 CENC 解密重封裝後 FFmpeg 可解碼、保留 HEVC/AAC，6 秒 RAP Seek 輸出 PTS=6。**不代表**瀏覽器具有 HEVC 解碼器。
- [BVC2 ABI／負例 #43279446447](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279446447)、[BVC2 配對發布 #43280846374](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280846374)：專用 BVC2 + x264 WASM 可載入，普通 H.264 被拒絕，JS／WASM 發布版本以 SHA256 manifest 綁定。**尚未驗證**真正 ByteVC2 的正例影格與轉碼表現。
- 網頁「此裝置影片編碼支援檢測」可以在本機讀取 HEVC/MSE、MediaCapabilities 宣告並複製結果，不收 signed media URL、金鑰或裝置 ID；**宣告結果不是實際解碼通過**。
- 完整最新矩陣：[CENC-TEST-MATRIX.md](docs/CENC-TEST-MATRIX.md)，階段日誌：[AGENT-PROGRESS.md](docs/AGENT-PROGRESS.md)。所有測試與原始碼直接提交 `main`，不使用 PR。

## 已知限制

- 2026-11-12 已對測試影集 `7699513062054710296` 實際呼叫正式 Worker：取得 60 集清單、1080p HEVC／720p ByteVC2 來源，並以限量 HTTP Range 確認可取得第一集加密 HEVC MP4 索引（完整 `moov`、無 `mvex`）。**合成加密一般 MP4 的 Librempeg WASM 增量播放、跨未緩衝 Range Seek、reload 續播及 Chromium 300 秒播放已獨立驗證；未完成的是紅果真實 HEVC 首影格、Android Firefox 硬體解碼、以及設備 RAM/GPU 高水位。**
- 單集 Blob staging 上限 300 MiB；FFmpeg.wasm 來源讀取／HLS 分片 staging 上限約 320 MiB；ZIP 的 Blob 備援限 240 MiB；MP4 無損合併總輸入限 160 MiB。下載儲存途徑只有未加密且無需轉碼的原始串流能直接串流寫入資料夾，**不能保證 60 集可無損合併成一個 MP4**。
- [ByteVC2 WASM 實驗](docs/bvc2-wasm.md)：已成功建置約 **20 MiB** 的單執行緒 Librempeg `bvc2` 解碼與 x264 編碼核心，並完成 Node.js 實際載入、ABI 檢查及錯誤輸入拒絕測試。瀏覽器播放及下載 H.264 的程式已具備可取消的 Worker 路徑；**但尚未以權限允許的真實 ByteVC2 MP4 驗證成功解密、輸出影格、音訊同步、速度與記憶體**。ByteVC2 播放改用 Asyncify AVIO Range 讀取與 H.264 fMP4/MSE，支援背壓、取消與索引跳轉；下載轉碼仍在 MEMFS 內保存完整輸入／輸出，輸入上限 260 MiB。Android Firefox 實機效能未知。沒有 WASM 時仍會明確提示或回退。來源沒有可靠音軌／字幕 metadata 時不顯示虛構選項。
- 不支援 DRM 授權、直播 HLS、斷點續傳或使用者登入。重新載入頁面會中斷下載；不會保存已簽章媒體 URL 或影片密鑰。
- HLS 清單資源辨識、標籤 URI 改寫與分片上限檢查在 `src/hls-playlist.js`，不執行網路 I/O；`src/ffmpeg.js` 再依解析結果下載、去重與暫存分片，進度按照清單中的**邏輯分片數**計算。
- 不接受任意網域的反向代理請求。Worker 驗證 HTTPS 網址與每次重新導向，使用者 Cookie 與授權標頭不會被透傳。

## ByteVC2 核心與效能驗證

`public/bvc2/bvc2-core.mjs`、`bvc2-core.wasm`、`manifest.json` 由 `.github/workflows/bvc2-wasm-probe.yml` 從固定的 Librempeg、x264、x265、libaom 和 VVenC 原始碼重現建置（不透過第三方轉碼服務）。建置 workflow 的 ABI smoke test 通過後才發佈核心。網頁初次載入不會下載大型 ByteVC2 核心；選到 ByteVC2 片源或 H.265／AV1／標準 VVC 下載轉碼時才載入。WASM 使用單執行緒與獨立 Worker，可取消，但仍會在使用者裝置上消耗 CPU。

> **尚未驗收**：真實 ByteVC2 解碼畫面／音畫同步、真實紅果 1080p HEVC 瀏覽器播放、Android Firefox HEVC 解碼，以及 30–60 分鐘 RAM／GPU 記憶體高水位。**已通過**的是合成 Chromium／Firefox 跨未緩衝區 Seek、reload 續播、播放／下載模式切換及 Chromium 300 秒 MSE 緩衝回收。ByteVC2 的增量解碼／重編碼與 H.264/HEVC 的增量無損重封裝使用獨立 Worker 與核心。

## 授權與第三方來源

本專案及衍生檔案採 GPL-3.0-only。 `worker/vendor/` 修改自 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的播放取源模組；FFmpeg.wasm 於建置時取得，並遵循相關授權。詳見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 和 [LICENSE](LICENSE)。

## 下載輸出與處理進度

「來源編碼」篩選上游實際提供的片源；「輸出」可選原編碼、H.264、H.265、標準 VVC/H.266、AV1。
原編碼在來源加密時只解密／重新封裝，不重編碼；ByteVC2 以自己的 `bvc2` / `bv2C` 保留，並非標準 VVC。
上游常見的 720p 以下 ByteVC2、1080p HEVC 分布仍以逐集 metadata 為準。

H.265 使用單執行緒 x265、AV1 使用 libaom、標準 VVC 使用 VVenC。轉碼在本機 Worker 執行，
保留第一條 AAC 音軌；慢速裝置或長影片可能需要較久，佇列顯示下載與轉碼各自的進度、已耗秒數與估計剩餘時間。
切換至轉碼階段後，進度條依實際處理影片時間更新，不會因輸入已下載完成而提前顯示 100%。
下載轉碼仍有 260 MiB 輸入與 1 GiB WASM 線性記憶體上限；大量集數依序處理、分別匯出或使用 ZIP。

離線驗證：`node scripts/verify-video-outputs.mjs` 產生合成加密 H.264/AAC，檢查四種實際編碼、完整影格、
AAC 時間軸、原編碼 packet hash，以及 Asyncify Range → fMP4。另以標準 VVC 畫格合成 `bvc2`/`bv2C`
封裝來驗證 BVC2 解碼器與原編碼 round-trip；**這不代表已驗收真實 BTY2 片源或 Android 效能**。
CI 另外以 `tests/bvc2-stream.browser.mjs` 驗證合成 BVC2 封裝的 MSE 畫格、模式切換清理與五種下載輸出。
