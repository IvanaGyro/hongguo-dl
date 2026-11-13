# 研究與現行架構：CENC 一般 MP4 → 低延遲 fMP4（2026-11-13）

## 技術決策

**首選：精簡 Librempeg/Libavformat WASM，經 HTTP Range 增量讀取，CENC 解密後保持 HEVC/AAC 壓縮封包不變，以 MSE 需要的 fMP4 逐段輸出。**

現行主分支已實作 **Librempeg Asyncify AVIO + HTTP Range + clear fMP4 + MSE**，真實紅果 HEVC 1080p 已在 macOS WebKit 通過首影格及未緩衝 120 秒 Seek 驗收；AAC 實際瀏覽器音訊、完整播畢及跨平台測試尚未完成。**進度與待辦只在 [唯一狀態文件](AGENT-CURRENT.md) 維護**，本篇保留技術設計與實作限制。

### 已有證據

- [獨立 CENC 診斷](../diagnostics/CENC-FINDINGS.md)：直接指定加密 MP4 給 video.src 不成功；合成加密 fragmented MP4 經 MSE 能在 Chromium 與 Firefox 播放。第一集 HEVC 的真實來源是一般 MP4，含 sample tables、tenc、senc、saio、saiz、hvcC，沒有 mvex。
- [真實來源有界探測](../scripts/live-cenc-layout.mjs)：影集 7699513062054710296 可觀看第 1 集，1080p HEVC，8,277,562 bytes，起始 moov 約 260 KiB，能經其中一個 CDN 206 Range 取得 metadata，未下載全集。
- [原生實測腳本](../scripts/probe-cenc-remux.py)：合成 CENC HEVC + AAC progressive MP4，透過逐塊節流的 stdin 輸入，FFmpeg 使用 decryption_key + stream-copy + fragmented MOV muxer。114,738 bytes 來源只讀到約 32,768 bytes（28.6%）時已產生第一個 moof，來源尚未 EOF。輸出五個 moof，包含 HEVC + AAC 且可以完整解碼，沒有原來的 tenc/senc。**這是原生可行性測試，不是 WASM 或真實片源效能基準。**
- H.264 合成片另一輪原生測試在 616,734 bytes 來源中的 98,304 bytes（15.9%）已產生第一個 moof。百分比受 GOP、媒體內容與 I/O 節流影響，不能推定真實播放延遲。

可重現的核心 FFmpeg 命令：

    ffmpeg -decryption_key <synthetic_key> -i input.mp4 \
      -map 0:v:0 -map 0:a? -c copy \
      -movflags +frag_keyframe+empty_moov+default_base_moof \
      -f mp4 output.mp4

不需要 HEVC 解碼器或 x264；-c copy 不進行重新編碼，但容器與 NAL 表示法可能改變，請以可解碼性、影音同步與品質驗證，而不是比對整檔位元。

## 函式庫比較

| 方案 | 加密的非分段 MP4 | 增量封裝 | 結論 |
| --- | --- | --- | --- |
| **Libavformat（FFmpeg / Librempeg）** | 合成 HEVC/AAC CENC 實測成功 | **已實作 Asyncify AVIO + bounded HTTP Range + MSE；合成 browser / HEVC WASM proof 通過** | **現行架構** |
| **GPAC / MP4Box（C / WASM）** | 支援 CENC，但特定非分段加密來源仍須實驗 | 支援 fMP4 及瀏覽器 WASM | 第二候選；先做命令列端對端測試 |
| **MP4Box.js** | 可讀取 MP4 sample tables；目前 senc.ts 沒完整解析每個 sample 的 IV/subsamples | createMoof 可封裝一般樣本，但不自動產生對應 CENC metadata | 不可直接當成已完成的加密轉封裝器 |
| **Shaka Packager** | track_run_iterator.cc 明確註記不支援 encrypted non-fragmented MP4 | fMP4 輸出能力完整 | **不能直接處理現有來源** |
| **JS + WebCrypto + MP4Box.js** | 自行解析 tenc/senc/saiz/saio、IV 與 subsamples，然後解密 | 輸出 clear fMP4 | 可行但工程及安全測試負擔高 |
| **Rust MP4 函式庫** | 部分支援 CENC，但尚需確認本來源所有 nonfragmented SAI 型態；相關套件仍偏新 | 部分支援 fMP4 muxer | 不宜未驗證就替換已成功的 libavformat |

參考原始碼：
- [W3C MSE ISOBMFF byte-stream 格式](https://www.w3.org/TR/mse-byte-stream-format-isobmff/)：需要初始化的 ftyp/moov/mvex 與具備 tfdt/trun 的 moof/mdat。
- [FFmpeg MOV/MP4 muxer](https://ffmpeg.org/ffmpeg-formats.html) 與 [自訂 AVIO](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/avio.h)。
- [Emscripten Asyncify 與 EM_ASYNC_JS](https://emscripten.org/docs/porting/asyncify.html)。
- [MP4Box.js senc 原始碼](https://github.com/gpac/mp4box.js/blob/main/src/boxes/senc.ts)、[createMoof](https://github.com/gpac/mp4box.js/blob/main/src/isofile.ts)。
- [Shaka progressive encrypted MP4 限制](https://github.com/shaka-project/shaka-packager/blob/main/packager/media/formats/mp4/track_run_iterator.cc)。
- [Chromium CENC subsamples 解密](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/cdm/cenc_decryptor.h)：同一 sample 的加密 subsamples 應視為連續 AES-CTR 資料，不能獨立重置 counter。
- [GPAC WASM 建置](https://wiki.gpac.io/Build/build/GPAC-Build-Guide-for-WASM/)。

## 建議實作流程

    Source API + codec/Range 能力檢查
      -> Worker：精簡 Librempeg WASM
      -> AVIOContext 的 read_packet / seek（HTTP 206 Range + 有界 cache）
      -> mov demux + decryption_key
      -> HEVC / AAC 原編碼 AVPacket
      -> mp4 mux + empty_moov + default_base_moof + frag_custom
      -> write_packet 輸出完整 init、moof/mdat
      -> MediaSource / SourceBuffer → Video.js UI

1. **自訂 AVIO**：使用 avio_alloc_context 的 read_packet、seek 和 AVSEEK_SIZE；以 Asyncify/EM_ASYNC_JS 暫停同步 C 呼叫、等待 Worker 內的非同步 fetch，並集中管理 Range 快取，不能要求 SharedArrayBuffer；206、Content-Range、403/416 都要正確檢查。現行 metadata moov 安全上限為 **8 MiB**，此前 1MiB 無法涵蓋 1800 秒合成樣本；超出限制須明確中止、**不得退回不受限的整檔下載**。
2. **CENC 解密與串流封裝**：input 交由 mov demuxer 讀取 encrypted progressive MP4；output 由 MP4 muxer 保留 AVCodecParameters/HEVC hvcC/AAC extradata。傳送 packet 時 rescale DTS/PTS、處理 edit list 和 B-frame composition offset；現行使用 `frag_keyframe+empty_moov+default_base_moof` 在視訊 RAP 輸出片段，非使用 `frag_custom` 或自行 `av_write_frame(NULL)` flush。
3. **MSE**：Worker 每次提交完整初始化片段或完成的 fMP4 fragment，前端 appendBuffer 的 updateend ACK 後再提供更多片段。防止 Worker 和 SourceBuffer 同時無界累積內容；建議下載預取視窗約 25–40 秒，可根據 seek、停頓調整。正確註冊影片與 AAC codec string。
4. **兼容性**：clear fMP4 不需要 EME，但仍需要瀏覽器的 HEVC/MSE 解碼器。檢查 MediaSource.isTypeSupported / MediaCapabilities；無 HEVC 時選另一編碼或另走 H.264 轉碼，不能因為重新封裝就宣稱所有瀏覽器支援。Android Firefox 需實機驗證。
5. **seek、續播與清理**：現行版本已實作 indexed RAP 附近的 CENC seek、Worker/MediaSource 重建、歷史位置恢復、MSE eviction 與取消清理；這些行為已通過合成 Chromium/Firefox 的 55 秒及 10/50/90% 跳轉／reload。真實來源及 Android 尚需重複驗證。
6. **錯誤與保密**：區分來源 HTTP 錯誤、CENC 解密錯誤、mux 封裝錯誤、MSE 不支援、HEVC 解碼失敗。不可在控制台記錄 URL 的 signed token、金鑰或實際影片資料。現有整檔 FFmpeg.wasm 保留為備援。

## 驗收與後續工作

最新 PASS／FAIL、當前 Goal 及 Pending work 請參見 [唯一狀態文件](AGENT-CURRENT.md)；此技術文件不再重複維護進度流水帳。
