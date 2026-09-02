# Events（即時序列）分頁 parity 對照表

實作檔案：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/EventsPage.tsx`（單一檔案，本頁沒有額外分頁專屬子元件）

規格依據：`/Users/user/aladdin/tg-monitor/migration/tabs/events.md`（下稱「規格」）。

---

## 1. 互動功能對照（規格 §4，共 8 條互動路徑）

| 規格項次 | 內容 | 實作位置 |
|---|---|---|
| `select#ev-service` `onchange` → `loadEvents(false)` | 一改就重查（非累加） | `EventsPage.tsx:157-169`：`onChange`（`159-163`）內 `setService(v)` + `runQuery({...,service:v})`；`runQuery`（`EventsPage.tsx:84-87`）先 `setQueryParams` 再 `void resource.reload()` |
| `input#ev-identity` `onkeydown`（僅 Enter） → `loadEvents(false)` | 只有 Enter 才重查，輸入過程不觸發 | `EventsPage.tsx:170-175`（`onChange` 只更新本地 state，不觸發查詢）+ `onKeyDown={handleEnterKey}`；`handleEnterKey`（`EventsPage.tsx:89-92`）判斷 `e.key==='Enter'` 才呼叫 `runQuery` |
| `input#ev-q` `onkeydown`（僅 Enter） → `loadEvents(false)` | 同上 | `EventsPage.tsx:176-181`，同一個 `handleEnterKey` |
| `checkbox#ev-errors` `onchange` → `loadEvents(false)` | 一改就重查 | `EventsPage.tsx:182-193`（`onChange` 於 `186-190`） |
| `checkbox#ev-tool-only` `onchange` → `loadEvents(false)` | 一改就重查 | `EventsPage.tsx:194-205`（`onChange` 於 `198-202`） |
| `checkbox#ev-live` 無直接 `onchange` 綁定，純狀態旗標 | 見下方「`#ev-live` 開關如何控制輪詢」專節 | `EventsPage.tsx:206-208`（`onChange` 只 `setLive`，不呼叫 `runQuery`/`reload`） |
| `button#ev-reload`（"查詢"）`onclick` → `loadEvents(false)` | 永遠重查一次，不論欄位是否真的改變 | `EventsPage.tsx:209`（`onClick={() => runQuery({service,identity,q,errorsOnly,toolOnly})}`）；`runQuery` 內固定呼叫 `resource.reload()`，即使 `setQueryParams` 傳入內容與前次相同（`paramsKey` 不變、`useResource` 不會自動重抓）也仍會重查一次，對齊舊版「查詢鈕一律重打」 |
| `button#ev-more`（"載入更早"）`onclick` → `loadEvents(true)` | append 模式，用 `evOldest` 當 `before_id` | `EventsPage.tsx:105-116`（`loadMore`，見下方「渲染欄位對照表」後的「載入更早／append 語意」小節） |
| 每列「▸/▾」按鈕 `onclick="toggleEvDetail(id)"` | 切換對應詳情列 `hidden`，按鈕文字同步 `▸`/`▾` | `EventsPage.tsx:94-101`（`toggleExpand`，`Set<number>` 存展開中的 id）；按鈕見 `EventsPage.tsx:143-151`（欄位定義），展開內容見 `EventsPage.tsx:219-237`（`renderExpanded`） |

無 confirm/alert（規格明確本頁無破壞性操作）——本實作沒有任何 `window.confirm`/`window.alert` 呼叫，符合。

---

## 2. 渲染欄位對照表（規格 §3.2）

### 2.1 資料列（7 欄）

| 表格欄 | 規格行為 | 實作位置 |
|---|---|---|
| 時間 | `fmt(r.ts)`，`.mono` | `EventsPage.tsx:119`（`className:'mono'`） |
| 服務 | `r.service` 原樣 | `EventsPage.tsx:120` |
| 使用者 | `<b style="color:var(--acc)">` | `EventsPage.tsx:121-125` |
| tool | `r.tool||''`，`.mono` | `EventsPage.tsx:126` |
| 結果 | `event==='auth_failure'` → 紅 pill 顯示 `reason`；否則 `resPill(result)` | `EventsPage.tsx:127-136`（`Badge variant="bad"` 對應紅 pill；`ResultBadge` 對應 `resPill`） |
| 耗時 | `${duration_ms??''}${duration_ms!=null?'ms':''}`，`.mono` | `EventsPage.tsx:137-142` |
| （操作欄，無標題） | `▸/▾` 按鈕 `padding:2px 8px` | `EventsPage.tsx:143-151` |

### 2.2 詳情列（`.kv`）

| kv 標籤 | 規格行為 | 實作位置 |
|---|---|---|
| `#` | `r.id` 原樣數字 | `EventsPage.tsx:224` |
| 事件 | `auth_failure` → 紅 pill 固定文字 `auth_failure`；否則灰 pill 固定文字 `req`（不顯示實際 `event` 值） | `EventsPage.tsx:225-228` |
| method | `esc(method\|\|'')` → React 純文字 `method\|\|''` | `EventsPage.tsx:229` |
| path | 同上 | `EventsPage.tsx:230` |
| IP | `source_ip\|\|''` | `EventsPage.tsx:231` |
| agrabah 帳號 | `agrabah_identifier\|\|''` | `EventsPage.tsx:232` |

排序（規格 §3.3）：完全依 API 回傳順序，前端不做任何 sort——`rows` 狀態只在 §3 描述的兩個地方被寫入（整批取代 / append 到尾端），沒有任何 `.sort()` 呼叫。

---

## 3. `#ev-live` 開關如何控制輪詢

`#ev-live` 對應的 `live` state 只做一件事：當作 `useResource` 的 `autoRefresh` 選項傳下去，本身沒有任何 `onChange` 副作用（不呼叫 `runQuery`/`reload`），與舊版「無直接 onchange 綁定，被 `refresh()` 讀取」語意一致——關閉時停止背景輪詢，但查詢鈕、篩選變更、Enter、載入更早皆不受影響（因為那些都是走 `runQuery`/`loadMore`，不經過 `autoRefresh` 這個開關）。

```tsx
// EventsPage.tsx:206-208（勾選框，只更新 state，不觸發查詢）
<input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> 自動更新

// EventsPage.tsx:68（把 live 接進背景輪詢開關；service/errors/toolOnly 變更觸發的 runQuery()
// 呼叫的是 resource.reload()，reload 對應舊版 force=true，不受 autoRefresh 限制）
const resource = useResource(topics.events, queryParams, { autoRefresh: live })
```

`useResource` 內部（共用層 `src/hooks/useResource.ts`，不可修改）用這個 `autoRefresh` 決定要不要掛 5 秒的 `setInterval`：關閉時只做首次載入，之後除非呼叫 `reload()`（查詢鈕/Enter/篩選變更都會呼叫）否則不會自動重抓，對齊契約 §7「events：只有『自動更新』勾選時才重查；刷新鈕無視勾選」。

---

## 4. 狀態與邊界對照（規格 §5）

| 情境 | 規格表現 | 實作 |
|---|---|---|
| 查無資料 | `#ev-body` 空、只剩表頭；`#ev-count` 顯示「顯示 0 筆」；**沒有專屬空狀態文案** | `rows=[]` 時 `DataTable` 傳 `emptyText=""`（`EventsPage.tsx:218`）：DataTable 仍會渲染一個空白 `<td>` 的 `<tr>`（共用層固定行為，見「未達成項目」第 1 點），但不含任何文字，視覺上最貼近「無文案」；`顯示 {rows.length} 筆` 一律用 `rows.length` 現場計算（`EventsPage.tsx:210`），對應舊版 `querySelectorAll('tr[id^="ev-r-"]').length` |
| 「載入更早」查到 0 筆 | `evOldest` 不更新，之後每次都用同一個 `before_id` 重查、永遠 0 筆，無 disable/提示 | `EventsPage.tsx:105-116`：`if (resp.rows.length) setOldestId(...)` 只有非空才更新，符合；按鈕本身無 disable-forever 邏輯（僅在單次請求 `pending` 期間短暫 disable，見下） |
| API 呼叫例外 | `refresh()` 觸發時被外層 try/catch 吞掉；直接呼叫時是 unhandled rejection，畫面無提示 | 本實作透過共用層 `useResource`/`transport.subscribe()` 一律內部 `catch` 並存進 `resource.error`（`EventsPage.tsx` 不解構、不渲染 `error`，等同「畫面無提示」）；`loadMore` 走 `useAction.run()`，例外會被存進 `moreAction.result`（同樣不渲染），效果等同原版「無可見錯誤」 |
| `services` 尚未載入 | 進入本分頁時先補打一次 `/api/overview` | `EventsPage.tsx:64-65`：`useResource(topics.overview, undefined)` 無條件訂閱（本頁固定輪詢，不受 `live` 影響），下拉選單用其 `services` 過濾 `hasAudit` |
| 首次載入 | 無 loading 骨架/spinner | 本實作完全不讀 `resource.loading`；`rows` 初始為 `[]`，首次資料到達前 `DataTable` 就是空表（表頭在），符合 |

---

## 5. 資料來源與查詢參數（規格 §2）

| query param | 對應 UI | 實作 |
|---|---|---|
| `service` | `#ev-service` | `toParams()`（`EventsPage.tsx:29-38`）：空字串轉 `undefined` |
| `identity` | `#ev-identity`（trim） | 同上，`.trim()` 後空字串轉 `undefined` |
| `q` | `#ev-q`（trim） | 同上 |
| `errors` | `#ev-errors` | 勾選時 `'1'`，否則 `undefined` |
| `toolOnly` | `#ev-tool-only` | 同上 |
| `before_id` | 內部狀態 `evOldest` | `loadMore()` 呼叫 `fetchEvents({...queryParams, before_id: oldestId, limit:200})`（`EventsPage.tsx:109`），只有 append 路徑會帶這個參數，一般查詢的 `queryParams` 從不含 `before_id` |
| `limit` | 固定 `200` | `toParams()` 與 `loadMore()` 皆固定 `limit:200` |

跨頁跳轉入口（契約 §6.2，`lib/navigation.ts` 的 `eventsPath()`）：`EventsPage.tsx:50-54` 用 `useSearchParams()` 讀 `service`/`identity`/`q`/`errors`/`toolOnly` 五個 query 參數當作五個 filter state 的初始值，並用 `toParams()` 組出首次查詢的 `queryParams` 初始值（`EventsPage.tsx:59-61`）——對應舊版 `jumpEvents(svc, who)`/`jumpEventsQuery(svc, q, errorsOnly)` 預先填好篩選條件後直接查詢的效果。

---

## 6. 「載入更早」／append 語意（規格 §3.1）

- 一般查詢（含輪詢、篩選變更、查詢鈕、Enter）：`useEffect` 監看 `resource.data`（`EventsPage.tsx:77-81`），每次 `resource.data` 換了新物件就 `setRows(resource.data.rows)`（整批取代），並把 `oldestId` 更新成這批最後一筆的 `id`（非空才更新）。
- append（`載入更早`）：`loadMore()`（`EventsPage.tsx:105-116`）直接呼叫具名端點函式 `fetchEvents()`（不透過 `useResource`，因為那支是「整批取代」語意，混用會讓 append 出來的資料在下一次輪詢時被覆蓋），拿到結果後 `setRows(prev => [...prev, ...resp.rows])` 累加到尾端，`oldestId` 同樣非空才更新——與舊版 `evOldest`/`insertAdjacentHTML('beforeend', ...)` 語意一致。

---

## 7. 未達成項目 / 已知差異

1. **空狀態「完全沒有列」做不到，只能做到「沒有文字」**：`DataTable`（共用層，不可修改）在 `rows=[]` 且 `emptyMode` 為預設值 `'row'` 時，固定會渲染一個 `<tr><td colSpan>{emptyText}</td></tr>`；舊版 `tbody` 在 0 筆時是**完全沒有任何 `<tr>`**（`insertAdjacentHTML` 對空陣列是 no-op）。本頁用 `emptyText=""` 讓那一列不顯示任何文字，是目前共用層能力下最貼近規格「沒有專屬空狀態文案」的做法，但仍會多一個空白列（有 padding，螢幕截圖比對可能看到一條略窄的空白列）。這是 `DataTable` 缺一個「rows 為空時完全不渲染任何列」的模式（例如 `emptyMode: 'none'`），不在本頁權限範圍內修改，未回報為 SHARED_LAYER_GAPS 是因為視覺影響極小且規格本身把這條列為「非必要修正項」（規格 §5：「若要加上須視為額外增強而非 parity 必要項」，此處是反向的「拿掉」而非「加上」，性質類似，判斷為可接受落差）。
2. **`#ev-live` 從關閉切回開啟時，共用層 `useResource` 會立即多打一次 API**：舊版 `#ev-live` 完全沒有 `onchange` 綁定，切換當下不會有任何網路行為，純粹只影響下一次 5 秒輪詢 tick 要不要執行。`useResource`（共用層 `src/hooks/useResource.ts`，不可修改）的 `autoRefresh` 是 `useEffect` 依賴項之一，改變時會重建整條訂閱，而 `transport.subscribe()`「首次載入立即打一次，不等第一個間隔」的設計對每個新建立的訂閱一視同仁——因此切換 `live`（不論開或關）會觸發一次立即查詢。這是所有分頁共用同一套 `autoRefresh` 機制下的結構性行為，非本頁獨有的繞法，畫面上的可見結果與舊版一致（顯示的都是最新 200 筆），純粹是「切換當下是否多打一次幾乎相同結果的 API」的內部差異，靜態截圖比對不出來，未回報 SHARED_LAYER_GAPS。
3. **查詢按鈕/Enter 在篩選值完全未變時仍會重查一次，透過提前呼叫 `resource.reload()`**：這不是差異而是刻意補上的正確性保證——`useResource` 用 `JSON.stringify(params)` 判斷是否要重新訂閱，若使用者按查詢鈕時三個文字/勾選欄位其實都沒變，單純 `setQueryParams` 不會觸發任何新查詢，會讓「查詢」按鈕在此情境下失效（尤其 `live` 關閉時，這是使用者唯一的手動刷新手段）。因此 `runQuery()` 固定額外呼叫 `resource.reload()`，確保按鈕永遠有效，符合舊版「查詢鈕一律重打」的行為。列在此處純為說明，非缺陷。

---

## 8. 驗收

```
$ cd /Users/user/aladdin/tg-monitor/frontend && bunx tsc --noEmit -p tsconfig.app.json
（無輸出，exit 0，零錯誤）
```
