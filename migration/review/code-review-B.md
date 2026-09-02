# Code Review B — tg-monitor React 前端 functional parity（互動最重 6 分頁）

審查者：fresh-context code reviewer（未參與實作，向規格對齊，不向實作者對齊）
審查對象：Token 權限 / TG 已連接 / TG 待處理 / Pipelines / Toolsmith / Workers
產出中，逐分頁完成後追加寫入本檔，避免中斷遺失。

---

## Pipelines

判定：PASS

問題：無（逐項核對規格 §3/§4/§5，含高風險的「第 N 輪」顯示條件、階段表、retry/cancel 完整行為、三段異質列合併、跨頁跳轉、輪詢範圍，均與規格一致，未發現 BLOCKER/MAJOR/MINOR）

補充觀察（非缺陷，僅供參考）：
- `frontend/src/pages/pipelines/PipelinesListView.tsx:193-198`：`r.stdout_path`/`r.stderr_path` 為 null 時新版用 `if (path)` 靜默不動作，舊版直接無防禦地塞進 `esc()`；行為上不會造成可見差異（該欄位理論上恆有值），純屬新版比舊版多一層防禦，不算 parity 缺陷。
- 「第 N 輪」邏輯前端只負責原樣渲染 `s.detail`（`frontend/src/pages/pipelines/PipelineDetailView.tsx:69-74`），實際輪次計算在後端 `lib/ingest.ts`，前端 `{s.detail && (...)}` 正確依賴後端是否給值，既沒無條件顯示、也沒漏顯示。

覆蓋度：規格列了 11 個互動點，驗證 11 個
1. `#pl-reload` 重新整理 — 驗證 ✓（`PipelinesListView.tsx:233`）
2. `#pl-outcome-toggle` 隱藏/顯示結果欄 — 驗證 ✓（純前端 state，`hide-outcome` wrapperClassName）
3. 票號連結進 run 詳情 — 驗證 ✓（`navigate(pipelinesPath(r.key))`）
4. 「← 返回列表」 — 驗證 ✓
5. stdout/stderr/進度 log 連結 — 驗證 ✓（皆走 `logsPath()`）
6. 取消按鈕（confirm 文案、API body、成功/失敗 alert、一律 reload）— 驗證 ✓，文案與 index.html:515-516 一字不差
7. 重試按鈕（同上，含契約 §9#2「以 spec/confirm 文案為準」）— 驗證 ✓，confirm 文案與 spec/index.html:527-528 一字不差（「接續」語意，非「整張重跑」）
8. 遠端列 Worker 名稱連結（跳 Workers 詳情並帶 ticket）— 驗證 ✓（`workersPath(r.worker, r.ticket)`）
9. Agent 流程表列點擊開對話（不快取、每次重打）— 驗證 ✓（`handleOpenAgent` 對同 path 強制 `reload()`）
10. 對話卡片 `<details>` 折疊區塊 — 驗證 ✓（原生 HTML，無 JS handler）
11. cancelBtn/retryBtn 生成邏輯（併入第 6/7 點）— 驗證 ✓

---

## Toolsmith

判定：PASS

問題：
- [MINOR] `frontend/src/pages/toolsmith/ToolsmithDetail.tsx:27-28` — 「待回答問題」顯示條件比對舊版嚴格：舊版 `r.pendingQuestions?...`（index.html:632）只做 truthy 判斷，空陣列 `[]` 也會顯示（空的 `<ul>`）；新版加了 `run.pendingQuestions.length > 0`，空陣列時整列隱藏。實務上後端只在 `needs_clarification` 且 `lastRound` 存在時才賦值，該情境 questions 陣列幾乎不會是空的，屬理論邊界差異、無實際影響。修法：如需嚴格 parity 可改回不加 length 判斷，非必要。

其餘核對均一致：4 個互動點逐一比對 index.html:617-653 皆功能對等；欄位數量/順序/mono class 與原文一致；狀態徽章與部署關卡 pill 符號、終局結果格式逐字核對相符；工具列說明文案與 index.html:211 一致；空資料文案「無資料」、colSpan 對應一致；輪詢走 `topics.toolsmith`（無條件 5 秒輪詢，符合規格）。**契約 §8-2 的刻意行為差異已正確實作**——展開狀態用元件內 `useState<Set<string>>`（以 requestId 為 key）管理，輪詢重繪不影響已展開列（`ToolsmithPage.tsx:34-42, 146`）。`tsStatusPill`/`tsGatePills` 正確搬到分頁專屬的 `toolsmith/format.ts`，未污染共用 `lib/format.ts`。未見 `dangerouslySetInnerHTML`、未見自行 `fetch()`/`setInterval()`、未見 sleep/setTimeout 規避競態；log 連結走 `logsPath()`。

覆蓋度：規格列 4 個互動點，驗證 4 個
1. `#ts-reload` 重新整理 — 驗證 ✓
2. 每列「研究log」連結（`agentLogExists` 門檻）— 驗證 ✓
3. 每列「部署log」連結（`deployLogExists` 門檻）— 驗證 ✓
4. 每列展開/收合按鈕 — 驗證 ✓（純前端 state、輪詢不重置，符合契約 §8-2）

---

## Workers

判定：PASS

問題：無

覆蓋度：規格列了 7 個互動點，驗證了 7 個
1. `#wk-reload` 重新整理 — 驗證 ✓（`WorkersPage.tsx:34` `list.reload()`；無 confirm）
2. 每列「詳情」按鈕 — 驗證 ✓（`WorkersList.tsx:93` navigate to `workersPath(w.name)`）
3. 每列「中斷／恢復」按鈕 — 驗證 ✓（`WorkersList.tsx:31-42`，confirm 文案逐字比對相符，恢復無 confirm，成功靜默/失敗 alert，一律 reload）
4. 每列「移除」按鈕 — 驗證 ✓（`WorkersList.tsx:44-50`，confirm 文案逐字比對相符，破壞性操作確有 confirm）
5. 每列「重連」按鈕 — 驗證 ✓（`WorkersList.tsx:55-65`，無 confirm/無 alert，探測後刷新，靜默吞例外符合舊版）
6. 詳情頁「← 返回列表」— 驗證 ✓（`WorkerDetail.tsx:109` navigate to `workersPath()`）
7. 詳情頁「查詢」`#wkd-ticket-query` — 驗證 ✓（`WorkerDetail.tsx:158`，空值/無 name 不打 API，統一失敗文案）

另驗證：跨頁跳轉入口 `openWorkerTicket`（pipelines → workers 帶 name+ticket 自動查詢，`WorkerDetail.tsx:34,48-50` 用 `initialTicket` 還原）、三處 `pre.log` 已補 `maxHeight="30vh"`（03-shared-layer-patch.md C3）、渲染欄位/狀態徽章/空狀態文案/404 錯誤處理均與規格一致，未發現 dangerouslySetInnerHTML、自行 fetch/setInterval、或 sleep/setTimeout 規避競態。

---

## Token 權限

判定：PASS

問題：
- [MINOR] `frontend/src/pages/TokensPage.tsx:52` — 首次載入時顯示「載入中…」文字，違反規格 §5「無專屬 loading 狀態／骨架，`fetch` 期間畫面維持上一次渲染內容不變」；舊版 `#tk-table` 首次載入前是空白（`<div class="scroll" id="tk-table"></div>` 無預設內容），不會顯示任何文字。此為全批 6 頁中唯一加了 loading 文案的頁面（pipelines/tg-connected/tg-pending/workers/toolsmith 規格皆同樣要求「無 loading 骨架」且實作未見此文字）。修法：`loading && !data` 分支拿掉，直接讓 `!data` 走到 `null`（維持空白）。

其餘核對均一致：
- **9 個環境 checkbox 順序**：`frontend/src/pages/tokens/constants.ts` 的 `TKC_ENV_ORDER`（admin-dev, platform, platform-6t, admin-pre, admin-evi, platform-pre-pk, platform-pre-6t, platform-evi-6t, toolsmith）與 `TKD_ENV_ORDER`（admin-dev, admin-pre, admin-evi, platform, platform-6t, platform-pre-pk, platform-pre-6t, platform-evi-6t, toolsmith）逐一比對 `public/index.html:147-155`（`.tkc-env`）與 `public/index.html:168-176`（`.tkd-env`），兩處各自保留原始順序、未被「順手統一」。
- **契約 §8 第 3 條**：詳情頁 checkbox 勾選狀態用 `checkedEnvs` React state 管理，只在切換到不同的人（`person.id` 變動）時才用 `person.grants` 重新播種，同一人身上後續輪詢（`person.grants` 內容變動但 `person.id` 不變）不會覆蓋使用者手動勾選（`TokenDetailView.tsx:40-49`）——正確實作刻意行為差異，未錯誤地重現舊版「每次輪詢覆蓋」的副作用。
- 14 個互動點的 confirm/prompt 文案、API 端點與 body、成功/失敗訊息逐字比對 `tabs/tokens.md §4` 全部一致（新增表單前端校驗 3 個 alert、核發 confirm、詳情頁改名 prompt、簽發/移除/依勾選重發/刪除全部 confirm 文案皆逐字相符）。
- 表格欄位數量/順序/標題/格式化（`id` mono+強調色、`display_name`、環境表 `狀態/核發時間/使用/操作`）、狀態呈現規則（`n===0` 顯示「未使用過」）均與規格一致。
- 空資料「名冊為空」（`emptyMode="replace"`）、詳情頁找不到此人自動導回列表（`useEffect` 對應 `if(!p){closeTokenDetail();return}`）均符合規格。
- 輪詢：僅用單一 `useResource(topics.tokenGrants)`，理由是列表與詳情舊版本來就打同一個端點（`loadTokenGrants`/`loadTokenDetail` 內容相同），比契約字面「兩個 useResource 各配 enabled」更貼近舊版單一 API 呼叫的實際行為，非缺陷。
- 未見 `dangerouslySetInnerHTML`、未見自行 `fetch()`/`setInterval()`、未見 sleep/setTimeout 規避競態；API 呼叫全走 `src/api/endpoints.ts` 具名函式；中文文案未見潤飾；分頁未自畫 SubNav（由 `ConnectLayout` 統一渲染）。

覆蓋度：規格列了 14 個互動點，驗證了 14 個
1. subnav 三個 subtab — 驗證 ✓（由 `ConnectLayout` 統一渲染，非本頁自畫，符合契約）
2. `#tk-reload` 重新整理 — 驗證 ✓
3. 新增 token 表單 `#tkc-create` — 驗證 ✓（校驗、confirm、成功/失敗處理皆符合）
4. 列表頁「詳情」按鈕 — 驗證 ✓
5. 列表頁「重發 token」按鈕 — 驗證 ✓
6. 列表頁「移除 token」按鈕 — 驗證 ✓
7. 詳情頁「← 返回列表」— 驗證 ✓
8. 詳情頁「改名」— 驗證 ✓
9. 詳情頁每環境「簽發」按鈕 — 驗證 ✓
10. 詳情頁每環境「移除」按鈕 — 驗證 ✓
11. `resendKit` 共用邏輯（兩種文案分支）— 驗證 ✓
12. 詳情頁「依勾選重發 token」— 驗證 ✓
13. 詳情頁「刪除此人全部 token」— 驗證 ✓
14. 詳情頁 9 個 `.tkd-env` checkbox（純狀態輸入，不被輪詢沖掉）— 驗證 ✓

---

## TG 已連接

判定：FAIL

問題：
- [MAJOR] `frontend/src/pages/TgConnectedPage.tsx:58-88` — `DataTable` 呼叫沒有傳 `emptyMode="replace"`，預設走 `'row'` 模式：`connected` 為空時仍會渲染 `<table><thead>姓名/email/chat_id/(空)</thead><tbody><tr><td colSpan>尚無已連接的同事</td></tr></tbody></table>`（有表頭列）。規格 `tabs/tg-connected.md §3` 明文「空資料：`<div class="mute">尚無已連接的同事</div>`（**取代整個 table**）」，對照 `public/index.html:763-764` 空資料時 `#tuc-list.innerHTML` 直接整段換成 `<div class="mute">...</div>`，完全沒有 `<table>`/表頭。同一批次的 `TokenListView.tsx`（同樣措辭「取代整個 table」）已正確使用 `emptyMode="replace"`，本頁未跟進，導致空狀態下多一列表頭，DOM 結構與舊版不等效（會影響 Playwright 截圖比對的列高/邊框，即 `03-shared-layer-patch.md` D1 修補的同一類問題，但本頁未套用）。修法：`<DataTable<ConnectedUser> ... emptyMode="replace" ...>`。

其餘核對均一致：
- 3 個非 subnav 互動點（重新整理、測試發送、取消連接）的 API 端點/body、prompt/confirm 文案、成功/失敗 UI 反應（測試發送不重載、取消連接成功靜默重載/失敗才 alert 且不重載）逐字比對 `tabs/tg-connected.md §4` 全部一致。
- 表格欄位數量/順序（姓名/email/chat_id/操作）、`姓名` 強調色、`email`/`chat_id` mono、操作欄無表頭文字，均與規格一致；渲染順序未額外排序，符合「依 API 回傳順序」。
- 契約 §8 第 5 條：本頁自己打一次 `/api/tg-users`（`topics.tgUsers`），不與 tg-pending 共用 cache，符合刻意行為差異。
- 載入中／錯誤：規格明訂無 loading 骨架、`GET /api/tg-users` 失敗時舊版無任何 UI 提示——本頁未畫 loading/error 區塊，直接用 `data?.connected ?? []` 渲染，符合規格。
- 輪詢：`useResource(topics.tgUsers, undefined)` 無 `shouldPoll`/`enabled` 限制 = 無條件 5 秒輪詢，符合契約 §7（tg-connected 屬「無條件重查」組）。
- 未見 `dangerouslySetInnerHTML`、未見自行 `fetch()`/`setInterval()`、未見 sleep/setTimeout 規避競態；API 呼叫走 `src/api/endpoints.ts` 具名函式；中文文案未見潤飾；分頁未自畫 SubNav。

覆蓋度：規格列了 6 個互動點（3 個 subnav + reload + 測試發送 + 取消連接），驗證了 6 個
1-3. subnav 三個 subtab — 驗證 ✓（由 `ConnectLayout` 統一渲染，非本頁自畫）
4. `#tuc-reload` 重新整理 — 驗證 ✓
5. 每列「測試發送」按鈕 — 驗證 ✓
6. 每列「取消連接」按鈕 — 驗證 ✓（confirm 文案逐字相符）

---

## TG 待處理

判定：PASS

問題：無

**發現一處規格文件與原始碼矛盾（依硬邊界規則以 `public/index.html` 為準，此處實作正確、規格文件有誤）**：
`tabs/tg-pending.md §4` 第 4 點寫「SET_CONFLICT 覆蓋確認…若取消則不再動作，也不 alert」，但
`public/index.html:817` 原始碼是
`if (String(r.result).startsWith('SET_CONFLICT') && confirm(...)) { await assignTgUser(chatId, true); return }`
`alert(\`指定失敗：${r.result}\`)` ——
confirm 被取消（回傳 false）時，`if` 條件為 false、不會 `return`，會直接落到下一行的
`alert('指定失敗：...')`，也就是**取消時舊版其實還是會跳「指定失敗」的 alert**，規格文件寫「不再動作，也不 alert」與原始碼行為不符。`frontend/src/pages/TgPendingPage.tsx:50-57` 的實作結構與原始碼一致（`if (...&&...) {...; return}` 後緊接 `window.alert('指定失敗：...')`），也就是**忠實複刻了原始碼的真實行為（取消後仍會跳「指定失敗」alert）**，只是與規格文件文字描述不符——依硬邊界規則以原始碼為準，這不是實作缺陷。

其餘核對均一致：
- `resolveTechUserEmail`/`techUserLabel`（`frontend/src/pages/tg-pending/techUserResolve.ts`）逐行比對 `index.html:784/792-800`，比對順序（完整選項文字全等 → email 全等 → 小寫子字串唯一命中）、reason 文案（0 位／多位）皆逐字一致，正確放在分頁專屬目錄、未進共用 `lib/format.ts`。
- **輪詢保護**：`useResource(topics.tgUsers, undefined, { shouldPoll: () => !document.activeElement?.id?.startsWith('tup-sel-') })`（`TgPendingPage.tsx:26-28`）正確對應 `isPickingTechUser()`；且 `useResource.ts:114-129` 證實 `shouldPoll` 只作用於背景輪詢排程 effect，手動 `reload()`（重新整理按鈕、殼層全域刷新）呼叫 `subRef.current.refresh()` 不受此限制，與規格「reload 按鈕不受保護邏輯影響」一致；未使用 setTimeout/sleep 實作此保護。
- 「輸入中內容不被輪詢沖掉」：改用獨立 `inputs` React state（key 為 chat_id），輪詢只換 `data` 不動 `inputs`，效果等同舊版「重繪前存值、重繪後寫回」但更簡潔，非缺陷（無需重現舊版的補救手法本身）。
- 5 個互動點（含 datalist、輸入框、指定按鈕、SET_CONFLICT 二次確認遞迴重試）與輪詢保護邏輯全部驗證到；`POST /api/tg-users/assign` body `{chat_id,email,force}` 正確。
- 表格欄位數量/順序/className（chat_id mono、first_name 無、username mono、最後訊息 mono mute、指定技術人員無）、`first_name`/`last_name` 串接規則、`username` 加 `@` 前綴規則均與規格一致；`first_name` 為 `null` 時 `?? ''` 防禦與舊版 `esc(null)→''` 等效。
- 空資料 `emptyMode="replace"` + 不渲染 datalist（`pending.length > 0 &&`）正確對應規格「取代整個 table，此時也不渲染 datalist」。
- 契約 §8 第 5 條：本頁自己打一次 `/api/tg-users`，不共用 tg-connected 的 cache。
- 未見 `dangerouslySetInnerHTML`、未見自行 `fetch()`/`setInterval()`、未見 sleep/setTimeout；API 走具名函式；中文文案未見潤飾；分頁未自畫 SubNav。

覆蓋度：規格列了 5 個互動點，驗證了 5 個
1-3. subnav 三個 subtab — 驗證 ✓（由 `ConnectLayout` 統一渲染，非本頁自畫）
4. `#tup-reload` 重新整理（不受輪詢保護限制）— 驗證 ✓
5. 每列輸入框 + 「指定」按鈕（含 `resolveTechUserEmail` 判斷、SET_CONFLICT 二次確認遞迴）— 驗證 ✓
（`isPickingTechUser()` 輪詢保護邏輯併入第 4 點對照說明，已驗證 ✓）

---

## 覆蓋度

| 分頁 | 規格列的互動點 | 驗證到 | 判定 |
|---|---|---|---|
| Token 權限 | 14 | 14 | PASS |
| TG 已連接 | 6 | 6 | FAIL（1 MAJOR） |
| TG 待處理 | 5 | 5 | PASS |
| Pipelines | 11 | 11 | PASS |
| Toolsmith | 4 | 4 | PASS |
| Workers | 7 | 7 | PASS |

六個分頁的規格互動點全數逐項核對，無遺漏項目。

---

## 總結

六個分頁中，**五個 PASS、一個 FAIL**：

- **FAIL：TG 已連接** — `frontend/src/pages/TgConnectedPage.tsx:58-88` 的 `DataTable` 未傳
  `emptyMode="replace"`，空資料時會多渲染一列表頭（姓名/email/chat_id/操作），與規格
  `tabs/tg-connected.md §3`「取代整個 table」的要求、以及 `public/index.html:763-764` 的原始行為
  （空資料時整段直接換成 `<div class="mute">...</div>`，無 `<table>`）不符。同一批次的
  `TokenListView.tsx` 對相同措辭的規格已正確使用 `emptyMode="replace"`，本頁遺漏，屬單一 MAJOR
  缺陷，一行程式碼即可修復。

- 其餘五頁（Token 權限、TG 待處理、Pipelines、Toolsmith、Workers）逐項核對規格的互動功能／渲染邏輯／
  狀態與邊界／資料來源與輪詢，均與規格一致，僅發現兩處 MINOR、不影響功能的邊界差異：
  - `TokensPage.tsx:52` 首次載入顯示「載入中…」文字，規格明訂本頁「無專屬 loading 狀態／骨架」，
    舊版首次載入前是空白，本頁是本批 6 頁中唯一加了 loading 文案的頁面。
  - `ToolsmithDetail.tsx:27-28`「待回答問題」多加了 `length > 0` 判斷，比舊版嚴格，屬理論邊界差異
    （後端資料型態下幾乎不會觸發），無實際影響。

- 本批高風險點逐一驗證結果：
  - Pipelines「第 N 輪」顯示：前端正確依後端 `s.detail` 是否有值原樣渲染，無無條件顯示、無漏顯示。
  - Pipelines 階段表 / retry / cancel 按鈕：confirm 文案、API、成功失敗處理與 spec/index.html 一致，
    未被過時的「整張重跑」註解誤導。
  - Workers 三個管理按鈕（中斷/恢復/移除）：confirm 文案逐字相符，移除（破壞性操作）confirm 流程確實
    存在。
  - Token 權限 9 個環境 checkbox：`.tkc-env`／`.tkd-env` 兩處順序刻意不同，未被「順手統一」。
  - 「連接」三個 subtab：Token 權限／TG 已連接／TG 待處理三頁皆未自畫 SubNav，統一由殼層
    `ConnectLayout` 渲染。
  - 跨頁跳轉（`workersPath(name,ticket)` / `pipelinesPath(key)` / `tokensPath(id)` 等）：目標分頁
    皆能正確從 query 參數還原對應流程。

- 契約 §8 三條與本批直接相關的「刻意行為差異」皆正確落實：Toolsmith 展開列不被輪詢收合
  （`ToolsmithPage.tsx:34-42`）、Token 詳情頁 checkbox 不被輪詢沖掉（`TokenDetailView.tsx:40-49`）、
  tg-connected/tg-pending 各自打一次 `/api/tg-users`。

- 額外發現一處規格文件本身的錯誤（非實作缺陷，依硬邊界規則以 `public/index.html` 為準）：
  `tabs/tg-pending.md §4` 描述 SET_CONFLICT 取消後「不再動作，也不 alert」，但原始碼
  （`index.html:817-818`）取消後其實會落到 `alert('指定失敗：...')`；`TgPendingPage.tsx` 的實作忠實
  複刻了原始碼行為，規格文件文字描述有誤。

- 六個分頁均未發現 `dangerouslySetInnerHTML`、未發現自行 `fetch()`/`setInterval()`、未發現
  `sleep`/`setTimeout` 規避競態；API 呼叫全數走 `src/api/endpoints.ts` 具名函式；中文文案逐一比對
  未見潤飾。
