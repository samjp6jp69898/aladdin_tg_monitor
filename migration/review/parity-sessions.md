# 使用 Session 分頁 — Parity 對照表

實作範圍：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/SessionsPage.tsx`（單檔，未拆子元件——本頁邏輯單純，Rule 2/3 判斷不需額外拆分）

規格依據：`migration/tabs/sessions.md`（互動功能 §4、渲染邏輯 §3、狀態與邊界 §5）、`migration/02-frontend-contract.md`。

---

## 1. 互動功能對照表（sessions.md §4，5 項）

| # | 規格項目 | 實作位置 |
|---|---|---|
| 1 | `select#ss-service` `onchange` → `loadSessions()` | `SessionsPage.tsx:101-106`：`<select value={service} onChange={e => setService(e.target.value)}>`。`service` 是 `useResource(topics.sessions, {...})` 的 params 之一（`SessionsPage.tsx:31-35`），改變後 `useResource` 依 `JSON.stringify(params)` 偵測到差異自動重打 `/api/sessions`，效果等同呼叫 `loadSessions()`。 |
| 2 | `select#ss-days` `onchange` → `loadSessions()` | `SessionsPage.tsx:115-120`：`<select value={days} onChange={e => setDays(e.target.value)}>`，同上機制（`days` 也是 params 成員）自動觸發重查。 |
| 3 | `input#ss-identity` `onkeydown`，僅 `Enter` → `loadSessions()` | `SessionsPage.tsx:107-114`：`onKeyDown={e => { if (e.key === 'Enter') runQuery() }}`；`runQuery`（`SessionsPage.tsx:37`）把輸入框目前值 trim 後寫入 `identity` state（真正進 params 的值），觸發重查。輸入框本身用獨立的 `identityInput` state 做受控元件（每個按鍵都更新畫面），但**不會**每個按鍵都打 API——只有 Enter／按鈕才把值提交進查詢用的 `identity` state，對應舊版「只在 Enter 才查」的行為。 |
| 4 | `button#ss-reload`（"查詢"）`onclick` → `loadSessions()` | `SessionsPage.tsx:121`：`<Button onClick={runQuery}>查詢</Button>`，呼叫同一個 `runQuery`。 |
| 5 | 每列「看事件」連結 `onclick="jumpEvents(service, identity)"` | `SessionsPage.tsx:81-95`：`<a href={eventsPath({service, identity})} onClick={e => {e.preventDefault(); navigate(eventsPath({service, identity}))}}>看事件</a>`。`eventsPath()`（`lib/navigation.ts`）只帶 `service`/`identity` 兩個 query 參數，對應舊版 `jumpEvents` 只設 `#ev-service`/`#ev-identity` 兩欄（不碰 `q`/`errors`/`toolOnly`），跳轉後由 `EventsPage` 用 `useSearchParams()` 讀出當初始篩選值（契約 §6.2）。 |

**5/5 對應完成。**

無 confirm/alert 對話框（唯讀分頁）——與規格「無任何 confirm/alert 對話框」一致，程式碼中沒有任何 `window.confirm`/`window.alert` 呼叫。

**額外說明（設計差異，非缺陷）**：舊版 `#ss-service`/`#ss-days` 的 `onchange` 與 `#ss-reload` 的 `onclick` 都各自明確呼叫一次 `loadSessions()`；新版把「服務」「天數」直接綁進 `useResource` 的 `params`，改變即自動重查（不需要顯式呼叫）。`查詢`按鈕與 Enter 鍵仍各自呼叫 `runQuery()` 明確提交 identity。唯一的行為邊角案例：若使用者在 identity 輸入框打了跟目前查詢值完全相同的字串後按 Enter/查詢，`setIdentity` 因為新舊值相等（`Object.is`）不會觸發 re-render，因此不會真的重打一次 API——但畫面內容本來就與伺服器最新狀態一致（5 秒全域輪詢本來就會保持更新），不影響可觀察行為，純屬多一次冗餘 HTTP 請求與否的差異。

---

## 2. 渲染欄位對照表（sessions.md §3，11 欄）

| 表格欄 | 規格格式化方式 | 實作位置 |
|---|---|---|
| 使用者 | `<b style="color:var(--acc)">{esc(identity)}</b>` | `SessionsPage.tsx:42-46`：`<b style={{color:'var(--acc)'}}>{s.identity}</b>`（React 文字節點自動跳脫，等效 `esc`） |
| 服務 | `esc(service)` 原樣 | `SessionsPage.tsx:47`：`s.service` |
| 開始 | `fmt(s.start)`，`.mono` | `SessionsPage.tsx:48`：`className:'mono'`，`render: s => fmt(s.start)` |
| 結束 | `fmt(s.end)} <span class="mute">{ago(s.end)}</span>`，`.mono` | `SessionsPage.tsx:49-58`：`className:'mono'`，`render` 回傳 `fmt(s.end)` + `<span className="mute">{ago(s.end)}</span>` |
| 時長 | `dur(s.start, s.end)`，`.mono` | `SessionsPage.tsx:59`：`dur(s.start, s.end)` |
| 請求 | `s.count` 原樣，`.mono` | `SessionsPage.tsx:60` |
| 錯誤 | `.mono`，`errors` 真值時額外加 `err` class | `SessionsPage.tsx:61-67`：`className:'mono'` + `cellClassName: s => s.errors ? 'err' : undefined`（`DataTable` 會把兩者合併成 `class="mono err"`，等效舊版 `class="mono ${errors?'err':''}"`） |
| 登入帳號 | `esc(s.logins.join(', '))`，`.mono` | `SessionsPage.tsx:68`：`s.logins.join(', ')` |
| IP | `esc(s.ips.join(', '))`，`.mono.mute` | `SessionsPage.tsx:69`：`className:'mono mute'` |
| tool 序列 | 見 §3.1（`.tools` class，每 tool 一個 `<span>`；空 → 灰字「（只有握手，未呼叫 tool）」） | `SessionsPage.tsx:70-80`：`className:'tools'`，非空時 `s.tools.map((t,i) => <span key={i}>{t}</span>)`（依序、允許重複、不去重），空時 `<span className="mute">（只有握手，未呼叫 tool）</span>` |
| （操作欄） | `<a href="#events" onclick="jumpEvents(...)">看事件</a>` | `SessionsPage.tsx:81-95`（見互動表第 5 項） |

**11/11 欄對應完成。**

排序（sessions.md §3.2）：完全依 API 回傳順序，前端不重新排序——實作直接 `rows={sessions.data?.sessions ?? []}`，未對陣列做任何 `.sort()`。

輪詢：本分頁**沒有**像 events 的「自動更新」開關，`useResource(topics.sessions, {...})` 用預設選項（`autoRefresh` 預設 `true`），每次全域 5 秒輪詢都重查，符合規格「本分頁沒有自動更新開關，只要在此分頁就每次輪詢都重查」。

---

## 3. 狀態與邊界對照（sessions.md §5）

| 情境 | 規格畫面表現 | 實作 |
|---|---|---|
| 查無資料（`sessions.length===0`） | `<tr><td colspan="11" class="mute">無資料</td></tr>` | `SessionsPage.tsx:127`：`<DataTable ... emptyText="無資料" .../>`（`emptyTone` 預設 `'mute'`、`emptyMode` 預設 `'row'`，`colSpan` 由 `DataTable` 自動取 `columns.length`，本頁欄數恰為 11，等效舊版 `colspan="11"`） |
| 段內請求全是握手、無 tool 呼叫 | tool 序列欄顯示「（只有握手，未呼叫 tool）」 | 見 §2「tool 序列」列 |
| API 呼叫例外 | 透過 `refresh()` 觸發時被外層 `try/catch` 吞掉，畫面維持舊資料、無錯誤提示 | `SessionsPage.tsx` 未讀取 `sessions.error`、未渲染任何錯誤訊息；`useResource` 失敗時只更新內部 `error` state 並保留既有 `data` 不變（`hooks/useResource.ts:93-96`），畫面自然維持上次成功取得的資料，效果等同舊版的靜默吞例外。 |
| 首次載入 | 無 loading 骨架/spinner | `SessionsPage.tsx` 未針對 `sessions.loading` 渲染任何骨架/spinner；`DataTable` 在 `data` 為 `null` 時吃到 `rows={[]}`，短暫顯示「無資料」列直到第一批資料回來，與舊版初始空 `tbody` 效果一致（無額外 loading UI）。 |
| `services` 尚未載入（下拉選單為空） | 進入本分頁時 `refresh()` 先檢查 `if (!services.length) await loadOverview()` 自動補上 | `SessionsPage.tsx:28-29`：無條件 `useResource(topics.overview, undefined)` 取得 `services`（`filter(s => s.hasAudit)` 產生 `serviceOptions`），採契約 §6.3 明訂的 React 版做法（`/api/overview` 本身是 5 秒輪詢的便宜端點，不需要額外的「是否已載入」判斷），功能等效舊版的補載邏輯。 |

---

## 4. 未達成項目

無。5 項互動功能、11 個渲染欄位、5 種狀態/邊界全部對應完成，`bunx tsc --noEmit -p tsconfig.app.json` 零錯誤。

（未使用共用層以外的私有繞法；未發現共用層缺口，SHARED_LAYER_GAPS: none。）
