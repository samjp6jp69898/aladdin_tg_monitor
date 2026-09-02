# Code Review A — React 前端 5 分頁 functional parity 審查

審查者：fresh-context 獨立審查（未參與實作），向規格對齊，不向實作者對齊。
審查依據：`migration/tabs/{overview,events,sessions,stats,logs}.md`；衝突時以 `public/index.html` 為唯一事實來源。
判讀基準：`migration/02-frontend-contract.md` §8（5 條已定調刻意差異）、§9（已知文件落差）；`migration/03-shared-layer-patch.md`（共用層兩輪補強，含 `DataTable.emptyMode`、`LogViewer.maxHeight`/`autoScroll`、`useLogFollow` 截斷偵測、`useResource` effect 拆分）。
未讀取 `migration/review/parity-*.md`（依指示禁止，避免錨定效應）。只讀不改，未做任何 commit。

---

## 總覽

判定：**PASS**

問題清單：
- [MINOR] `frontend/src/pages/OverviewPage.tsx:211-213`（同樣模式重複於 `221-223`）—「背景 Pipeline 併發」卡片「Bug /create-mr」「需求 pipeline」兩行，`{used} / {limit}` 之後的 `<Badge>排隊 N</Badge>` 與 `{limitNote}` 前面各漏了一個空格。舊版字串樣板 `${used}/${limit}${queued? ` <span class="pill warn">...` : ''}${limitNote}` 在 badge/limitNote 前有字面空格；JSX 版把三段拆成各自獨立的表達式（無 `{' '}`），JSX 編譯器會丟棄純空白的行間文字節點，實際渲染會變成 `3 / 5排隊 2` 這種數字直接貼齊徽章的樣子。同頁其他位置（`:137`、`:166`、`:183`）都有正確補 `{' '}`，只有這兩處漏了。修法：在 `<Badge>`／`{limitNote}` 前各補一個 `{' '}`。

其餘已核對通過：服務卡片欄位（狀態圓點、UP/DOWN、port/proxy/launchd pill、PID/延遲、uptime、請求數、最後事件、名冊人數、使用者清單三態）與 `index.html:291-305` 一致，全部走 `ago`/`upt`，未自刻格式化；Webhook 卡片保留原版看似手誤的全形右括號「）」（未被順手修正）；重啟/取消 pipeline 的 confirm/alert 文案與 `index.html:330-334`、`:516-519` 逐字相符；`/api/overview`、`/api/status-log` 走 `useResource`/`topics.overview`/`topics.statusLog`，輪詢間隔皆為 5000ms；狀態邊界（webhook 失敗、無稽核、無人使用、狀態翻轉為空、`lastEvent`/`probe` 為 null、無 skeleton、輪詢失敗維持舊資料）逐條核對通過；未發現 `dangerouslySetInnerHTML`、未發現自刻 `sleep`/`setTimeout`。

覆蓋度：4 / 4 個互動點（重啟按鈕、TG 連接名單「查看」連結×2、Running Pipeline「取消」按鈕、`fillServiceSelects()` 等效實作）全部驗證。

---

## 即時序列

判定：**FAIL**

問題清單：
- [MAJOR] `frontend/src/pages/EventsPage.tsx:84-87`（`runQuery`）— 每次篩選變動（service 下拉／errors／tool-only checkbox／Enter／查詢鈕）都會先呼叫 `setQueryParams(next)`，緊接著同步呼叫 `void resource.reload()`。`useResource.reload()`（`hooks/useResource.ts:127-129`）讀的是呼叫當下的 `subRef.current`，而「取資料 effect」要等 `paramsKey` 真的變了才會重跑（此時 React 尚未處理完 `setQueryParams` 排入的重渲染）。`subscribe()`（`api/transport.ts:106-146`）的 `params` 是呼叫當下閉包捕捉的值，不會事後更新，所以 `reload()` 打到的其實是**用舊篩選參數建立的訂閱**，會先送出一次帶舊參數的 `/api/events` 請求；隨後 effect 因 `paramsKey` 改變重建訂閱，又立即送出一次帶新參數的請求（`transport.ts:149` 首次載入必定立即打一次）。同一次篩選操作打了兩次 API，其中一次參數是錯的；最終畫面是否短暫閃過舊篩選結果，取決於「effect cleanup 的 `abort()` 是否搶在舊請求 resolve 之前完成」——這是未受結構保證的時序競賽，違反專案硬規則「正確性必須由結構保證，不得用等待/時序處理」的精神，也不符合規格 §4「篩選變動只觸發一次 `loadEvents(false)`」的單次查詢語意。修法：`runQuery` 不要在 `setQueryParams` 之後緊接呼叫 `reload()`；改用 `useEffect` 依 `queryParams` 變化觸發重抓，或讓 `useResource` 提供「setParams + 以新參數立即 reload」的原子 API。

- [MINOR] `frontend/src/pages/EventsPage.tsx:105-116`（`loadMore`）vs `public/index.html:342`（`evQuery`）— 舊版「載入更早」讀取的是當下 DOM 即時值（不論是否已按 Enter 提交）；新版用的是最後一次已提交的 `queryParams`。使用者改了 identity/q 輸入框但未按 Enter 就點「載入更早」時，兩版行為不同。屬邊界情境，未列在 §8 已定調差異中。

- [MINOR] `frontend/src/pages/EventsPage.tsx:108`（`if (oldestId == null) return null`）vs `public/index.html:346-352` — 舊版即使 `evOldest` 為 `null` 仍會發一次不帶 `before_id` 的請求；新版直接不打 API。極端邊界（全站無事件資料時）行為差異，影響輕微。

其餘已核對通過：表格欄位數量/順序/標題文字（時間/服務/使用者/tool/結果/耗時/展開）與 `index.html` 一致；「結果」欄徽章邏輯（auth_failure 顯示 `reason`，其餘走 `ResultBadge`）正確；耗時格式化一致；輪詢間隔 5000ms 未被更改；`emptyMode="none"` 正確用於刻意無空狀態文案的情境（未誤用 `emptyText=""`）；未使用 `ago()`/`RelativeTime`（符合 events.md 明確排除的規定）；未使用 `dangerouslySetInnerHTML`；未自寫 `fetch`/`setInterval`；`#ev-live` 的 `autoRefresh` 語意正確接到 `useResource`，切換不會多打即時 fetch（共用層 D2 補強已生效）；篩選列文案逐字比對一致。

覆蓋度：9 / 9 個互動點驗證到（`select#ev-service`、`input#ev-identity`(Enter)、`input#ev-q`(Enter)、`checkbox#ev-errors`、`checkbox#ev-tool-only`、`checkbox#ev-live`、`button#ev-reload`、`button#ev-more`、展開/收合），其中 5 個受上述 MAJOR 競態影響。

---

## 使用 Session

判定：**FAIL**

問題清單：
- [MAJOR] `frontend/src/pages/SessionsPage.tsx:37`（`runQuery = () => setIdentity(identityInput.trim())`），用於 `:111-113`（identity 欄位 Enter）與 `:121`（「查詢」按鈕 onClick）— 只呼叫 `setIdentity(...)`，沒有強制呼叫 `sessions.reload()`。`useResource` 的取資料 effect 依 `JSON.stringify(params)` 判斷是否需要重抓（`hooks/useResource.ts:69,110`）；若 trim 後的 identity 與目前已提交值相同（篩選條件沒變、單純想手動重查），`setIdentity` 不會改變 paramsKey，effect 不會重抓——點「查詢」或按 Enter 完全沒反應。規格明載 `button#ss-reload`／`input#ss-identity` Enter 皆對應 `loadSessions()`（`sessions.md:103-106`），舊版每次呼叫都是**無條件重查**。同倉庫 `EventsPage.tsx:84-87` 的 `runQuery` 已示範正確修法（`setQueryParams(...)` 後緊接 `void resource.reload()`），Sessions 頁漏做了同一件事（但也因此不受 Events 頁那個 reload 競態問題影響，因為 Sessions 頁根本沒呼叫 reload）。修法：`runQuery` 補上 `void sessions.reload()`。

- [MINOR] `frontend/src/pages/SessionsPage.tsx:127` 搭配 `DataTable` 預設 `emptyMode='row'`（`components/shared/DataTable.tsx:90`）— 首次進入分頁尚未拿到第一筆回應、或 API 呼叫失敗時（`sessions.data` 為 `null`），`rows` 為空陣列，`DataTable` 會主動顯示「無資料」列；舊版此時 `#ss-body` 維持原本空白（`await` 未完成/拋錯時賦值敘述不會執行），不會顯示「無資料」（那只對應成功回應且 0 筆的情況）。修法：`sessions.data` 為 `null` 時傳 `emptyMode="none"`，只有成功回應且 0 筆才用 `'row'`。

其餘已核對通過：表格 11 欄順序/標題/格式化（`:41-96` vs `sessions.md` §3）；tool 序列渲染與空狀態文案；`/api/sessions` 參數組裝與省略空值規則；輪詢間隔 5000ms（未被覆寫）；服務下拉只列 `hasAudit`；「看事件」連結行為正確；未發現 `dangerouslySetInnerHTML`、自寫 `fetch`/`setInterval`、或用 sleep 規避競態。

覆蓋度：5 / 5 個互動點驗證到（`select#ss-service`、`select#ss-days`、`input#ss-identity`(Enter)、`button#ss-reload`、「看事件」連結），其中 identity Enter 與查詢鈕兩個因同一根因判為 FAIL。

---

## 歷史統計

判定：**PASS**

問題清單：
- [MINOR] `frontend/src/pages/StatsPage.tsx:26-27` — 舊版 `loadStats()` 每次觸發（含 `#st-days` 變更）都會同步呼叫 `/api/rosters`（`stats.md` §2「與 /api/stats 同步觸發」）；新版 `stats`／`rosters` 是各自獨立的 `useResource`，改變 `days` 只重打 `/api/stats`，不會連帶重打 `/api/rosters`。因 rosters 本身仍以獨立 5 秒輪詢刷新，實際可見的資料落差最多 5 秒，屬理論偏差、非可感知的功能性缺陷。修法（若要求逐字對齊）：`days` 變動時一併呼叫 `rosters.reload()`。

其餘已核對通過：Token 名冊表空狀態正確使用 `emptyMode="none"`（未誤用 `emptyText=""`），對應 `stats.md` §3.7/§5「只顯示表頭列，無提示文案」；長條圖尺寸/padding/`step`/`top`演算法/`n===0`與`n>0`兩種 opacity 分支/tooltip 文字格式，與 `index.html:370-389` 完全一致，未另刻圖表邏輯；`topics.stats`/`topics.rosters` 皆用預設 5000ms；`days` 為 React state，不受輪詢覆蓋；五張表（每日×服務、使用者排行、tool 排行、認證失敗來源、Token 名冊）欄位數/順序/文字/排序皆與 `index.html:391-405` 及 stats.md §3.3-3.7 一致；error 不清空既有 data；未發現重寫 format.ts、`dangerouslySetInnerHTML`、自寫 fetch/setInterval。

覆蓋度：5 / 5 個互動點驗證到（`select#st-days`、`button#st-reload`、tool 排行「看錯誤/看事件」連結、認證失敗來源「看事件」連結、長條圖 tooltip）。

---

## Logs

判定：**FAIL**

問題清單：
- [BLOCKER] `frontend/src/pages/LogsPage.tsx:110`（`<LogViewer text={log.text} autoScroll={follow} .../>`）— 把「捲到底」整組行為綁在 `follow` checkbox 上。但 `LogViewer` 內部（`components/shared/LogViewer.tsx:36-51`）所有捲動邏輯都包在 `if (autoScroll && el) {...}` 裡，`autoScroll=false` 時連「初次載入/整批替換一律捲到底」都不會執行。規格明載（`logs.md:79,102`，對應 `index.html:744` `out.scrollTop=out.scrollHeight`）：**初次載入 tail 內容一律無條件捲到底，與 `#lg-follow` 是否勾選無關**——follow 只應該影響「後續追加內容」是否自動捲動。結果：使用者一旦取消勾選「即時跟隨」，之後切換檔案/改 kb/按「重新載入」都不會捲到最新內容，畫面停在舊捲動位置。修法：`autoScroll` 固定傳 `true`（不要用 `follow`），`follow` 只需要控制 `useLogFollow` 是否發起輪詢；`LogViewer` 內建的「追加時看是否在底部」判斷本身已經正確處理另一半語意。

- [MAJOR] `frontend/src/pages/LogsPage.tsx:101`（`checkbox#lg-follow` 的 `onChange` 只呼叫 `setFollow`）— 規格（`logs.md:125`，對應 `index.html:823` `$('#lg-follow').onchange = loadLog`）明訂勾選狀態改變要重跑**整個 `loadLog()`**：重新打 `/api/log/tail`、把畫面內容整批換成新 tail 結果、重設 offset。但 `useLogFollow.ts:94` 階段 1（tail fetch）的 effect 依賴陣列是 `[path, kb, epoch]`，**不含 `follow`**；只有階段 2（跟隨訂閱，`useLogFollow.ts:120` 依賴 `[path, follow, missing, epoch]`）會因 `follow` 改變而重啟/停止。結果：使用者取消再重新勾選「即時跟隨」時，畫面不會重新從 tail 讀取，而是延續舊有累積內容繼續 poll，與舊版「每次切換都整批重讀」不一致。修法：讓 `follow` 也能觸發完整重載（例如 follow 變動時也 bump 內部 `epoch`，或把 `follow` 納入階段 1 的 effect 依賴）。

- [MINOR] `frontend/src/hooks/useLogFollow.ts:111-113` — `setOffset(res.offset)` 在每次 `/api/log/since` 成功回應後無條件執行（即使 `res.text` 為空字串），而 `#lg-info` 顯示直接衍生自 `offset`（`LogsPage.tsx:76`）。舊版（`index.html:753`）只在 `r.text` 非空時才更新 `#lg-info`。差異只在檔案被截斷/輪替偵測到的那一個 tick：舊版 `#lg-info` 維持截斷前的舊值，新版會立刻顯示 `0.0KB`。影響極小，僅發生於 log rotate 瞬間。

其餘已核對通過：檔案清單表格與 `select#lg-file`/`select#lg-kb`/`button#lg-reload` 對應正確；`fmtKb` 永遠顯示 KB、未被自作主張換算 MB/GB；雙層輪詢間隔（檔案清單 5000ms、即時跟隨 1500ms）數值正確，未被改成整數好記的數字；焦點保護（`shouldPoll: () => document.activeElement?.id !== 'lg-file'`）正確；檔案不存在 `missing:true` 的空狀態文案「(檔案不存在)」正確；未發現 `dangerouslySetInnerHTML`、自寫 fetch/setInterval、或 sleep 規避競態。

覆蓋度：4 / 5 個互動點驗證到（`select#lg-file`、`select#lg-kb`、`button#lg-reload` PASS；`checkbox#lg-follow` FAIL；`window.openLog(path)` 跨分頁呼叫規格明載非本次拆解範圍，僅粗略確認初始選取機制存在，未深入驗證，不計入判定）。

---

## 覆蓋度

| 分頁 | 規格列出互動點數 | 驗證到的互動點數 |
|---|---|---|
| 總覽 | 4 | 4 |
| 即時序列 | 9 | 9 |
| 使用 Session | 5 | 5 |
| 歷史統計 | 5 | 5 |
| Logs | 5（1 項規格明載非本次範圍） | 4（+1 粗略確認未深入） |

---

## 總結

5 個分頁中，**總覽**與**歷史統計**判定 PASS（各僅 1 個 MINOR，不影響功能）；**即時序列**、**使用 Session**、**Logs** 判定 FAIL。

共通的失效模式是「篩選/操作觸發重查」這條路徑最容易漏做或做錯：
- **即時序列**（MAJOR）：`runQuery` 在 `setQueryParams` 之後緊接同步呼叫 `reload()`，因 `subscribe()` 閉包捕捉的是舊 params，導致一次多餘且參數錯誤的 API 呼叫，正確性依賴 abort 競速而非結構保證。
- **使用 Session**（MAJOR）：`runQuery` 只做了 `setQueryParams` 的那一半（`setIdentity`），完全漏了強制 `reload()`，同一份 identity 重複查詢時「查詢」按鈕会靜默失效。
- 兩個問題根因相反（一個是多做了但做錯位置，一個是少做）但都指向同一件事：**共用層沒有提供「setParams + 立即以新值 reload」的原子操作**，兩個分頁各自手刻這段邏輯時各自出錯。如果要一次性修好，建議把這個模式收斂進 `useResource` 或另提供一個小 helper，而不是讓 11 個分頁各自複製貼上容易出錯的兩行。

**Logs** 分頁的 BLOCKER 屬於「共用元件的能力被誤用」：`LogViewer` 的 `autoScroll` prop 語意是「這個元件實例要不要自動捲動」，但舊版語意其實是「初次載入一律捲、只有追加才看 follow」——`LogViewer` 本身的追加判斷已經內建這個區分，问题出在呼叫端把整個 `autoScroll` 綁死在 `follow` 這個使用者切換得到的狀態上，導致關閉「即時跟隨」後新開的檔案/reload 都不會捲到底。這是本次審查中最嚴重的單一問題，因為它是一個使用者操作一次就能穩定重現的可見缺陷（不像 events 的競態需要巧合時機）。

其餘 MINOR 問題多屬邊界情境（極端空資料、log rotate 瞬間、DOM append vs. 已提交狀態的細微落差）或純視覺瑕疵（JSX 漏了一個 `{' '}`），不影響核心 parity 判定。

REVIEW_RESULT: FAILED
BLOCKERS: 1
- frontend/src/pages/LogsPage.tsx:110 — autoScroll 綁死在 follow，取消即時跟隨後初次載入/整批替換不再無條件捲到底，違反 logs.md §3.2 與 index.html:744 的規則
MAJORS: 3
- frontend/src/pages/EventsPage.tsx:84-87 — runQuery 的 reload() 打到舊 params 的訂閱閉包，產生一次參數錯誤的 API 呼叫，正確性依賴 abort 競速而非結構保證
- frontend/src/pages/SessionsPage.tsx:37 — runQuery 漏呼叫 sessions.reload()，identity 未變時查詢按鈕/Enter 靜默失效
- frontend/src/pages/LogsPage.tsx:101 + frontend/src/hooks/useLogFollow.ts:94 — checkbox#lg-follow 切換未觸發完整 tail 重讀，只重啟/停止跟隨訂閱
COVERAGE: overview=4/4,events=9/9,sessions=5/5,stats=5/5,logs=4/5
REPORT_PATH: /Users/user/aladdin/tg-monitor/migration/review/code-review-A.md
