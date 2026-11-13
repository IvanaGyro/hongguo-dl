# Hongguo DL — 目前狀態（2026-11-13，階段 78：真實播放五輪驗收）

> **優先工作入口**：[REAL-PLAYBACK-ACCEPTANCE.md](REAL-PLAYBACK-ACCEPTANCE.md)；真實影片能否播放的證據高於合成 CI。所有工程直接提交 `main`、不開 PR；不得在 repo 或 log 保存簽章影片 URL、CENC key、Cookie 或真實影片片段。

## 最高優先結論

**現有部署站對真實紅果《nova：新星》第 1 集：FAIL，沒有成功呈現影格或讓播放時間前進。** 這是本輪最重要的新實證，不是 synthetic CENC 的成功。真實來源 API 正常顯示 1080p encrypted HEVC（2 份候選）與 720/540/480/360p encrypted ByteVC2（各 2 份候選）。第 1 集 360p 瀏覽器實測最後收到 **media HTTP 403**；GitHub Actions bounded HEVC 206 metadata probe 2 候選都未取得合格 206、0 筆上游 HTTP status，失敗於傳輸/逾時階段。不能因此推論「ByteVC2 解碼器壞掉」，也不能推論「真實 HEVC 播放成功」。

## 本輪五階段（74–78）

1. **階段74 真實 1080p/auto 畫面實測**：部署頁顯示《nova：新星》共 60 集（前 5 集 available），第一集至少 20s 內無影格、0:00/0:00、播放器顯示 ByteVC2 實驗轉碼。[Browser 實測記錄](https://agent.tinyfish.ai/runs/2f5dc5e8-f69f-49e6-b7e5-3ba0f62c0d65)。
2. **階段75 真實 HEVC 206 bounded probe**：[3184c85](https://github.com/IvanaGyro/hongguo-dl/commit/3184c85815868ae3299ef177586967a4d2f59f9d) 日誌加入安全的 HTTP status/count；[live run #43339207034](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43339207034) **FAIL**（2 候選、0 success、0 status、名目 131072 bytes／2 requests）。不能聲稱源站 HTTP 403，因為這輪沒有收到任何 HTTP status。
3. **階段76 ByteVC2 真實階段診斷**：[1b8b080](https://github.com/IvanaGyro/hongguo-dl/commit/1b8b080b5bb90a146b7d9922a627de6d43186755) 顯示整集 bytes 下載 %、WASM loading/ready、transcoding（無虛構%）、finalizing；[CI #43339401291](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43339401291)、[Firefox #43339401187](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43339401187) success。**只增可觀測性，不代表已能串流播放**。
4. **階段77 真實 360p ByteVC2 實播**：[Browser 實測記錄](https://agent.tinyfish.ai/runs/35c95408-2dd2-4e25-9977-573cd58caa70)：**FAIL**，完整觀測到 MEDIA_HTTP HTTP 403，曾顯示整集下載 90% 但始終 0:00／無影格，5 次重試停止。這次證明媒體代理/上游 CDN 無法提供可用影片，**不能斷定所有影片均如此**。
5. **階段78 錯誤分類／回歸**：[a74869f](https://github.com/IvanaGyro/hongguo-dl/commit/a74869f4500c16c9cb07d9845958098492102e85) Worker 將上游 403/429 分類為 media forbidden/rate limited；[63a2733](https://github.com/IvanaGyro/hongguo-dl/commit/63a27334dd6d8eaef17b3618e75a74c3cebf6adb) 前端也能將**舊 Worker** 的 generic MEDIA_HTTP 403/429 映射為明確原因。429 非可重試；403 仍遵守原有候選/重試策略。[CI #43340041117](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43340041117)、[Pages #43340041383](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43340041383) completed/success。**Worker 原始碼更新沒有證據表明已部署 Cloudflare**，但 Pages 前端與舊 Worker 相容。

## 下一個工作重點（不可跳過）

- **P0 真實媒體存取**：取得使用者有權使用而且返回有效 206/Content-Range 的真實來源；若官方 CDN 回 403，先辨別是否舊簽章、存取限制、Cloudflare egress/區域、或原站防盜鏈，**無證據不得猜**、不得嘗試繞過限制。不要再花大量時間只測 synthetic AAC。
- **P1 真實 HEVC**：在有 HEVC MSE 的實際 Windows/Android 裝置上驗 metadata、CENC 解密、EOF 前第一影格和音訊；不要把 Linux Chromium 不支援 HEVC 說成 remux 壞。
- **P2 ByteVC2 真正起播**：目前只能整集下載→同步單執行緒 WASM→H264，**不是 progressive streaming**；沒有合法 bitstream 真實解碼正例。未驗證解碼器前不要宣稱 ByteVC2 已支援。
- **產品限制**：如 CDN HTTP403，應明確標 SOURCE_FORBIDDEN 而非 decoder fail；真實 Android Firefox 大型 ZIP 和 BFCache 仍未驗。

歷史完整日誌：[AGENT-PROGRESS.md](AGENT-PROGRESS.md)；[CENC-TEST-MATRIX.md](CENC-TEST-MATRIX.md)。**CI PASS 不等於真實播放 PASS。**
