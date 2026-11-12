# Hongguo DL — 目前狀態（2026-11-13，階段 55）

> **強制規則**：直接提交 `main`、不開 PR。每完成可獨立驗證的工程階段，立即更新 `docs/AGENT-PROGRESS.md` 與本短版，再自動繼續下一階段。GitHub 讀／寫／Actions 不無限重試、也不連續輪詢；寫前核對 main HEAD / blob SHA。不得記錄 signed URL、CENC key 或私有媒體。

## 最新完成與證據

- **階段 55 pinned Librempeg H264/AAC 70s 多 Seek 嚴格解碼驗收**：[feadf0b](https://github.com/IvanaGyro/hongguo-dl/commit/feadf0b015acde866887d225c2f4bab2ba79bac3)／[fc18bc7](https://github.com/IvanaGyro/hongguo-dl/commit/fc18bc712b2462c6792aab5e5a6602098e07e6eb)：`.github/workflows/cenc-wasm-stream.yml` 新生成與 Browser 同條件 70s H.264/AAC CENC 合成片，WASM 在 7、35、55、63s indexed seek 後，`ffmpeg -xerror` 嚴格解碼音訊與視訊，ffprobe 分別確認 AVC/AAC 與近目標 PTS。**WASM workflow 新測試 PENDING**，針對先前 MOV subsample/partial-file 診斷提供獨立實驗證據，不可聲稱已經治癒 AAC 警訊。

- **階段 54 MSE stalled ACK / sourceopen 防卡死**：[0fab93e](https://github.com/IvanaGyro/hongguo-dl/commit/0fab93e5f0a084b5fc110c47b15768315b705015)：`src/cenc-remux.js` 若 MediaSource 已 `ended` 則不再無限等 `sourceopen`；`tests/cenc-startup.test.mjs` 模擬 SourceBuffer `appendBuffer` 永不 `updateend`、MediaSource 仍 `closed`、或已 `ended`，驗證中止 Worker、不得 ACK、Object URL 恰撤銷一次。**新單元 CI PENDING**。

- **階段 53 CENC Range/Worker 無私密資料錯誤**：[3939d30](https://github.com/IvanaGyro/hongguo-dl/commit/3939d30751907dc7abd357367fef6f7bd58ade35)：`src/http-range.js` 的 fetch/read throw 改為固定字串、abort 保留 `Canceled`，`src/cenc-remux-worker.js` 不再傳回 arbitrary `error.message`（可能含 proxy signed URL/key），`tests/http-range.test.mjs` 增加 fetch、body reader、abort 回歸。**新 CI PENDING**；stage52 CENC [Browser #43296135487](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43296135487) 查詢時 `in_progress`，不得寫 PASS。

- **階段 52 CENC Browser 驗收增強**：[a4a30d0](https://github.com/IvanaGyro/hongguo-dl/commit/a4a30d0f519f03dab374bbe121681ef27db9ed22)（前導 [ac42226](https://github.com/IvanaGyro/hongguo-dl/commit/ac422262e90541ad8af6da3141a2b222eb0e281a)）：`tests/cenc-stream.browser.mjs` 針對多次 Seek/模式切換的已知 MOV demux stderr（subsample/packet corrupt/partial file）與 JS pageerror/其他 console error 分流，**保留實際 MediaSource URL、Range、media error 檢查，新增三輪切換後前向播放時鐘必須 >0.35s**，並列印特殊警訊數目，不直接刪除。**階段 52 Browser E2E 尚待證明 PASS**，MOV 音訊警訊不能聲稱已修復；本機對相同 FFmpeg CENC 合成片在 0、5、7、35、55、63s 解密 Seek 沒有重現 stderr，尚不能排除瀏覽器 Asyncify AVIO 競態。

- **階段 51 速度修正（Firefox E2E 已通過）**：[404a6d7](https://github.com/IvanaGyro/hongguo-dl/commit/404a6d7741c7db1b56b932c611fe0533e458b9eb)：在 `video.load()` 前設定 `defaultPlaybackRate`，載入後再設定 `playbackRate`，切換速度時同步更新兩者；避免 Firefox 切換畫質/來源後重設 1.25×。[Firefox #43295729590](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295729590) **completed/success**、[CI #43295729082](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295729082) **success**、[Pages #43295728699](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295728699) **success**，涵蓋既有 720p VVC-only 與 1.25× 播放控制回歸。階段 50 的主 [CI #43295263795](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295263795) 與 [Pages #43295263833](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295263833) **success**，但 [Firefox #43295263899](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43295263899) **failure**，具體在 `tests/browser-modes.firefox.mjs:142` 等待 `playbackRate===1.25` 超時，非前版 720p codec 選項斷言。

- **階段 50 程式**：[005ad1a](https://github.com/IvanaGyro/hongguo-dl/commit/005ad1adf7fd326fe4c3079cefcba40299dbd1a9)：`src/source-options.js` 不再將使用者選定且存在的 720p ByteVC2-only 無法播放來源自動換成 1080p HEVC；`src/player.js` 編碼選單嚴格依當前畫質，增加 Node 與 Firefox 瀏覽器 regression。**新提交 CI/Browser 結果 PENDING**；不要把代碼提交當測試通過。
- **階段 49 程式**：[aaea7ea](https://github.com/IvanaGyro/hongguo-dl/commit/aaea7ea5a2fff39abfba4d2c0c38bdc718d71afe)：metadata fetch/reader 斷線的 `CENC_RANGE_HTTP`、固定無私密資料錯誤訊息，禁止錯誤回退整檔；階段 48 [45933e6](https://github.com/IvanaGyro/hongguo-dl/commit/45933e6ffc84929e8b826b345e213657a1bd373a) 比對 HTTP 206 range/length/body。**已確認**：[CI #43294139811](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43294139811) **success**、[Pages #43294139714](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43294139714) **success**、[pinned Librempeg HEVC WASM #43294139733](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43294139733) **success**。這些是合成/建置驗證，不是實際紅果 HEVC 解碼。
- **Firefox FFmpeg.wasm workflow #43294139816** [失敗](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43294139816)：`tests/ffmpeg.firefox.mjs` 本身實際列印 `Firefox FFmpeg.wasm staged-and-manual-save remux PASSED`，**後續** `tests/browser-modes.firefox.mjs:367` 因選定 720p 時跳至 1080p 導致 HEVC 可選而 FAIL。階段 50 已針對這個具體行為修正。
- **CENC Browser #43294139965** [失敗](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43294139965)：Chromium first frame、55s Seek、跨 Range 五次、90% reload 有個別 PASS，但新增三輪播放／下載切換最終 `tests/cenc-stream.browser.mjs:529` 發現 WASM `[mov...] subsample size exceeds ... / partial file` 主控台 stderr，不能宣稱三輪 E2E PASS。先釐清取消中的 demux 訊息與有效播放錯誤，不隱藏真實 decode failure。
- **120 秒暫停驗收**：[Browser #43292941869](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43292941869) **completed/success**（Chromium synthetic H.264/AAC）；不代表 Android/HEVC 實機。

## 架構及已經驗證的基線

- 使用 pinned **Librempeg Asyncify AVIO WASM**，CENC decrypt + stream copy MP4→**clear fMP4**，送 MSE；從 clear init 的真實 `hvc1/hev1 + hvcC` 選擇 MIME，不以 JS 取代 demux/mux。可參考 `docs/cenc-progressive-to-fmp4.md`。
- 1080p HEVC/AAC 合成 WASM→FFmpeg 解碼、6 秒 RAP Seek PASS；Chromium／Firefox 合成 H.264 首影格在來源 EOF 前、遠距 Seek/reload PASS；Chromium 300s/1800s 播畢與有界 buffer PASS。詳情在 [CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)。
- BVC2 WASM 實驗版編譯、asset SHA/負例 PASS，**無**真實 ByteVC2 解碼正例、效能或音畫同步證據。

## 下一個工程動作及外部阻礙

**立即下一步**：單次確認階段 55 pinned WASM 嚴格 AAC 多 Seek 是否 FAIL 並按具體資訊處理；再確認階段 52 的 CENC Browser E2E 是否真正達到三輪模式切換後前向播放；若 FAIL 讀具體錯誤並修正。針對 MOV stderr 仍需獨立驗證 AAC packet/音訊連續性，不能以單純轉為 warning 視為來源完美。接著強化弱網路／取消競態。

**NOT TESTED**：有效授權、可 HTTP 206 的真實紅果 HEVC CENC（先前 CDN HTTP 403）；Windows/Android Firefox 真正 HEVC MSE 首影格／音效／Seek；真實 ByteVC2 bitstream frame decode、AAC 時序、CPU/RAM。合成 PASS 與 MIME 能力宣告不能代替以上實機驗收。

**文件提交不是停止條件，更新後繼續下一階段。**
