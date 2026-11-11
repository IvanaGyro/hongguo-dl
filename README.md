# Hongguo DL

靜態網頁＋Cloudflare Worker 的紅果短劇**下載管理器**。不提供影片搜尋或播放功能，僅支援劇集 ID、官方劇集／播放網址，以及列入白名單的媒體直連網址。請只下載您有權保存的內容。

## 功能

- 選擇分集、批次佇列（同時 1–3 集）、目前進度、成功／失敗／取消、錯誤代碼與原因、重試；HLS 另顯示分片進度。
- 來源優先使用官網公開影片（自動畫質／編碼）；其他情況使用上游 App 取源模組。
- 可選不限編碼、H.264、HEVC/H.265、ByteVC2。**不限 H.264 不代表保證能轉碼 ByteVC2**。
- 未加密原始串流直接保存；按需使用本機 FFmpeg.wasm 無損封裝 MP4 或轉成 H.264，HLS VOD 透過 FFmpeg.wasm 整合。
- 瀏覽器若提供 `window.showDirectoryPicker()`，就能直接串流寫入選取的資料夾；否則退回 Blob 儲存單集（以實際功能偵測為準，不以瀏覽器品牌判斷）。
- 佇列狀態保存在 localStorage，重開網頁後未完成工作標示中斷，需要重試；不會保留 CDN 簽章連結或影片密鑰。

## 部署到 Cloudflare

需 Node.js 20+、Cloudflare 帳號，安裝依賴後執行：

```sh
npm install
npm test
npm run build
npx wrangler login
npm run deploy
```

`wrangler.jsonc` 將 `dist/` 靜態檔案與 `worker/worker.js` 一起部署在同一個 Cloudflare Worker 網域。**不需要獨立的 Node.js 伺服器，也不需要跨來源 CORS 設定。**

本機測試：

```sh
npm install
npm run build
npm run dev:worker
```

然後開啟 `http://127.0.0.1:8787`。若要使用 Vite 熱更新，可另開 `npm run dev`，其 `/api` 請求會轉發到 8787。

## 使用限制

- 未提供 `showDirectoryPicker()` 的環境會使用 Blob 儲存，限制 **每集 300 MiB**，避免無限制使用記憶體。Firefox 支援 OPFS 與選擇資料夾上傳，不等於一定提供此存取本機任意目錄的寫入 API。
- FFmpeg.wasm 本機讀寫與處理限制 **每集 320 MiB 輸入**；單執行緒核心成本高。標準版未保證支援 ByteVC2/VVC 解碼，尤其不能保證轉成 H.264。
- 不實作登入、DRM 授權或影片搜尋；不支援 SAMPLE-AES / Widevine 或直播 HLS。僅接受白名單 HTTPS 來源和受驗證的官方劇集資料。
- 不支援斷點續傳。HLS 工作先將分片放入 FFmpeg.wasm 虛擬檔案系統；原始 MP4 可直接串流寫入資料夾。
- 受來源 API、反爬限制、地區及 Cloudflare 出站網路環境影響；**目前尚未完成真實紅果片源端對端測試**，請勿把通過單元測試視為實際可下載的證明。
- 公開部署前建議設定 Cloudflare WAF / Rate Limiting，避免代理遭大量濫用。

## 架構

```text
靜態前端（Vite） -- /api/series --> Worker -- 官網劇集資料
     |              -- /api/source --> Worker -- 公開頁／App 取源
     |              -- /api/media  --> Worker -- 官方 CDN（串流）
     +-- File System Access／Blob（原始媒體）
     +-- FFmpeg.wasm（HLS、選用 MP4 封裝／轉碼）
```

Worker 限制請求主機與路徑，逐次檢查重新導向，並不轉送使用者 Cookie、Authorization 或其他不必要 Header。影片不儲存於 Cloudflare 伺服器。

## 來源、授權

本專案與衍生檔案依 GPL-3.0-only 授權；`worker/vendor/` 改寫自 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama)，沿用其中的 Argus、Ladon、SM3、匿名裝置註冊及取源演算法。FFmpeg.wasm 套件在安裝／建置期間取得，不提交大型 WASM 二進位檔。詳見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 與 [LICENSE](LICENSE)。
