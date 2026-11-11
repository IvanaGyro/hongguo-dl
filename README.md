# Hongguo DL

紅果短劇下載管理器，採用 **Bun + GitHub Pages 靜態網頁 + Cloudflare Worker API**。介面只處理劇集 ID、官方劇集網址或列入白名單的媒體直連網址，不搜尋或播放影片。請只下載您有權保存的內容。

## 功能

- 逐集選取、批次佇列（同時 1–3 集）、下載百分比與位元組、HLS 分片數、取消、重試、錯誤代碼與原因。
- 公開來源優先；可選自動畫質、720p、1080p，以及不限編碼、H.264、HEVC 或 ByteVC2。
- Worker 以 **Rust/WASM** 計算 SM3、Argus Simon、Ladon／Helios、Gorgon，以及 Medusa 的 XM-XOR、自訂 AES V3、F13 雜湊與 IV／校驗碼；Bun 負責建置與測試，JavaScript 保留瀏覽器、網路與部分協定組裝 API。
- 原始影片串流直接寫入本機；視需要載入 FFmpeg.wasm 無損封裝 MP4 或轉 H.264。HLS VOD 清單解析／改寫由可獨立測試的純函式處理，瀏覽器僅負責分片下載與 FFmpeg 檔案寫入。
- 依照 `window.showDirectoryPicker()` 是否存在決定串流寫入資料夾或 Blob 下載，**不會以 Firefox/Chrome 名稱判斷**。
- 本機下載紀錄保存在 localStorage，重開網頁後未完成工作需要重新開始，影片內容不傳回 GitHub Pages 或儲存在 Cloudflare。

## 架構與限制

```text
GitHub Pages                  Cloudflare Workers                  官方來源
/ hongguo-dl/ (Vite)       →  /api/series                     →   官網分集資料
  Bun 建置的靜態頁面       →  /api/source                     →   App / 公開片源
  下載管理器 + FFmpeg.wasm →  /api/media (串流與 Range)       →   影片 CDN
         ↓
   使用者的本機檔案系統（若 API 不支援，則 Blob 下載）
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

## 已知限制

- 未對真實紅果片源執行端對端驗證；來源 API 可能因區域、反爬措施或來源變更失敗。
- Blob fallback 上限每集 300 MiB；FFmpeg.wasm 輸入／HLS 分片 staging 上限約 320 MiB。只有未加密且無需轉碼的原始串流能直接串流寫入資料夾。
- 標準 FFmpeg.wasm **不保證 ByteVC2/VVC 解碼**，因此允許選取 ByteVC2 不代表可以轉成 H.264。
- 不支援 DRM 授權、直播 HLS、斷點續傳或使用者登入。重新載入頁面會中斷下載；不會保存已簽章媒體 URL 或影片密鑰。
- HLS 清單資源辨識、標籤 URI 改寫與分片上限檢查在 `src/hls-playlist.js`，不執行網路 I/O；`src/ffmpeg.js` 再依解析結果下載、去重與暫存分片，進度按照清單中的**邏輯分片數**計算。
- 不接受任意網域的反向代理請求。Worker 驗證 HTTPS 網址與每次重新導向，使用者 Cookie 與授權標頭不會被透傳。

## 授權與第三方來源

本專案及衍生檔案採 GPL-3.0-only。 `worker/vendor/` 修改自 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的播放取源模組；FFmpeg.wasm 於建置時取得，並遵循相關授權。詳見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 和 [LICENSE](LICENSE)。
