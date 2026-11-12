# CENC 串流驗收矩陣

最後修訂：2026-11-13（已納入 1800 秒 PASS）。所有結果必須區分「已執行的合成片」、「可接取的真實片源」與「裝置解碼能力」。**請勿將 CI 成功推論為真實 HEVC、Android Firefox 或 ByteVC2 解碼已驗證。**

| 情境 | 受測環境／素材 | 結論 | 可重現證據／限制 |
| --- | --- | --- | --- |
| CENC HEVC/AAC progressive → clear fMP4、輸出可解碼 | Ubuntu 24.04；Librempeg Asyncify WASM + FFmpeg；合成 320×180 HEVC | **PASS** | [WASM proof #43245818741](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43245818741) |
| CENC 6 秒 indexed seek → 非整檔讀取、後段 Range、有效影像 PTS | Ubuntu；合成 12 秒 HEVC/AAC | **PASS** | [同一 WASM proof](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43245818741)，`cenc_stream_remux_at`、FFprobe 時間戳 |
| CENC H.264/AAC 首影格在 HTTP EOF 前、可連續播放 >1.5 秒 | Linux Chromium；合成 480×270 | **PASS** | [Browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689) |
| CENC H.264/AAC 首影格在 HTTP EOF 前、可連續播放 >1.5 秒 | Linux Firefox；合成 480×270 | **PASS** | [Browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689) |
| Unbuffered seek 到 55 秒：重建 Worker/MSE 與新 Range、畫面恢復 | Chromium / Firefox；合成 70 秒 H.264/AAC | **PASS / PASS** | [Browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689)，各瀏覽器均有具體 PASS 行 |
| 55 秒後 reload，保留進度、重開就近 RAP 串流 | Chromium / Firefox；合成 70 秒 H.264/AAC | **PASS / PASS** | [Browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689)，`resumedRangeCount=7` / `6` |
| 10% / 50% / 90% 往返 unbuffered Seek，以及 90% reload | Chromium / Firefox；合成 70 秒 H.264/AAC | **PASS / PASS** | [Browser #43279166406](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279166406)：7→63→35→5→63 秒均跳出前一個 buffer，最後 reload 90% PASS |
| 完整播放 300 秒、MSE buffered 秒數是否有界 | Chromium；合成 300 秒 H.264/AAC | **PASS（Chromium）** | [Browser #43283216947](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283216947)：播至 300.021s、MSE 最大 buffered 72.00s、ahead 41.13s、32 Range；process-tree RSS 751.7→peak/last 773.8 MiB（非 GPU RAM） |
| 完整播放 1800 秒、EOF 前首影格、有界 MSE 緩衝與 RSS 趨勢 | Linux Chromium；合成 480×270 6fps H.264/AAC CENC，16× 播放 | **PASS（Chromium）** | [Browser #43283216947](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283216947)：1800.021s ended=true / error=null；max buffered span 72s、ahead 43.56s、104 Range；首影格取得來源約 6.6%；test harness+browser process-tree RSS first/peak/last 802.5/838.8/838.2 MiB，不能推論 GPU 或 Android RAM |
| 暫停後停止持續讀取 HTTP Range，恢復後仍能完整播畢 | Linux Chromium；合成 300s H.264/AAC CENC；`CENC_TEST_PAUSE=1` | **PASS** | [Browser #43285424033](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43285424033)，job 131419302146，實際 `PASS chromium paused CENC HTTP Range backpressure and playback resume`：pausedAt=1.5784s，3 秒觀察期 Range **9→9**；隨後 300s ended=true、32 Range；同一 run 1800s ended=true、104 Range。只證明合成 Chromium，非 Android/HEVC 長暫停 |
| 連續暫停 120 秒仍停止下載、恢復播畢 | Linux Chromium；合成 300s H.264/AAC；`CENC_TEST_PAUSE_MS=120000` | **PASS（Chromium 合成）** | [Browser #43292941869](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43292941869) completed/success；120 秒合成暫停後恢復與完整播放已由工作流程驗收；不代表 Android、HEVC 或背景凍結 |
| 播放／下載模式反覆切換 3 次：停止舊 Range 並撤銷 MSE Object URL | Linux Chromium / Firefox；合成 70s H.264/AAC，Playwright 多次 Seek/reload 後 | **PENDING（階段 52 加強驗收）** | [Browser #43294139965](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43294139965) 循環中影格/有界 Range/MSE URL 斷言通過，但最後出現 Librempeg MOV subsample/partial-file stderr，階段 52 新增分流後播放時鐘 >0.35s 與 media error 檢查，尚待新版 Browser PASS；MOV/AAC stderr 仍另需診斷 |
| CENC metadata HTTP 206 Content-Range 不符、截斷、過量與長度不符不得整檔備援 | Node/Bun 合成不合法 HTTP 206 | **PASS（單元）** | [CI #43294139811](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43294139811) completed/success；`45933e6` 四種 HTTP 206 失真 + `aaea7ea` fetch/reader 中斷合成回歸 |
| CENC metadata 有界 HTTP 200/403/416/429/503 分類、阻止整檔備援 | Node/Bun 合成 HTTP response；限量 Range | **PASS（單元）** | [CI #43292589208](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43292589208) 完成成功；確認 `CENC_SOURCE_FORBIDDEN` 等分類與 body cancel，非實際 CDN 可訪問性測試 |
| 範圍回應 403/416/429、超長/過短、退出取消、錯誤恢復 | Node 單元測試 | **PASS（前述 Range 測試版）** | [CI #43266444859](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266444859)；更多 metadata abort 測試仍待驗收 |
| JS/WASM manifest pin SHA-256 與 Pages 部署 | 主分支 | **PASS（目前已發布版本）** | [WASM #43245818741](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43245818741)、[Pages #43266778629](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266778629) |
| 合成 1920×1080 HEVC/AAC encrypted → clear fMP4 + FFmpeg 解碼 | Ubuntu WASM proof；synthetic 4s | **PASS** | [WASM #43279575089](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279575089)，HEVC、AAC、1920×1080 保留，首 fragment 前未讀到來源 EOF；非真實影片/瀏覽器 HEVC 驗證 |
| 真實 1080p HEVC CENC：EOF 前影格、音訊、播畢、seek | Windows HEVC/MSE 環境；具合法存取權的真實集數 | **NOT TESTED** | 先前兩組候選 CDN HTTP Range 回 403，[bounded probe #43237370059](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43237370059)。403 不是 HEVC 解碼失敗 |
| 真實 HEVC CENC | Android Firefox / Pixel | **NOT TESTED** | 需要裝置端 MSE / HEVC 解碼能力和可回 206 來源 |
| BVC2 專用 decoder+x264 在 WASM 註冊；普通 H.264 負例拒絕 | Emscripten 3.1.74、固定 Librempeg/x264 | **PASS（ABI/負例）** | [Build proof #43279446447](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279446447)，不能推論實際 ByteVC2 正例解出影格 |
| BVC2 JS/WASM SHA256 + build provenance + Pages 守門 | main；`public/bvc2/manifest.json` | **PASS（資產配對）** | [Manifest publish #43280846374](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280846374)；本機 `node scripts/bvc2-wasm-bundle.mjs verify` |
| ByteVC2 真實影格解碼、音畫同步、轉碼效能 | 有效授權 ByteVC2 bitstream + 專用 decoder | **NOT TESTED** | `scripts/verify-bvc2-fixture.mjs` 可在本機執行正例；尚無合法來源/正例結果 |
| 本機 H.264/HEVC/HEVC Main10/VVC 宣告能力檢測 | Windows/Android/Linux 瀏覽器 | **PASS（UI 功能）** | [Browser #43280440977](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43280440977)；宣告不代表真實 HEVC frame decode |

| 已選定 720p 只有 ByteVC2、WASM 不可用時保留品質並禁用 HEVC 選項 | Firefox + Node 合成來源；VVC-only 720p、HEVC 1080p | **PASS（Firefox E2E + Node 單元）** | [main 修復 005ad1a](https://github.com/IvanaGyro/hongguo-dl/commit/005ad1adf7fd326fe4c3079cefcba40299dbd1a9)；[Firefox #43295729590](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295729590) completed/success；[CI #43295729082](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295729082) success，非真實 ByteVC2 decode |

| CENC AVIO HTTP fetch／reader throw 不洩漏簽章 URL，abort 保持取消 | Node/Bun 合成異常與 AbortSignal | **PASS（單元）** | [CI #43296748129](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43296748129) completed/success；`3939d30` mock fetch/read/abort 回歸；不證明真實 CDN 可接取 |

| CENC SourceBuffer pending updateend／sourceopen 取消、ended 無限等候防護 | Node EventTarget + 模擬 Worker | **PASS（單元）** | [CI #43297100841](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43297100841) completed/success；`0fab93e` 測 pending ACK/close/ended，非真實弱網路實機 |

| pinned Librempeg 70s H264/AAC CENC：7／35／55／63s RAP Seek、AAC 與 AVC 嚴格解碼 | Ubuntu 24.04；自行生成 encrypted progressive MP4 | **PENDING（階段 55）** | [main fc18bc7](https://github.com/IvanaGyro/hongguo-dl/commit/fc18bc712b2462c6792aab5e5a6602098e07e6eb) 新增 WASM proof，`ffmpeg -xerror` + ffprobe PTS；不能以既有 6s HEVC Seek 代替 |

## 固定驗證指令

- 通用單元與建置：`bun ci && bun run test && VITE_BASE_PATH=/hongguo-dl/ bun run build`。
- 發布來源及二進位一致性：`node scripts/cenc-wasm-bundle.mjs verify`。
- CENC 分段/Range/取消/eviction：`node --test tests/fmp4-assembler.test.mjs tests/clear-key.test.mjs tests/http-range.test.mjs tests/mse-eviction.test.mjs tests/cenc-seek.test.mjs`。
- HEVC/AAC 合成 WASM 解密轉封裝與 Seek：`scripts/build-cenc-stream-wasm.sh`、`scripts/verify-cenc-stream-wasm.mjs`，依 `.github/workflows/cenc-wasm-stream.yml` 產生 synthetic 影片、ffprobe 檢查 PTS。
- Chromium/Firefox 合成 MSE 實際呈現影格、Seek、reload，以及 Chromium 300／1800 秒長片：依 `.github/workflows/cenc-browser.yml` 執行 Playwright。
- 真實影片存取：`node scripts/live-cenc-layout.mjs` 或手動啟動 `.github/workflows/live-cenc-layout.yml`，限制在兩個候選 CDN、六個 Range、約 3 MiB 名目量；403/429 停止，不儲存 signed URL、cookie、CENC key。

## 直接 main 提交與發布

1. **使用者 2026-11-12 指定只允許直接提交 `main`，不建立 PR。** 舊版「feature branch／PR merge」指示完全作廢。
2. 修改 C bridge 或 build source 後，`.github/workflows/cenc-wasm-stream.yml` 重建並執行合成 HEVC/AAC、RAP seek、FFmpeg 解碼與 PTS 測試。**在 WASM proof 成功前，不得宣稱 JS/WASM 可用。**
3. 成功後 workflow 將 `cenc-core.mjs`、`cenc-core.wasm`、`manifest.json` 作為同一個版本直接寫回 `main`，並顯式 dispatch Pages；每個發布階段都要確認 source fingerprints 與二進位匹配。
4. 主 CI／Pages 會在指紋不一致時擋住部署。`GITHUB_TOKEN` 自動提交不會觸發一般 push checks，因此發布後需另行執行驗證／正常進度提交。
5. 只有真的得到 completed/success 和案例內部 PASS 行才能更新本矩陣。仍未被授權的真實影片、Android/Windows 具體硬體環境、ByteVC2 不得以 synthetic PASS 取代。

持續工作日誌：[AGENT-PROGRESS.md](AGENT-PROGRESS.md)，下一階段計畫：[NEXT-SESSION-PLAN.md](NEXT-SESSION-PLAN.md)。
