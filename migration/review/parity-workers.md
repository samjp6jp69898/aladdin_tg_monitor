# Workers 分頁 parity 對照表

實作檔案：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/WorkersPage.tsx`（路由入口，只負責讀 query 參數、頂部工具列、列表/詳情切換）
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/workers/WorkersList.tsx`（列表視圖 `#wk-list-view`）
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/workers/WorkerDetail.tsx`（單台詳情視圖 `#wk-detail`）

規格依據：`/Users/user/aladdin/tg-monitor/migration/tabs/workers.md`（下稱「規格」）。

---

## 1. 互動功能對照（規格 §4，共 7 個互動點）

| 規格項次 | 內容 | 實作位置 |
|---|---|---|
| §4-1 `#wk-reload` 重新整理 | 無 confirm，`onclick = loadWorkers` | `WorkersPage.tsx:34`（`<Button onClick={() => list.reload()}>重新整理</Button>`）。此按鈕在列表與詳情兩個視圖下都可見（因為放在 `WorkersPage.tsx` 頁面層、不在任一子視圖裡），與舊版「按鈕在 `.bar` 裡、位於 `#wk-list-view`/`#wk-detail` 外層」的 DOM 結構一致 |
| §4-2 每列「詳情」按鈕 | `onclick="openWorkerDetail(w.name)"`，無 confirm，切到詳情視圖 | `WorkersList.tsx:93`（`<Button onClick={() => navigate(workersPath(w.name))}>詳情</Button>`），用 `lib/navigation.ts` 的 `workersPath(name)` 把 `?name=` 放進網址，符合契約 §6.2「列表/詳情頁一律用 query 參數」 |
| §4-3 每列「中斷／恢復」按鈕 | 中斷：confirm 文案逐字 + POST disable + 失敗才 alert + 一律 reload；恢復：無 confirm + POST enable + 失敗才 alert + 一律 reload | 按鈕渲染：`WorkersList.tsx:94-100`（`variant={w.disabled?'default':'warn'}`、文字 `w.disabled?'恢復':'中斷'`）。行為：`WorkersList.tsx:31-42`（`handleDisable`/`handleEnable`，見下方「三個管理操作」專節） |
| §4-4 每列「移除」按鈕 | confirm 文案逐字 + POST remove + 失敗才 alert + 一律 reload | 按鈕：`WorkersList.tsx:104-106`。行為：`WorkersList.tsx:44-50`（`handleRemove`，見下方專節） |
| §4-5 每列「重連」按鈕 | 無 confirm，不打寫入 API，只是 `GET /api/cluster/worker?name=` 觸發一次即時重探測，探測完 `loadWorkers()`；無成功/失敗 alert | `WorkersList.tsx:55-65`（`handleReconnect`：呼叫具名端點函式 `fetchWorkerDetail(name)`（不帶 ticket），成功則 `resource.reload()`；`catch{}` 靜默吞掉例外且不刷新列表，逐字對應舊版 `await api(...); await loadWorkers()` 未捕捉例外時後面那行不會執行的行為） |
| §4-6 詳情頁「← 返回列表」 | `curWorkerName=null`，切回列表並 `loadWorkers()` | `WorkerDetail.tsx:115`（`<Button onClick={() => navigate(workersPath())}>← 返回列表</Button>`，導回無 `name` 參數的網址）。回到列表視圖後 `WorkersPage.tsx:29` 的 `useResource(..., {enabled:!name})` 的 `enabled` 從 false 變 true，effect 立即打一次 `/api/cluster/workers`，等同舊版 `closeWorkerDetail()` 裡的 `loadWorkers()` |
| §4-7 詳情頁「查詢」`#wkd-ticket-query` | 讀輸入框 trim；空值或無 worker 直接 return（不打 API、無提示）；否則 `GET /api/cluster/worker?name=&ticket=`；無 confirm、無成功/失敗 alert，結果直接顯示在頁面上 | `WorkerDetail.tsx:44-49`（`runTicketQuery`：空字串或無 `name` 時直接 `return`，不呼叫 `ticketAction.run`）。按鈕：`WorkerDetail.tsx:164-166` |
| 跨頁跳轉入口 `openWorkerTicket(name, ticket)` | Pipelines「遠端執行中」列的 Worker 連結：切到 workers、展開該 worker 詳情、自動填入票號並立即查詢 | `WorkerDetail.tsx:36,40,51-56`：`WorkersPage.tsx` 從 `useSearchParams()` 讀 `name`/`ticket`（`WorkersPage.tsx:23-24`）傳給 `WorkerDetail`；`WorkerDetail` 用 `initialTicket` 初始化輸入框（`useState(initialTicket ?? '')`），並在 `useEffect(() => { if (initialTicket) void runTicketQuery(initialTicket) }, [])` 掛載時自動查一次。對應舊版 `openWorkerTicket()` 的 `curWorkerName=name; showTab('workers'); ...; $('#wkd-ticket-input').value=ticket; await queryWorkerTicket()`。**跳轉來源端**（Pipelines 分頁組 `workersPath(name, ticket)` 網址）不在本頁範圍，屬 Pipelines agent 負責 |

**互動點計數**：規格宣告 7 個（§4-1～§4-7），加上跨頁跳轉入口共 8 條互動路徑，全部對照到實作位置，無遺漏。

---

## 2. 渲染欄位對照表（規格 §3）

### 2.1 列表頁 `#wk-table`（規格 §3「列表頁」）

| 欄位 | 規格行為 | 實作位置 |
|---|---|---|
| 名稱 | `<b style="color:var(--acc)">` | `WorkersList.tsx:68` |
| URL | 等寬字體 | `WorkersList.tsx:69`（`className:'mono'`） |
| 狀態 | dot(up/down) + pill(ok/bad) UP/DOWN + `disabled` 時附加橘色 warn pill「已停用」 | `WorkersList.tsx:70-84`（`StatusDot` + `Badge`） |
| Bug 名額 / Demand 名額 | `slot()`：有資料 `running/limit`（+排隊）；無資料 `-` | `WorkersList.tsx:16-20`（`slot()` 分頁專屬函式，未放共用層）、`85-86` |
| 登記時間 | `fmt(registeredAt)` | `WorkersList.tsx:87` |
| 操作 | 固定 4 個按鈕（詳情/中斷或恢復/重連/移除） | `WorkersList.tsx:88-110` |
| 標題「已註冊 Worker（N）」 | `d.workers.length` | `WorkersList.tsx:114` |
| 空資料文案 | 「尚無已註冊的 worker（worker 機啟動 worker-agent.ts 後會自動登記，其後每 30 分鐘冪等重送）」 | `WorkersList.tsx:120`（`emptyMode="replace"`） |
| 固定說明文字（`#wk-list-view` 內） | 名冊來源...段落，逐字照抄 | `WorkersList.tsx:124-129` |
| `#wk-secret-note` | `secretConfigured===false` 時顯示提示文字 | `WorkersPage.tsx:35-39`（放在頁面層，因為 DOM 結構上它跟 `#wk-reload` 同層，不屬於任一視圖） |

### 2.2 詳情頁（規格 §3「詳情頁」）

| 欄位 | 規格行為 | 實作位置 |
|---|---|---|
| `#wkd-title` | `worker.name`；404 時沿用 `curWorkerName` | `WorkerDetail.tsx:65` |
| `#wkd-sub` | `${url}（登記於 ${fmt(registeredAt)}）`；404 時是 `d.error` | `WorkerDetail.tsx:66-70` |
| `#wkd-health` | `JSON.stringify(health,null,2)`；`null` → 「（連不上 /health，worker 可能離線）」 | `WorkerDetail.tsx:125` |
| `#wkd-capacity` | 同上，錯誤文案「（連不上 /capacity，或 CLUSTER_SHARED_SECRET 未設定）」 | `WorkerDetail.tsx:130-136` |
| `#wkd-tickets` | 表格：票號/種類/狀態/派工時間/觸發人；空 → 「目前沒有票派在這台」 | `WorkerDetail.tsx:85-91,142-150`（`emptyMode="replace"`） |
| `#wkd-ticket-result` | `ticketStatus` JSON 或統一失敗文案 | `WorkerDetail.tsx:79-83,188` |
| `#wkd-ticket-summary` | 鎖 pill + 佇列狀態 pill/`-`；`st` 拿不到時清空 | `WorkerDetail.tsx:168-175` |
| `#wkd-ticket-stages` | 階段/狀態(pending/進行中/done)/時間 表格；`current` 列加 `stage-running`；空狀態依 `locked` 二選一文案 | `WorkerDetail.tsx:93-110,176-185` |

---

## 3. 狀態與邊界對照（規格 §5）

| 情境 | 規格表現 | 實作位置 |
|---|---|---|
| `CLUSTER_SHARED_SECRET` 未設定 | 名冊上方提示；名額欄一律 `-`；三個寫入動作後端回 409，前端 alert 呈現 | 提示：`WorkersPage.tsx:35-39`。名額 `-`：`slot()` 對 `capacity` 為 `null` 的處理（`WorkersList.tsx:17-18`）。409 呈現：走 `postResult` → `useAction` 的一般失敗分支（見 §4「三個管理操作」節），與其他失敗原因（head 連不上等）走同一條 alert 路徑，未特殊分流，符合規格「後端直接回 409」「`alert` 呈現」的字面要求 |
| 載入中 | 無 loading 骨架 | 未加任何 loading 佔位；`WorkersList.tsx:115`／`WorkerDetail.tsx:120` 都是「`data` 到手前對應區塊不渲染」，等同舊版「JS 還沒填內容前那塊 DOM 是空的」 |
| 空資料 | 見 §3 文案 | 同上 2.1 |
| worker 離線 | `online:false` → 紅 DOWN；詳情頁健康/名額顯示連不上提示而非崩潰 | `WorkersList.tsx:73-83`；`WorkerDetail.tsx:125,130-136` |
| 查票格式錯誤／worker 連不上 | 三種情況共用同一句「查詢失敗...」文案，前端無法/不需區分 | `WorkerDetail.tsx:79-83`（`ticketStatus` 為 falsy 時統一走 fallback 文案，不論成因） |
| head 名冊找不到該 worker（404） | `title`＝沿用原名稱、`sub`＝`d.error`，其餘欄位不繼續渲染 | `WorkerDetail.tsx:58-70`（`detail.error instanceof ApiError` 時取 `body.error` 當 `sub`；`title` 用 prop `name`）＋`WorkerDetail.tsx:120`（`{detail.data && (...)}` 包住健康/名額/票務區塊，`data` 為 `null` 時完全不渲染，等同舊版「函式提前 return，其餘 DOM 維持原狀」——首次進入 404 時原狀就是空白） |
| 寫入操作的錯誤呈現 | 一律 `alert("...失敗：${reason}")`；成功一律靜默 | 見下方專節 |

---

## 4. 三個管理操作：confirm 文案與失敗處理

三個按鈕共用同一個 `useAction()` 實例（`WorkersList.tsx:28`），走 `postResult`（`OkReason` 型別，`ok`/`reason` 慣例），`useAction` 內建的 `normalizeActionResult` 已把 `reason` 正規化進 `message`。

```tsx
// 中斷（WorkersList.tsx:31-37）
async function handleDisable(name: string) {
  const r = await action.run(() => postWorkerDisable(name), {
    confirm: `確定要中斷 worker「${name}」嗎？\n\nhead 之後不會再把新工作派給它，但目前已經在它身上跑的工作不受影響（不會被砍掉）。`,
    onSettled: resource.reload,
  })
  if (r && !r.ok) window.alert(`中斷失敗：${r.message}`)
}
```

```tsx
// 恢復（WorkersList.tsx:39-42，無 confirm）
async function handleEnable(name: string) {
  const r = await action.run(() => postWorkerEnable(name), { onSettled: resource.reload })
  if (r && !r.ok) window.alert(`恢復失敗：${r.message}`)
}
```

```tsx
// 移除（WorkersList.tsx:44-50，破壞性操作，confirm 文案逐字照抄含換行與括號說明）
async function handleRemove(name: string) {
  const r = await action.run(() => postWorkerRemove(name), {
    confirm: `確定要把 worker「${name}」從名冊移除嗎？\n\n注意：如果該機的 worker-agent 行程還在跑，它每 30 分鐘會自己重新登記回來（停用狀態也會重置）。要讓它真正退役，請同時在該機停掉 worker-agent（launchctl bootout）。`,
    onSettled: resource.reload,
  })
  if (r && !r.ok) window.alert(`移除失敗：${r.message}`)
}
```

- **confirm 取消**：`useAction.run()` 在 `confirm` 被拒時回傳 `null`（`hooks/useAction.ts:36`），`onSettled`（也就是 `resource.reload`）**不會**被呼叫，逐字對應舊版 `if (!confirm(...)) return`（連 `loadWorkers()` 都不會跑）。
- **一律 reload**：三個操作都把 `resource.reload` 傳進 `onSettled`，無論成功或失敗都會執行（`hooks/useAction.ts:46`），對應規格「一律 `loadWorkers()`」。
- **失敗才 alert，成功靜默**：三處都是 `if (r && !r.ok) window.alert(...)`，成功分支完全沒有任何提示，逐字對應規格「失敗才 alert(...)；成功無提示」。
- **移除的破壞性 confirm 流程**：本次實作**完全沒有呼叫**任何 `postWorkerDisable`/`postWorkerEnable`/`postWorkerRemove`（依硬邊界要求，未做任何真實 API 呼叫測試），只用 `bunx tsc --noEmit` 驗證型別與呼叫鏈正確；confirm 文案與 API body（`{name}`，由 `endpoints.ts` 內建）皆逐字核對規格 §4-3/§4-4 與 `00-api-inventory.md` 對應段落。

---

## 5. 未達成項目 / 刻意設計決策

1. **`LogViewer` 缺少 `maxHeight` prop（SHARED_LAYER_GAPS，已工作繞過）**：舊版三處 `pre.log`（`#wkd-health`、`#wkd-capacity`、`#wkd-ticket-result`）都是 `style="height:auto;max-height:30vh"`，共用元件 `LogViewer` 目前只支援單一 `height` 覆寫，無法表達「auto + max」的組合。依硬邊界「缺功能寫進 SHARED_LAYER_GAPS，不要自己改共用層」，本頁在 `WorkerDetail.tsx:17-29` 用一個頁面私有的 `LogPre` 小元件（沿用同一個全域 `.log` class，純 `<pre>` + inline style，非 `dangerouslySetInnerHTML`）達成與舊版一致的高度行為，不修改 `components/shared/LogViewer.tsx`。
2. **重連按鈕的錯誤語意**：舊版 `reconnectWorkerRow` 對 `api()` 拋出例外時是「未捕捉例外」，瀏覽器 console 會有 unhandled rejection，不影響其他功能。React 版用 `try/catch` 靜默吞掉（`WorkersList.tsx:55-65`），效果等價（都不提示使用者、都不刷新列表），但更安全（不會有真正的 unhandled rejection 噪音）——判斷這是可接受的行為對齊而非落差，因為使用者可觀察行為完全一致。
3. **`重新整理` 按鈕在詳情視圖下是「視覺存在但功能上呼叫的是列表 resource」**：由於 `topics.workers` 依契約 §7／§3.1 範例採 `enabled:!name` 模式（詳情視圖時停止訂閱），此時 `list.reload()` 實際上是對一個已停止訂閱的 resource 呼叫（內部 `subRef.current` 為 `null`，等同 no-op）。舊版是同一顆按鈕、同一個 `loadWorkers` handler，在任何視圖下點擊都會真的打一次 `/api/cluster/workers`（只是使用者在詳情視圖看不到效果，因為畫面不會重繪列表）。**畫面表現一致**（詳情視圖下點擊此按鈕使用者看不到任何變化，新舊版皆然），差別只在「舊版背地裡仍發了一次網路請求刷新列表快取，新版完全不發」，此差異對使用者不可觀察，且是契約 §3.1／§7 明定的列表/詳情資源分流模式的自然結果，不視為 parity 缺陷。
4. **查票的「同一票號重複按查詢」**：本實作用 `useAction().run()` 直接呼叫具名端點函式 `fetchWorkerDetail(name, ticket)`（而非透過 `useResource` 的 topic 訂閱機制），因為規格明確要求「不隨輪詢自動重查，只在按下查詢時觸發一次」，這與 `useResource` 以「params 序列化字串是否改變」判斷是否重新訂閱的設計語意不符（同一票號連續按兩次查詢，`useResource` 不會重新 fetch）。改用 `useAction` 後每次點擊都是一次獨立呼叫，行為與舊版 `queryWorkerTicket()` 每次點擊都重新 `api(...)` 完全一致。此為刻意的 hook 選型決策，非缺陷；`fetchWorkerDetail` 是 `api/endpoints.ts` 提供的具名端點函式，並非自行 `fetch()`，未違反契約硬規則。

無其他刻意跳過或做不到的項目。
