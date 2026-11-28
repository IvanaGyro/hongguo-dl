# Third-party notices

本專案使用並修改 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的 GPL-3.0-only 程式碼：

- `worker/vendor/app-source.js`：App 片源模型、請求簽章與來源選擇；改為 Cloudflare Workers fetch 傳輸並保留全部支援的編碼串流。
- `worker/vendor/playback-device.js`：匿名裝置註冊。
- `worker/vendor/playback-signature.js`：Argus 551 / Ladon 簽章。
- `worker/vendor/request-signal.js`：AbortSignal 與超時。
- `worker/vendor/sm3.js`：SM3 哈希。
- `worker/vendor/playback-signature.test.cjs`：簽章測試向量。

原檔案保留了對 N3urda/hongguoTV、ch6vip/fqapp、tsukiyo-zero/hongguoTV 等專案的歸屬與授權註記。新寫的 UI、Worker 路由與測試也採 GPL-3.0-only 授權。

媒體核心（`public/media-core/`）由 `scripts/build-media-core.sh` 從固定 commit 的 [Librempeg](https://github.com/librempeg/librempeg)（以 `--enable-gpl --enable-version3` 建置）與下列編碼器編譯，發佈的 WASM 以 GPL-3.0 散布；建置腳本、修補與 manifest 中的雜湊即對應原始碼。本儲存庫不包含影片內容。

Video.js 10 播放器 UI 使用 [`@videojs/html@10.3.0`](https://github.com/videojs/video.js)（Apache-2.0 授權），包含播放器狀態、播放／暫停、時間軸、靜音、手勢及全螢幕 Web Components。其相依套件以 `bun.lock` 記錄。請參考 [Video.js 授權](https://github.com/videojs/video.js/blob/main/LICENSE) 與 [Video.js 文件](https://videojs.org/docs/guides/installation/html)。

## Media core encoders

- x264, commit `33cac6b77d5b9259c552156013a817ab23119612`, from
  <https://github.com/ffmpegwasm/x264>, GPL-2.0-or-later.
- x265 3.4, commit `2bb5520e9596f361bf0ed81b3b8da0d7fd999069`, from
  <https://github.com/ffmpegwasm/x265>, GPL-2.0-or-later. The single-thread
  variant applies `scripts/patch-x265-single-thread.py`.
- SVT-AV1 4.3.1, commit `ad875ab772c67ff3f098c59667348d80fb5c68b6`, from
  <https://github.com/IvanaGyro/SVT-AV1> (a mirror of
  <https://gitlab.com/AOMediaCodec/SVT-AV1>), BSD-3-Clause-Clear with the
  AOMedia patent license. `scripts/patches/svt-av1/` contains the two fixes
  from that fork's pull requests #1 and #2.
- VVenC 1.13.1, commit `ca1af4a2bcfcf9cd9fea1bacb1f73037af253bda`, from
  <https://github.com/fraunhoferhhi/vvenc>, BSD-3-Clause-Clear; see its LICENSE.txt
  and patent provisions. The build script disables architecture-specific SIMD
  dispatch and uses its scalar implementation.
- `scripts/vendor/libvvenc.c` is the LGPL-2.1-or-later FFmpeg n8.0 VVenC wrapper:
  <https://github.com/FFmpeg/FFmpeg/blob/n8.0/libavcodec/libvvenc.c>.
  Its original copyright and license header are retained. This restores the
  wrapper missing from the pinned Librempeg tree, whose configure/Makefile
  already contain the corresponding encoder entries.

`build-media-core.sh` obtains the pinned sources and produces static libraries
and a relinkable WASM application in two variants (pthreads and single-thread).
The release manifest records the SHA-256 of all local patches, wrappers and
build scripts.
