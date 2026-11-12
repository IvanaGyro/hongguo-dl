# 研究：CENC 一般 MP4 → 低延遲 fMP4（2026-11-12）

## 技術決策

**首選：精簡 Librempeg/Libavformat WASM，經 HTTP Range 增量讀取，CENC 解密後保持 HEVC/AAC 壓縮封包不變，以 MSE 需要的 fMP4 逐段輸出。**

原生 FFmpeg 已實測成功。**瀏覽器 WASM 的非同步讀取與片段輸出尚未實作；本研究不宣稱真實 1080p 已經低延遲播放。**

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
| **Libavformat（FFmpeg / Librempeg）** | 合成 HEVC+Aac CENC 實測成功 | 原生 pipe 首片段可於 EOF 前輸出；WASM 介面仍需開發 | **優先實作** |
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

1. **自訂 AVIO**：使用 avio_alloc_context 的 read_packet、seek 和 AVSEEK_SIZE；以 Asyncify/EM_ASYNC_JS 暫停同步 C 呼叫、等待 Worker 內的非同步 fetch，並集中管理 Range 快取，不能要求 SharedArrayBuffer；206、Content-Range、403/416 都要正確檢查。先限定 moov <= 1 MiB，必要時使用 metadata offset 讀取尾端索引。
2. **CENC 解密與串流封裝**：input 交由 mov demuxer 讀取 encrypted progressive MP4；output 由 MP4 muxer 保留 AVCodecParameters/HEVC hvcC/AAC extradata。傳送 packet 時 rescale DTS/PTS、處理 edit list 和 B-frame composition offset；使用 frag_custom 配合 av_write_frame(ctx, NULL) 在 RAP 或預算時間時 flush。
3. **MSE**：Worker 每次提交完整初始化片段或完成的 fMP4 fragment，前端 appendBuffer 的 updateend ACK 後再提供更多片段。防止 Worker 和 SourceBuffer 同時無界累積內容；建議下載預取視窗約 25–40 秒，可根據 seek、停頓調整。正確註冊影片與 AAC codec string。
4. **兼容性**：clear fMP4 不需要 EME，但仍需要瀏覽器的 HEVC/MSE 解碼器。檢查 MediaSource.isTypeSupported / MediaCapabilities；無 HEVC 時選另一編碼或另走 H.264 轉碼，不能因為重新封裝就宣稱所有瀏覽器支援。Android Firefox 需實機驗證。
5. **seek、續播與清理**：第一版可重新建立 Worker/MediaSource，以最近前一個 IDR/RAP 重新開始，播放進度等 metadata 就緒後恢復；離開播放、切集、中止時立即 abort Range、清空 SourceBuffer、釋放資源。
6. **錯誤與保密**：區分來源 HTTP 錯誤、CENC 解密錯誤、mux 封裝錯誤、MSE 不支援、HEVC 解碼失敗。不可在控制台記錄 URL 的 signed token、金鑰或實際影片資料。現有整檔 FFmpeg.wasm 保留為備援。

## 下一個驗證門檻

- **已完成**：原生 FFmpeg 對合成 HEVC+Aac CENC progressive 檔成功在來源未讀完前產生可解碼 fMP4。
- **待做 1：WASM**：編譯僅包含 mov demux / mp4 mux / 必要 CENC crypto 的 Librempeg；在 headless Chromium + Firefox 測試，合成 progressive CENC 輸入尚未 EOF 時真的呈現影格（requestVideoFrameCallback），不得以 loadedmetadata 或整檔 Blob 冒充。
- **待做 2：HEVC**：在具備 HEVC 解碼能力的設備使用真實 1080p HEVC 測試首影格、影音同步、完整播放、seek、續播。
- **待做 3：長影片**：300 秒以上，測試 RAM/SourceBuffer 佔用、來源節流、Range 失敗、切集、取消、重試和補抓 keyframe。

**限制**：MSE 低延遲路徑不可直接沿用現有整集 MEMFS → 輸出 Blob 的 WASM ABI；必須新增增量輸入／輸出的工作執行緒介面。
