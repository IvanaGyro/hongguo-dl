# Hongguo DL

紅果短劇網頁播放器與下載佇列管理器，採用 **Bun + GitHub Pages 靜態網頁 + Cloudflare Worker API**。支援劇集 ID、官方分享網址與白名單媒體直連網址；提供逐集播放、續播、自動下一集與本機下載佇列（不提供全站搜尋）。請只下載您有權保存的內容。

## 功能

- 逐集選取、批次佇列（同時 1–3 集）、下載百分比與位元組、HLS 分片數、取消、重試、錯誤代碼與原因。
- 播放模式使用 **Video.js 10（`@videojs/html@10.3.0`）** 的播放／暫停、時間軸、靜音、手勢及全螢幕元件；保留專案自訂的上一集／下一集、畫質／編碼、續播、自動下一集與支援時的子母畫面。集數格以整塊背景表示觀看進度。
- 播放來源的畫質和編碼**逐集依實際 metadata 連動**。以 `7699513062054710296` 第 30 集為例：1080p 是加密 HEVC，720p/540p/480p/360p 是加密 ByteVC2/VVC；目前 FFmpeg.wasm **不能播放加密 VVC**，因此會在下載前阻止無效的解密重試。只有在瀏覽器支援其他片源時才會明確提示並切換到其他畫質；不會把 1080p HEVC 誤稱為 720p。
- **起播仍須先取得完整單集**：加密 MP4 仍由 FFmpeg.wasm 解密並封裝後交給 Video.js；影片下載與 FFmpeg 初始化可重疊，但並非真正的逐段解密播放。若要消除初次播放的下載等待，尚需另行實作並驗證分段解密與串流播放。
- **自動下一集預取**：僅在播放中、接近片尾時開始準備**下一集一集**（依本次觀察到的起播耗時調整，約提前 45–90 秒，短片依比例縮短），已準備的資料可直接在下一集接續使用；若仍在下載則接手既有工作，不重複下載。預取的媒體讀取上限 32 MiB，瀏覽器省流量模式會停用，跳集或關閉自動連播時會取消。預取失敗不會影響當前播放。
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

## 已知限制

- 2026-11-12 已對測試影集 `7699513062054710296` 實際呼叫正式 Worker：取得 60 集清單（官方標示前 5 集可看）、HEVC／ByteVC2 來源及部分 `206 Partial Content` HTTP Range 回應。**尚未完成真實影片解密播放、畫面 seek、Android Firefox 實機與大型 ZIP 端對端驗證**。來源 API、CDN 仍可能因地區或來源變更失敗。
- 單集 Blob staging 上限 300 MiB；FFmpeg.wasm 來源讀取／HLS 分片 staging 上限約 320 MiB；ZIP 的 Blob 備援限 240 MiB；MP4 無損合併總輸入限 160 MiB。只有未加密且無需轉碼的原始串流能直接串流寫入資料夾，**不能保證 60 集可無損合併成一個 MP4**。
- 標準 FFmpeg.wasm **不保證 ByteVC2/VVC 解碼**，因此允許選取 ByteVC2 不代表可以轉成 H.264 或在瀏覽器直接播放；HEVC 播放也取決於系統能力。來源未提供可靠的音軌／字幕軌 metadata 時，不顯示虛構的選軌選項。
- 不支援 DRM 授權、直播 HLS、斷點續傳或使用者登入。重新載入頁面會中斷下載；不會保存已簽章媒體 URL 或影片密鑰。
- HLS 清單資源辨識、標籤 URI 改寫與分片上限檢查在 `src/hls-playlist.js`，不執行網路 I/O；`src/ffmpeg.js` 再依解析結果下載、去重與暫存分片，進度按照清單中的**邏輯分片數**計算。
- 不接受任意網域的反向代理請求。Worker 驗證 HTTPS 網址與每次重新導向，使用者 Cookie 與授權標頭不會被透傳。

## 授權與第三方來源

本專案及衍生檔案採 GPL-3.0-only。 `worker/vendor/` 修改自 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的播放取源模組；FFmpeg.wasm 於建置時取得，並遵循相關授權。詳見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 和 [LICENSE](LICENSE)。
