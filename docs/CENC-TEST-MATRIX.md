# CENC 串流驗收矩陣

最後修訂：2026-11-13。所有結果必須區分「已執行的合成片」、「可接取的真實片源」與「裝置解碼能力」。**請勿將 CI 成功推論為真實 HEVC、Android Firefox 或 ByteVC2 解碼已驗證。**

| 情境 | 受測環境／素材 | 結論 | 可重現證據／限制 |
| --- | --- | --- | --- |
| CENC HEVC/AAC progressive → clear fMP4、輸出可解碼 | Ubuntu 24.04；Librempeg Asyncify WASM + FFmpeg；合成 320×180 HEVC | **PASS** | [WASM proof #43245818741](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43245818741) |
| CENC 6 秒 indexed seek → 非整檔讀取、後段 Range、有效影像 PTS | Ubuntu；合成 12 秒 HEVC/AAC | **PASS** | [同一 WASM proof](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43245818741)，`cenc_stream_remux_at`、FFprobe 時間戳 |
| CENC H.264/AAC 首影格在 HTTP EOF 前、可連續播放 >1.5 秒 | Linux Chromium；合成 480×270 | **PASS** | [Browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689) |
| CENC H.264/AAC 首影格在 HTTP EOF 前、可連續播放 >1.5 秒 | Linux Firefox；合成 480×270 | **PASS** | [Browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689) |
| Unbuffered seek 到 55 秒：重建 Worker/MSE 與新 Range、畫面恢復 | Chromium / Firefox；合成 70 秒 H.264/AAC | **PASS / PASS** | [Browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689)，各瀏覽器均有具體 PASS 行 |
| 55 秒後 reload，保留進度、重開就近 RAP 串流 | Chromium / Firefox；合成 70 秒 H.264/AAC | **PASS / PASS** | [Browser #43266588689](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266588689)，`resumedRangeCount=7` / `6` |
| 10% / 50% / 90% 往返 unbuffered Seek，以及 90% reload | Chromium / Firefox；合成 70 秒 H.264/AAC | **PASS / PASS** | [Browser #43279166406](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279166406)：7→63→35→5→63 秒均跳出前一個 buffer，最後 reload 90% PASS |
| 完整播放 300 秒、MSE buffered 秒數是否有界 | Chromium；合成 300 秒 H.264/AAC | **PASS（Chromium）** | [Browser #43279166406](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279166406)：播至 300.021s、MSE 最大 buffered 78.021s、ahead 41.395s、32 Range；尚未量測 OS/GPU RSS |
| 範圍回應 403/416/429、超長/過短、退出取消、錯誤恢復 | Node 單元測試 | **PASS（前述 Range 測試版）** | [CI #43266444859](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266444859)；更多 metadata abort 測試仍待驗收 |
| JS/WASM manifest pin SHA-256 與 Pages 部署 | 主分支 | **PASS（目前已發布版本）** | [WASM #43245818741](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43245818741)、[Pages #43266778629](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43266778629) |
| 合成 1920×1080 HEVC/AAC encrypted → clear fMP4 + FFmpeg 解碼 | Ubuntu WASM proof；synthetic 4s | **PASS** | [WASM #43279575089](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279575089)，HEVC、AAC、1920×1080 保留，首 fragment 前未讀到來源 EOF；非真實影片/瀏覽器 HEVC 驗證 |
| 真實 1080p HEVC CENC：EOF 前影格、音訊、播畢、seek | Windows HEVC/MSE 環境；具合法存取權的真實集數 | **NOT TESTED** | 先前兩組候選 CDN HTTP Range 回 403，[bounded probe #43237370059](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43237370059)。403 不是 HEVC 解碼失敗 |
| 真實 HEVC CENC | Android Firefox / Pixel | **NOT TESTED** | 需要裝置端 MSE / HEVC 解碼能力和可回 206 來源 |
| ByteVC2 真實影格解碼、音畫同步、轉碼效能 | 有效 ByteVC2 bitstream + 專用 decoder | **NOT TESTED** | 普通 VVC decoder 不能代替 ByteVC2 驗證 |

## 固定驗證指令

- 通用單元與建置：`bun ci && bun run test && VITE_BASE_PATH=/hongguo-dl/ bun run build`。
- 發布來源及二進位一致性：`node scripts/cenc-wasm-bundle.mjs verify`。
- CENC 分段/Range/取消/eviction：`node --test tests/fmp4-assembler.test.mjs tests/clear-key.test.mjs tests/http-range.test.mjs tests/mse-eviction.test.mjs tests/cenc-seek.test.mjs`。
- HEVC/AAC 合成 WASM 解密轉封裝與 Seek：`scripts/build-cenc-stream-wasm.sh`、`scripts/verify-cenc-stream-wasm.mjs`，依 `.github/workflows/cenc-wasm-stream.yml` 產生 synthetic 影片、ffprobe 檢查 PTS。
- Chromium/Firefox 合成 MSE 實際呈現影格、Seek、reload，以及 Chromium 300 秒長片：依 `.github/workflows/cenc-browser.yml` 執行 Playwright。
- 真實影片存取：`node scripts/live-cenc-layout.mjs` 或手動啟動 `.github/workflows/live-cenc-layout.yml`，限制在兩個候選 CDN、六個 Range、約 3 MiB 名目量；403/429 停止，不儲存 signed URL、cookie、CENC key。

## 直接 main 提交與發布

1. **使用者 2026-11-12 指定只允許直接提交 `main`，不建立 PR。** 舊版「feature branch／PR merge」指示完全作廢。
2. 修改 C bridge 或 build source 後，`.github/workflows/cenc-wasm-stream.yml` 重建並執行合成 HEVC/AAC、RAP seek、FFmpeg 解碼與 PTS 測試。**在 WASM proof 成功前，不得宣稱 JS/WASM 可用。**
3. 成功後 workflow 將 `cenc-core.mjs`、`cenc-core.wasm`、`manifest.json` 作為同一個版本直接寫回 `main`，並顯式 dispatch Pages；每個發布階段都要確認 source fingerprints 與二進位匹配。
4. 主 CI／Pages 會在指紋不一致時擋住部署。`GITHUB_TOKEN` 自動提交不會觸發一般 push checks，因此發布後需另行執行驗證／正常進度提交。
5. 只有真的得到 completed/success 和案例內部 PASS 行才能更新本矩陣。仍未被授權的真實影片、Android/Windows 具體硬體環境、ByteVC2 不得以 synthetic PASS 取代。

持續工作日誌：[AGENT-PROGRESS.md](AGENT-PROGRESS.md)，下一階段計畫：[NEXT-SESSION-PLAN.md](NEXT-SESSION-PLAN.md)。
