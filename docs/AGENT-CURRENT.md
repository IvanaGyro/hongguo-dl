# Hongguo DL — 目前狀態（2026-11-13，最新階段 47）

> **接手規則**：所有程式直接提交 `main`，**不得開 PR**。每完成可驗證工程階段，立即更新 [AGENT-PROGRESS](AGENT-PROGRESS.md)（commit SHA、修改檔案、PASS/FAIL/PENDING、證據連結、限制、下一步），並更新本短版後**繼續做下一階段**。GitHub 讀／寫／Actions 任一步都可能卡住，禁止同一操作無限重試或反覆輪詢；寫入前比較最新 main 與 path blob SHA。不能輸出 signed URL、CENC key 或私有影片。

## 最新程式／CI

- 最新核心程式提交：[ac615db](https://github.com/IvanaGyro/hongguo-dl/commit/ac615db6965c6978cecfe35ea3d70d5e497608d1)，新增 **三輪**播放／下載切換後，MSE Object URL active=0（下載）或 1（播放），停止舊 Range 的 Chromium/Firefox 合成 E2E。
- 最新已確認主 CI 綠燈：[CI #43292589208](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43292589208)，HEAD `de84114`，**completed/success**（Bun 單測、CENC/BVC2 WASM manifest、Vite build、Worker cold-start）；[Pages #43292589298](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43292589298) **success**。**不是**後續 `ac615db` 最新功能的驗收。
- 後續新測試： [CI #43293286745](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43293286745)、[Pages #43293286729](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43293286729) 首次查詢 `in_progress`；[Browser #43293286765](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43293286765) `pending`；[Browser #43292941869](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43292941869) 新增 120 秒暫停也待確認。不要把 PENDING 當 PASS。

## 已通過的合成驗收（勿重做）

- Librempeg Asyncify AVIO + **有界 HTTP 206 Range** + CENC decrypt + `-c copy` clear fMP4 + MSE；JS/WASM manifest SHA256 綁定，HEVC 1080p/AAC 的 WASM stream-copy + FFmpeg decode、6 秒 RAP seek synthetic PASS：[WASM #43279575089](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279575089)。
- 合成 H.264/AAC 在 Chromium/Firefox 的 HTTP EOF 前首影格、55s 遠距 Seek、7→63→35→5→63s 往返、reload 續播及單次模式切換 PASS：[Browser #43279166406](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43279166406)。
- 合成 300s/1800s Chromium 完整播畢，MSE buffered span ≤72s、104 Range（1800s）：[Browser #43283216947](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43283216947)；3 秒暫停沒有新增 Range 並可恢復：[Browser #43285424033](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43285424033)。**120 秒暫停尚待新測試 PASS**。
- ByteVC2 decoder/x264 WASM 實驗性編譯、版本 pin、非 BVC2 負例、Worker cancel/lifecycle 和合法本機正例驗證工具單測 PASS；不代表實際 BVC2 影格驗收。

## 近期 HEVC 與可靠性修正

- [618bbab](https://github.com/IvanaGyro/hongguo-dl/commit/618bbab523513ff01ce60143752616c75cc90bf5) 修正 HEVC 單測括號，CI 恢復。[08258a8](https://github.com/IvanaGyro/hongguo-dl/commit/08258a841183b67311c53672a37ac3315cfe960d) 修正來源過早以裸 `hvc1` canPlayType 拒絕完整 MSE profile；[1b9cb3d](https://github.com/IvanaGyro/hongguo-dl/commit/1b9cb3d484b63f2f980f7dfb9a1a6afe289d3f6d) 解析 clear init 的精確 `hvcC`。
- **重要後續校正**：[5ac183a](https://github.com/IvanaGyro/hongguo-dl/commit/5ac183a69de73f19d586f0ef79a3222476284a7b) 不能假設 Librempeg 必輸出 `hvc1`，現在從**真正 clear fMP4 init** 導出 `hvc1/hev1` SourceBuffer MIME，仍比對完整 profile/tier/level，並補 pinned WASM output proof；[971dbc8](https://github.com/IvanaGyro/hongguo-dl/commit/971dbc88a128513cffbfccc8d73171b9c44c3bfa)、[63c19b9](https://github.com/IvanaGyro/hongguo-dl/commit/63c19b9c5e6902a69412deda3957acf1aea49bc1) 補 MSE `hev1` 正負例／前置 probe。原生 FFmpeg 自行生成樣本實見 `hev1`，**非 pinned WASM 結果**；需等新 WASM proof。
- [9279172](https://github.com/IvanaGyro/hongguo-dl/commit/9279172b3ed0f38af62c56d832618aa3bdcf3c13) 修正 Worker fail 時未 revoke URL，加入連續 Seek lifecycle 單測；[de84114](https://github.com/IvanaGyro/hongguo-dl/commit/de84114fe0a35a024e6b7271d1197b86f657fe84) 區分 CENC metadata HTTP 200/403/416/429/503，避免 CDN 被拒時降級整檔 FFmpeg 並誤認 HEVC 解碼失敗；[e58213f](https://github.com/IvanaGyro/hongguo-dl/commit/e58213f6fc2885cc0ebfea78e2b8952a6490a45f) 120 秒 paused-Range Browser E2E PENDING。

## 缺乏的外部驗收與立即恢復點

**NOT TESTED**：真實紅果 1080p HEVC CENC 需合法有效 HTTP 206 來源（先前 CDN 403 不是解碼失敗）；Android Firefox / Windows 真實 HEVC MSE 首影格、聲音、Seek/播畢；合法 ByteVC2 bitstream 真正解碼、AAC 時間軸、CPU/RAM。不可用 synthetic 或 MIME 支援宣告取代。

**下一步**：先以最新 main 及單次最新 CI／Browser／pinned HEVC WASM proof 的具體結果決定是否修 bug；若無失敗，繼續測試三輪模式切換與兩分鐘暫停、清理 Worker/Range/Object URL 的弱網路與退出競態。使用 [CENC-TEST-MATRIX](CENC-TEST-MATRIX.md) 分開登錄已通過／待驗。**更新文件後繼續開發，不因文件提交而停止。**
