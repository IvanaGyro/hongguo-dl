# 播放資料流

播放分成三層。下一層提出需求，上一層自行決定快取命中、下載、處理及預取；一次需求不代表一定要新增工作。

1. **下載**：`download-source-session.js` 管理片源查詢、CDN 網址、候選輪替、失敗名單及重新取源；`media-download.js` 負責來源傳輸與原生影片探測；整檔讀取（播放備援與下載佇列的處理工作）一律經由媒體 Worker 的同一個來源與位元組快取（`whole-file-read.js`），主執行緒不再自行整檔下載。串流來源的 HTTP 由媒體 Worker 的下載層（`media-source.js`、`progressive-media-download.js`、`mp4-metadata.js`、`cached-media-reader.js`、`http-stream.js`、`media-byte-cache.js`）負責：開啟唯一的 `Range: bytes=0-` 回應、有界的 MP4 索引探測、位元組範圍、請求排程、快取、重試及網路預取。下載快取配額與省流量策略在這一層決定。
2. **媒體處理**：ByteVC2 預設走直接解碼（`bvc2-render`）：Worker 只輸出 AAC fMP4 與解碼後的 I420 畫面，畫面由 `bvc2-frame-renderer.js` 以 WebGL2 疊在 `<video>` 上，以 `<video>` 的時間為準，Video.js 透過包住 `<video>` 的 `<bvc2-video>` 讀取畫面的緩衝與就緒狀態；不支援時才轉碼為 H.264（見 [ByteVC2 技術說明](bvc2-wasm.md)）。`media-session.js` 只以不含網址的媒體參照要求資料，提供可處理的編碼／畫質需求，負責整檔備援，以及下一集預備與交接。串流的 CENC 解密／轉封裝、ByteVC2 解碼及 H.264 轉碼由媒體 Worker 的處理層（`media-engine.js`，Librempeg WASM）執行；`media-processor.js` 是主執行緒端的需求客戶端，管理 Worker 重用、預備片段及消費端 ACK。
3. **播放**：`player.js` 負責操作介面、播放進度、切集與觀看紀錄；`cenc-remux.js` 是 MSE 呈現介面，負責追加片段、緩衝清除、時間軸與 seek 的呈現。`clear-key.js` 只保留瀏覽器 EME/CDM 的相容路徑，所需的索引資訊由媒體 Worker 回報。

播放器透過 `media.request()` 要求可播放來源，透過 `media.updateContext()` 提供播放位置、暫停狀態及目前串流狀態。處理層自行決定是否準備下一集、只先下載，或開始產生片段。既有策略保留：接近片尾或目前處理已完成時可準備下一集；正在處理目前集數時，下一集的 CPU 工作等待交接。

MSE 消費片段後才回 ACK，形成背壓；下載層的位元組預取可獨立進行，不需要把整集解密或轉碼完。seek 命中 MSE 緩衝時由瀏覽器直接處理，未命中時向處理層要求該時間附近的片段，沿用原 Worker、WASM 與下載快取。

每個片源在下載層只有一個 response-body 讀取流程。必要讀取與讀取前方資料都由這個流程完成；第二層只提出位元組位置／長度並等待快取，不另開一個網路讀取工作排進 FIFO。下載層依快取缺口、目前連線位置和實測速度決定繼續讀或重新定位，不接收「seek」等播放器操作標籤；現有連線能在約一秒內到達缺口時，優先沿用。不同媒體資源的下載器、快取與嘗試額度各自獨立，可以同時下載；WASM 處理額度不會把跨集下載串行化。

只有實際等待 body 資料的時間才計入吞吐量，不把暫停或 ACK 背壓算成下載變慢。約八秒的主動讀取窗口內，速度低於該檔案平均位元組需求時回報 `CENC_SOURCE_SLOW`。下載工作只知道被要求的媒體識別，不接收目前播放集數、播放位置或前景／預載身分；任何讀取的來源失敗都終止該來源，不重開同一 CDN。第一層自行選下一個符合格式需求的同畫質／編碼候選；一輪候選耗盡由第一層立即重新取源，不先進入一般重試倒數。已失敗網址保持排除；刷新仍只有舊失敗網址就停止，並保留原有 20 次分步驟上限。單一 HTTP 來源已有的快取位元組仍可讀，缺少的位元組不會在原 CDN 重試。第二層不持有實際候選網址、不維護失敗網址名單，也不決定何時查片源；必要時只重建解密／解碼流程，讓新輸入從正確時間接續。

下一集的串流建立與可播放狀態分別記錄為 `prefetch.prepared`、`prefetch.ready`。預載期間的慢速、讀取失敗或首次重試會觸發有界的候選輪替，候選耗盡後可重新查詢新的片源，受每步驟 20 次額度限制；刷新只得到已失敗 URL 時會提早停止。交接會保留已失敗 URL 與刷新額度，不把只有初始化標頭且已失敗的工作重新當成健康串流；正常交接沿用已取得的片段和下載快取。 預載以 CENC_SOURCE_EXHAUSTED 結束時，前景交接會在剩餘額度內強制重新查片源／畫質列表；繼承原畫質／編碼、已失敗 URL、候選編號與步驟計數，僅嘗試新的候選。若回來仍只有舊 URL 就停止；真正耗盡 20 次額度則回報 PLAYBACK_STEP_LIMIT，不追加查詢或重設計數。

單集工作與引擎的生命週期分開。完成工作的串流引擎最多保留一個、閒置 30 秒，可供後續相同種類的工作重用；重用前先等待上一集的讀取迴圈退出，並清除單集下載與輸出狀態。未完成、取消或失敗的工作終止 Worker，避免重用未確認清理完成的執行狀態。離開播放、停止與 pagehide 會清掉保留引擎。整檔 ByteVC2 轉碼仍使用獨立工作；一般 FFmpeg 處理沿用原本的共用引擎；兩者的輸入位元組都由媒體 Worker 讀取。

測試以 `createPlayer`、既有串流介面與瀏覽器可觀察的行為為準，不要求內部檔案切法或私有物件形狀。`player-behavior.test.mjs` 的相同行為案例已在重構前後執行。

## 媒體 Worker：宣告式需求

下載層與處理層在**同一個** Worker 內，是兩個模組層，不是兩個 Worker；兩層之間以函式呼叫共用同一份位元組快取，不經過逐次讀取的跨執行緒訊息。`cenc-remux-worker.js`／`bvc2-stream-worker.js` 只是入口，協調者是 `media-worker-core.js`：

- 主執行緒只宣告「我需要…」（`need`，以穩定的 `id` 與遞增的 `revision` upsert）或「我不再需要…」（`dont-need`），回報瀏覽器能力（`capabilities`：WASM／MSE 可用性與 Worker 詢問的精確 MIME 支援），並以 ACK 回饋輸出背壓。沒有 `prepare`／`start`／`seek` 等程序指令。
- 需求內容（`media-demand.js`）：來源（網址、代理網址、bridge、金鑰）、輸出（`metadata`、`playable-media` 或 `whole-file`）、位置、播放狀態（暫停、已緩衝秒數、緩衝目標）、優先順序（`active`／`speculative`）與是否已給予 CPU 處理額度。相同 revision 重送不產生新工作；舊 revision 被忽略。只有位置或來源改變時才產生新的 `positionRevision`，輸出片段帶此值，主執行緒與 Worker 都丟棄舊位置的輸出。
- Worker 依需求自行協調：新的可播放需求會自動開啟來源、做有界的索引探測，再依 `media-route.js` 選擇路線（`mse`、`eme`、`unsupported`），然後產生 fMP4 片段。只要索引的需求不啟動 WASM，探測完畢就釋放 HTTP 連線，但保留已讀取的索引範圍。
- 同一來源可由多個需求共用（例如預覽索引與播放）；移除其中一個不會取消仍被其他需求使用的下載、快取或引擎。每個 Worker 最多一個可播放輸出。
- 暫停只是需求狀態更新，不撤回需求；Worker 在播放中、預載中，或暫停但緩衝尚未達到回報的目標時持續讀取前方資料。seek 是位置更新，沿用同一個 Worker、WASM 與下載快取。
- 來源失敗只以固定代碼與 HTTP 狀態回報給每個使用該來源的需求，不包含網址或金鑰；換 CDN 仍由主執行緒第一層決定。
- **不會把加密網址交給 `<video src>`**：Chromium／Firefox 只透過 MSE 解密 CENC（見 `diagnostics/CENC-FINDINGS.md`），原本的 `eme-progressive` 路線已移除。
- **已分段 CENC → 原生 EME（`eme` 路線，#24）**：需求帶 `eme: true` 時，Worker 先從快取探測分段索引（`fmp4-index.js`：`moov` 後的 `sidx`，否則以一次 64 KiB 尾端讀取取得 `mfro`／`mfra`），再由 `fmp4-passthrough.js` 把原始加密 init（`ftyp`+`moov`）與 `moof`+`mdat` 片段從同一份位元組快取送出，沿用 WASM 路線的片段／ACK／seek 協定；瀏覽器 CDM 解密。seek 從目標時間之前、以同步樣本開頭的片段重新開始。沒有索引時改走 WASM 串流（`fragmented-remux`），不實作 `moof` 掃描。
- 一般（非分段）CENC 一律走 WASM 解密並轉封裝為清晰 fMP4；不可用時回報 `unsupported`，由整檔備援接手。
- **MediaKeys 生命週期**：`clear-key.js` 在第一次需要 EME 時把 MediaKeys 掛到 `<video>`，之後不再 `setMediaKeys(null)`；清晰 MSE 與直接播放在 MediaKeys 已掛上時照常播放。每集各自開一個 Clear Key session，離開該集時關閉。預載下一集時不碰正在播放的元素，session 在交接（`activate`）時才建立。
- **EME 失敗**：金鑰系統無法使用時，同一個 Worker 以 `eme: false` 重新決定路線，改走 WASM 串流並沿用同一回應與快取；播放中金鑰狀態失效（`EME_FAILED`）時，該集下一次嘗試停用 EME。
- WASM 處理上限只影響 WASM 路線選擇，不限制索引探測或原生 EME 直通。
- 每個步驟的 20 次額度在宣告需求前於主執行緒同步檢查，額度耗盡時不會再發出網路請求。
- 沒有 MSE 的環境（以及 Node 測試）無法使用應用程式處理路線，`media-worker-local.js` 會在目前執行緒執行同一套需求協調，只做索引探測與整檔讀取。
- `whole-file` 需求由同一個來源的讀取器依序組出整個檔案：已在快取中的範圍（索引探測、串流已下載的部分）不再請求，缺少的才以 Range 補齊，完成後以 transfer 交給主執行緒，不另外複製。檔案超過需求的 `maxBytes`（上限 320 MiB）時回報 `MEMORY_LIMIT`，不下載本體。撤回需求會停止讀取。

## 備援順序（#23）

`fallback-policy.js` 定義單一順序：原生 EME（已分段 CENC）→ WASM 串流 → 整檔處理（FFmpeg.wasm 解密封裝／ByteVC2 整檔轉碼）。

- **只有處理失敗才往下一層**：WASM 無法載入或執行、轉封裝／轉碼失敗、SourceBuffer／HEVC init 失敗、EME 設定失敗、沒有分段索引。HEVC 不再有獨立的整檔禁令。
- **來源失敗不備援**：CDN 403／429、Range 錯誤或不支援、逾時與過慢由 `download-source-session.js` 輪替同畫質候選或重新取源；整檔讀取只會再碰到同一個失敗的 CDN。
- **快取交接**：串流路線不可用或播放中處理失敗時，`cenc-remux.js` 不終止媒體 Worker，而是交給 `media-session.js` 保留（`createRetainedSources`，最多一個）。該集的整檔備援改用這個 Worker 的同一個需求繼續讀取，沿用尚未關閉的 HTTP 回應與位元組快取。換 CDN、換集、離開播放時釋放。
- 播放中發生處理失敗後，該集的下一次嘗試直接走整檔備援，不再重試串流。預載下一集永遠不啟動整檔處理。

## 匿名播放裝置與取源

瀏覽器以網站 origin 的 localStorage 保存一份匿名安裝資料（device_id、iid、cdid、clientudid、openudid、首次安裝時間）。識別不綁定代理 Worker 網址；重新整理、切集、切換 Worker 沿用同一份資料，不同瀏覽器使用者各自獨立。儲存不可用時僅保留本頁記憶體。Web Locks 可用時跨分頁合併初始化；否則只保證同頁合併。

裝置設定集中在 worker/vendor/device-profile.js：App 版本統一為已分析 APK Manifest 的 7.4.5.32／74532，註冊 payload、API query、API／註冊／媒體 UA 均共用版本、裝置型號、Android 版本及 DPI。SDK／簽名協定版本與硬體樣板保留既有適配器設定，未宣稱已從 APK 抓包驗證。

Worker 的 health 宣告 deviceSessions 與 deviceProfile。初次初始化使用 POST /api/device，已註冊識別隨 App 取源的 X-Playback-Device 標頭傳回，不放入 URL、來源快取或診斷 Log。Worker 冷啟動可直接沿用這份狀態，無須 KV。舊 Worker 未宣告能力時沿用原 API；舊客戶端沒有裝置標頭時則使用 isolate 內的相容快取。

註冊更新與每集取源分開：前景／背景到期時分別以 6／12 小時排程更新，版本 profile 改變也更新，但保留既有安裝識別並帶 did／iid。這些間隔不是 ID 有效期限；更新在背景執行，不阻塞正常取源；失敗繼續使用原識別。Worker 僅合併同一安裝的註冊，快取有數量上限，失敗冷卻也只影響該安裝。取源空白 HTTP 200 的裝置恢復例外見下述三次連續空白規則。

取源沒有固定間隔、全域佇列或跨請求拒絕狀態；一個慢速／403／429 請求不會擋住其他請求。單一 Worker 請求仍維持 deadline 與空白回應重試上限，不在同一次 Worker 請求內重試 403／429；跨請求恢復由前端分步驟執行。CDN 403 可換同畫質候選及重抓播放資訊，不能描述為整個播放一律停止；CDN 的 403／429、5xx、逾時或速度不足都淘汰該候選，不在該 CDN 重試；候選耗盡就重查片源。片源 API 本身的 429／Retry-After 仍依 API 步驟倒數，與 CDN 失敗分開。瀏覽器無法取得 HTTP 回應的 CORS 錯誤仍可用代理確認可讀性；已明確回傳 HTTP 失敗的 CDN 不再用代理重試。這是本專案的恢復選擇，APK 文件沒有確認完整 429 runtime 策略。裝置重用參考 APK 的安裝識別生命週期；不代表已證明空白 200 的原因，也不能消除 Worker 共用出口 IP 的影響。

## 目前等待狀態

頁面小字只呈現目前前景等待，不串接先前取源錯誤。失敗／倒數重試保留錯誤摘要；開始新工作就改顯示當下工作。各層回報結構化事件，playback-status 將等待狀態記入 playback.wait（layer、phase）並更新文字：下載、解密／解碼、播放。

下載器僅在必要讀取未命中位元組快取時發出 media.wait（pending）；資料到齊、失敗、取消時解除。尚有必要讀取時優先顯示下載等待，讀取恢復後顯示媒體處理，MSE 追加後顯示等待畫面。正常播放時隱藏處理進度，waiting／stalled 再顯示目前阻塞處；背景預取只寫 prefetch.stage，不覆蓋前景訊息，交接時會補送仍在等待的必要讀取狀態。

Beta 提示進一步列出 POST /api/device 的初始化註冊、/api/source 的網頁及 App 畫質候選查詢、CDN 候選編號及探測、MP4 檔頭／定位 moov／moov 索引讀取，以及影片必要位元組下載。MP4 與影片下載會附 byte 範圍；本文等待的 receivedBytes 與標頭回應分開記錄。裝置更新若不阻塞播放，只記 device.lifecycle，避免假裝是前景的等待。

網頁／App 候選查詢次數以瀏覽器發出的 /api/source 請求計算；Worker 同輪最多 3 次空白回應重試仍在該請求內，UI 不冒稱能即時觀察這些內部子請求。

`GET /api/source` 接受 `sid`、`vid`、`channel`（`app` 或 `web`，缺少或其他值回 400 `INVALID_SOURCE_CHANNEL`），以及選用的 App `device_level`（1–3，預設 3；其他值回 400 `INVALID_DEVICE_LEVEL`）。播放不送 `device_level`，網頁上也沒有選單；下載模式可另行指定。Worker 不接受畫質或編碼參數，也不再過濾候選：未知編碼、缺尺寸的 ByteVC2 等都原樣回傳；App 內嵌模型缺少解密金鑰的候選會先嘗試以 `fallback_api` 補齊，補不到則標記 `keyMissing: true` 回傳。能否播放或下載一律由瀏覽器判斷（`keyMissing` 與無法辨識的編碼不會被選來播放）。候選依 best → worst 排序：先比 `quality_type`（伺服器清晰度檔位號，越小越高），再比編碼尺寸 `min(vwidth, vheight)`，最後比 `bitrate`／`real_bitrate`。顯示的畫質標籤一律由真實編碼尺寸推導（`min(vwidth, vheight)` + `p`），只有缺尺寸時才沿用 `definition`；`definition` 與 `quality_type` 都是伺服器宣稱，可能一起灌水（例如宣稱 1080p、`quality_type` 1，實際 1280×720）。

App 取源的空白 HTTP 200 另依目前裝置累計連續次數；Worker 在 EMPTY_RESPONSE 回傳 upstreamStatus／emptyResponseCount，瀏覽器達 3 次就更換安裝識別及 did／iid，重新註冊後再取源。舊 Worker 未提供次數時，每個 EMPTY_RESPONSE 保守計為 1 次；一般 502、403／429 或 CDN 錯誤不觸發此機制，成功或其他取源錯誤會清空連續空白次數。這是恢復策略，不表示已確認裝置被封。

裝置恢復最多嘗試 3 次新註冊，並與同瀏覽器的並行取源共用進度；全部失敗則保存一分鐘冷卻期限，期間不送出 App 取源或裝置註冊，前景顯示倒數，到期重新嘗試。重新整理仍保留冷卻；成功的新裝置會保存，正常取源繼續重用。此流程只屬於第一層片源／裝置服務，不變更解密或播放層。

次數依 series／episode 與步驟分開，透過共享片源請求及預載 entry 保留；交接、候選輪替與刷新不重設。最多 20 次，從前景及預載的第一次嘗試開始合計；片源 API、CDN 探測、MP4 資訊讀取、影片下載與播放器載入不共用計數。取源 API 等可重試步驟失敗後採逐步增加、最多 8 秒的預設等待；Retry-After 可指定更久，介面會更新倒數。CDN 不可用則跳過此倒數，立即換候選／重查片源。達額度上限後停止並提示稍後重新整理；重新整理保留裝置資料。錯誤 Range、不支援的格式，以及刷新仍沒有新候選可提早停止，不為湊滿 20 次重送無效 URL。

101 集提供的 Log 顯示片源 API 成功，失敗在 CDN 的 bytes 0–65535，曾於 8.745 秒收到 206，卻被涵蓋標頭與本文的 10 秒總限中止。metadata Range 現改為標頭及本文進展各有 10 秒閒置期限，整次另有 30 秒總上限；range.timeout 的 readPhase 會記 headers／body 和已收到的 bytes。這是修正逾時預算，不代表已驗證真實 CDN 恢復，也不證明風控原因。

## 影集續播與順播

library.js 以 localStorage 分別保存逐集觀看紀錄及每部影集最後的 vid／seconds 游標；舊紀錄會以 viewedAt 遷移。開啟歷史影集或送出影集 ID 後進入播放，依該影集游標續播；不同影集不共用位置，游標指向已移除集數時不會把它的時間套給另一集。95% 的觀看完成標記不代表真正 EOF，游標仍保留實際位置，直到真正完成才轉下一集。

手動選集採該集的觀看位置。自然 ended 或下一集按鈕明確要求 startAt=0；就緒後以新觀看起點取代舊位置，防止 zero-time 保護把舊的 00:30 又寫回來。載入／切源期間的暫態時間仍不得覆蓋進度。推測性下一集一律從零準備；若使用者手動點選並需恢復較後位置，沿用預載 Worker、索引與 raw cache seek 到該位置，不另行取源。

ByteVC2 串流正常可同時存在兩個 MediaSource object URL：目前集數掛載一個（open、有 SourceBuffer），下一集預載保留一個未掛載的 MediaSource（closed、無 SourceBuffer）。Firefox 驗收會刻意等待預載，檢查一個可見、一個推測性來源，並確認切到下載模式後 object URL 全數釋放；不把總數等於一當成資源正確性的替代判斷。CENC beta 訊息驗收改查前後 CDN 候選與目前讀取步驟，不再要求把前次 403 串到新工作上。
