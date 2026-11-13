# Hongguo DL

紅果短劇網頁播放器與下載佇列管理器，採用 **Bun + GitHub Pages 靜態網頁 + Cloudflare Worker API**。支援劇集 ID、官方分享網址與白名單媒體直連網址；提供逐集播放、續播、自動下一集與本機下載佇列（不提供全站搜尋）。請只下載您有權保存的內容。

## 功能

- 逐集選取、批次佇列（同時 1–3 集）、下載百分比與位元組、HLS 分片數、取消、重試、錯誤代碼與原因。
- 播放模式使用 **Video.js 10（`@videojs/html@10.3.0`）** 的播放／暫停、時間軸、靜音、手勢及全螢幕元件；保留專案自訂的上一集／下一集、畫質／編碼、續播、自動下一集與支援時的子母畫面。集數格以整塊背景表示觀看進度。
- 播放來源的畫質和編碼**逐集依實際 metadata 連動**。測試影集第 30 集的 1080p 為加密 HEVC，720p/540p/480p/360p 為加密 ByteVC2。**ByteVC2 與標準 VVC/H.266 不相容**，不能由瀏覽器的 `vvc1` 支援判斷。若 Librempeg WASM 資產未部署，當使用者已選定存在但只有 ByteVC2 的 720p 等畫質時，會保留所選畫質、停用不存在的 HEVC 編碼選項，並明確提示無法播放，**不再靜默改選 1080p**；若資產已部署，則在獨立 Worker 嘗試 CENC MP4 → ByteVC2 解碼 → x264 編碼成 H.264 MP4，保留實際來源畫質標籤並顯示輸出轉碼資訊。**尚未驗證真實 ByteVC2/BTY2 影格及音畫同步。預設沿用整集下載與 WASM 轉碼；僅透過網址 `bvc2_stream=experimental` 明確啟用增量轉碼測試，且有記憶體及效能限制。**
- **CENC 一般加密 MP4 增量播放（實驗性）**：精簡 Librempeg WASM 透過 HTTP Range 的自訂 AVIO 逐段讀取並解密，保留原有 H.264/HEVC、AAC 壓縮封包，重新封裝為 clear fMP4，經 MSE 播放；不是重新編碼。已在 Chromium 與 Firefox 的合成 H.264/AAC 加密一般 MP4 上確認**第一個影格在來源未下載完時呈現、持續播放超過 1.5 秒**；並在 Node.js WASM 中驗證合成 HEVC/AAC 完整輸出可解碼。**合成素材**已在 Chromium／Firefox 驗證第 7／35／63 秒等未緩衝位置往返 Seek、重新整理續播與播放／下載模式切換；Chromium 合成 300 秒影片完整播畢，MSE 採有容量限制的前後緩衝。1920×1080 HEVC/AAC 合成加密樣本已確認 WASM 無損轉封裝與 FFmpeg 解碼。**真實紅果 1080p HEVC 的瀏覽器影格／音訊、Android Firefox、作業系統與 GPU 記憶體仍待驗證**。已分段加密 fMP4 繼續走原生 EME/MSE；在容器／編碼允許時保留既有 FFmpeg.wasm 備援，但 CDN HTTP 403/429、錯誤 206 範圍及其他明確來源失效**不得降級整檔下載**。
- **本集下載快取與 Seek**：CENC 一般 MP4 的原始加密資料使用獨立的 16／32 MiB 有界區段快取，保留 metadata，並跨 Seek 重用 Worker、WASM 與 MediaSource。目標已下載但尚未封裝至 MSE 時，從快取重新封裝，只有缺少的位元組才向 CDN 請求。播放開始後，容量允許的短片可先下載完整本集；大型來源採有限預載，暫停會停止主動預讀，省流量模式停用背景預讀。MSE 前方預載依碼率與記憶體調整，最多約 120 秒。快取隨離開該集／切換模式釋放，不是永久下載。診斷 v2 分開顯示 MSE 時間區間、原始快取位元組區間、快取命中／淘汰、HTTP 數與 Seek 耗時，`bufferedEnd` 不代表之前所有區段均已下載。
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

## 驗收狀態與已知限制

專案唯一進度／交接入口：[目前階段、Goal 與 Pending work](docs/AGENT-CURRENT.md)。

- **已通過**：合成 Chromium／Firefox CENC 串流、Seek／續播／背壓；真實紅果 HEVC 的 HTTP 206、WASM 解密轉封裝與 FFmpeg 解碼；macOS WebKit 真實 1080p 首影格及 120 秒遠距 Seek。
- **尚待驗收**：WebKit 真正 AAC 音訊輸出（Web Audio RMS 為 0 尚不代表實際靜音）、真實 reload／播畢、Windows／Android 解碼及長片資源使用。
- **ByteVC2**：已整合實驗性 Range/MSE 串流與原編碼、H.264、H.265、AV1、標準 VVC 下載輸出，但尚未驗證真實 BTY2 解碼；串流需網址明確選用。詳見 [技術說明](docs/bvc2-wasm.md)。
- **公開來源檢測**：真實 CDN 候選可能同時有 HTTP 403／206；腳本只做有界讀取，遇 429 停止。無 DRM 授權、直播 HLS、帳號登入或任意網域代理支援；媒體 URL／金鑰不進日誌。
- **下載限制**：Blob／FFmpeg 暫存及 ZIP／MP4 合併均有限額；不是所有 60 集都能直接無損併成單一 MP4。仍需 Android Firefox 真實大批次驗收。

## 授權與第三方來源

本專案及衍生檔案採 GPL-3.0-only。 `worker/vendor/` 修改自 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的播放取源模組；FFmpeg.wasm 於建置時取得，並遵循相關授權。詳見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 和 [LICENSE](LICENSE)。
