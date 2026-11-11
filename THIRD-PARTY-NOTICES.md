# Third-party notices

本專案使用並修改 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的 GPL-3.0-only 程式碼：

- `worker/vendor/app-source.js`：App 片源模型、請求簽章與來源選擇；改為 Cloudflare Workers fetch 傳輸並保留全部支援的編碼串流。
- `worker/vendor/playback-device.js`：匿名裝置註冊。
- `worker/vendor/playback-signature.js`：Argus 551 / Ladon 簽章。
- `worker/vendor/request-signal.js`：AbortSignal 與超時。
- `worker/vendor/download-quality.js`：畫質判定。
- `worker/vendor/sm3.js`：SM3 哈希。
- `worker/vendor/playback-signature.test.cjs`：簽章測試向量。

原檔案保留了對 N3urda/hongguoTV、ch6vip/fqapp、tsukiyo-zero/hongguoTV 等專案的歸屬與授權註記。新寫的 UI、Worker 路由與測試也採 GPL-3.0-only 授權。

FFmpeg.wasm 由建置時 npm 安裝：`@ffmpeg/ffmpeg@0.12.15` 為 MIT 授權，`@ffmpeg/core@0.12.10` 為 GPL-2.0-or-later。發佈打包後的核心時應遵守對應原始碼提供義務。詳見 [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)。本儲存庫不包含影片內容。
