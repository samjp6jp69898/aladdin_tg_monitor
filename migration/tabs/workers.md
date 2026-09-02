> ⚠️ 行號基準：本文件引用的 **server.ts 行號是舊快照，已不可直接使用**——後續多次改動讓漂移
> 變成非均勻的 53~91 行，先前「一律 +15」的指示已作廢。要查 server.ts 現行位置請以
> `migration/00-api-inventory.md`（行號已依現行檔案重新生成）為準。
> **index.html 的行號則是準確的歷史記錄**；該檔已於 2026-09-02 經使用者核准刪除，
> 需要對照原檔時：`git show 624ae25:public/index.html`。

# Workers（`#tab-workers`）

多機派工（T37 head/worker cluster）的 worker 名冊管理頁。兩層畫面（列表 / 單台詳情），列表每列 4 個操作按鈕（詳情 / 中斷或恢復 / 重連 / 移除），詳情頁另有「查任一票在這台的即時狀態」小工具。

## 1. 畫面結構

```
section#tab-workers (hidden 由 showTab 控制)           (L215-236)
├── div.bar                                             (L216)
│   ├── button#wk-reload.btn "重新整理"
│   └── span.mute#wk-secret-note  （CLUSTER_SHARED_SECRET 未設定時的提示，見 §5）
├── div#wk-list-view                                     (L217-221，列表視圖，預設顯示)
│   └── div.card
│       ├── h3 "已註冊 Worker（<span#wk-n>0</span>）"
│       ├── div.scroll#wk-table  （表格由 JS 填入，見 §3）
│       └── div.mute （固定說明文字，見下方「固定文案」）
└── div#wk-detail[hidden]                                (L222-235，單台詳情視圖)
    ├── div.bar                                          (L223)
    │   ├── button.btn onclick=closeWorkerDetail() "← 返回列表"
    │   ├── span#wkd-title  （worker name）
    │   └── span#wkd-sub.mute  （url（登記於 ...））
    ├── div.two                                          (L224-227)
    │   ├── div.card "GET /health" > pre.log#wkd-health
    │   └── div.card "GET /capacity" > pre.log#wkd-capacity
    ├── div.card "目前指派在這台的票"                     (L228)
    │   └── div.scroll#wkd-tickets
    └── div.card "查詢任一票在這台的 GET /jobs/:ticket"   (L229-234)
        ├── div.bar
        │   ├── input#wkd-ticket-input placeholder="FAQ-1234 或 ALDREQ-1234"
        │   └── button#wkd-ticket-query.btn "查詢"
        ├── div#wkd-ticket-summary.mute
        ├── div.scroll#wkd-ticket-stages
        └── details "原始回應" > pre.log#wkd-ticket-result
```

**固定文案**（L219，`#wk-list-view` 內）：「名冊來源：telegram-dispatcher/logs/cluster-workers.json（worker-agent 啟動時登記，其後每 30 分鐘冪等重送）。名冊只是「去哪裡問」的地址簿，不保證活著——狀態欄是即時探測 /health 的結果。「中斷」只是讓 head 停止把新工作派給它，不影響已經在跑的工作；「移除」如果該機 worker-agent 行程還在跑，30 分鐘內會自動重新登記回來，要真正退役請同時在該機停掉 worker-agent。」

## 2. 資料來源

- `GET /api/cluster/workers`（`loadWorkers()` L657-672）→ `{ secretConfigured, workers[] }`
  - server 端對每個已登記 worker **即時**打 `/health`（探測是否線上）與（`secretConfigured` 時才）`/capacity`（探測名額），非快取；`workers[]` 每筆含 `name`、`url`、`online`、`health`、`capacity`（`{bug:{running,limit,queued},demand:{...}}`）、`disabled`、`registeredAt`、`tickets`（目前派在這台的票，來自 dispatch-registry）。
- 呼叫時機：切到本分頁、5 秒輪詢（`tab==='workers'` 時若 `curWorkerName` 有值改呼叫 `loadWorkerDetail()`，否則 `loadWorkers()`，L835）、`#wk-reload` 按鈕、中斷/恢復/移除操作後（見 §4，每個操作結束都呼叫 `loadWorkers()`）、`重連` 按鈕（見 §4）。
- 詳情頁：`GET /api/cluster/worker?name=<name>`（`loadWorkerDetail()` L705-714）→ `{ worker, online, health, capacity, tickets, ticketStatus }`（`ticketStatus` 只在同時帶 `?ticket=` 查詢參數時才有值）。切到詳情頁或輪詢時都重打此 API（不帶 `ticket` 參數，除非正在查票）。
- 查票工具：`GET /api/cluster/worker?name=<curWorkerName>&ticket=<ticket>`（`queryWorkerTicket()` L715-727），只在使用者按下「查詢」時觸發一次，**不隨輪詢自動重查**。
- 寫入操作：`POST /api/cluster/worker/disable|enable|remove` body `{name}`（`callWorkerAction()` L675-678 共用 fetch 邏輯）。
- 重連：`GET /api/cluster/worker?name=<name>`（與詳情頁載入同一支 API，無獨立端點——「重連」語意上就是「立即重新探測」）。

## 3. 渲染邏輯

### 列表頁 `#wk-table`（L661-671）
表格欄位：`名稱`、`URL`、`狀態`、`Bug 名額`、`Demand 名額`、`登記時間`、`操作`。
- `名稱`：`<b style="color:var(--acc)">`（強調色）。
- `URL`：等寬字體。
- `狀態`：`<span class="dot {up|down}">` 圓點（CSS：`up`綠色發光、`down`紅色發光）+ `<span class="pill {ok|bad}">UP|DOWN</span>`；`disabled===true` 再附加一個橘色 `pill warn` "已停用"。
- `Bug 名額` / `Demand 名額`：`slot()` 函式（L664）——有資料 `${running}/${limit}` + 有排隊才附加 `(+${queued} 排隊)`；無資料（`capacity` 為 null，通常是 secret 未設定或探測失敗）顯示 `-`。
- `登記時間`：`fmt(registeredAt)`。
- `操作`：固定 4 個按鈕，見 §4。
- 空資料：`<div class="mute">尚無已註冊的 worker（worker 機啟動 worker-agent.ts 後會自動登記，其後每 30 分鐘冪等重送）</div>`。
- `#wk-n`：`d.workers.length`。
- 無自訂排序，依 API 回傳順序。

### 詳情頁
- `#wkd-title`：`worker.name`；`#wkd-sub`：`${url}（登記於 ${fmt(registeredAt)}）`。
- `#wkd-health` / `#wkd-capacity`：`JSON.stringify(health|capacity, null, 2)` 原樣輸出（等寬 `pre.log`）；探測失敗 → `（連不上 /health，worker 可能離線）` / `（連不上 /capacity，或 CLUSTER_SHARED_SECRET 未設定）`。
- `#wkd-tickets`：表格（票號｜種類｜狀態｜派工時間｜觸發人），無資料 → `<div class="mute">目前沒有票派在這台</div>`。
- **查票結果**（`queryWorkerTicket()` L715-727）：
  - `#wkd-ticket-result`：`ticketStatus` 有值 → `JSON.stringify(ticketStatus,null,2)`；無值 → `（查詢失敗：worker 連不上，或票號格式不對，或 CLUSTER_SHARED_SECRET 未設定）`。
  - 若拿不到 `st`（`ticketStatus.status`）：`#wkd-ticket-summary` 清空、`#wkd-ticket-stages` 清空，函式提前結束。
  - `#wkd-ticket-summary`：`鎖：{locked?'<pill ok>locked':'<pill>未鎖'}　佇列狀態：{queueState?'<pill warn>'+queueState:'<mute>-'}`。
  - `#wkd-ticket-stages`：`st.stages[]` 有值 → 表格（階段｜狀態｜時間），`current===true` 該列加 `class="stage-running"`，狀態欄 `done && current` → `pill warn` "進行中"；`done && !current` → `pill ok` "done"；`!done` → `pill` "pending"；`stages` 為空 → `locked` 為真顯示「已鎖但查無 stage 產物（可能剛起步）」，否則「未鎖：本機無此單活動」。

## 4. 互動功能（⚠️ 本頁重點：worker 管理三按鈕，7 個互動點）

1. **重新整理 `#wk-reload`**（L216，JS L673）：`onclick = loadWorkers`。無 confirm。

2. **每列「詳情」按鈕**（`onclick="openWorkerDetail(w.name)"`，JS L703）：`curWorkerName=name`，切到 `#wk-detail`，呼叫 `loadWorkerDetail()`。無 confirm。

3. **⚠️ 每列「中斷／恢復」按鈕**（動態文字與 class，L667：`disabled?'':'warn'` 決定按鈕樣式、`disabled?'enableWorkerRow':'disableWorkerRow'` 決定呼叫哪個函式、按鈕文字 `disabled?'恢復':'中斷'`）：
   - **中斷**（`disableWorkerRow()` L679-684，對應目前未停用的 worker）：
     - `confirm("確定要中斷 worker「${name}」嗎？\n\nhead 之後不會再把新工作派給它，但目前已經在它身上跑的工作不受影響（不會被砍掉）。")`
     - `POST /api/cluster/worker/disable` body `{name}`。
     - 失敗才 `alert("中斷失敗：${reason}")`；成功無提示。
     - **一律** `loadWorkers()`（成功或失敗都重新整理列表）。
   - **恢復**（`enableWorkerRow()` L685-689，對應目前已停用的 worker）：
     - **無 confirm**，直接送 `POST /api/cluster/worker/enable` body `{name}`。
     - 失敗才 `alert("恢復失敗：${reason}")`；成功無提示。
     - 一律 `loadWorkers()`。

4. **⚠️ 每列「移除」按鈕**（`removeWorkerRow()` L690-695，`onclick="removeWorkerRow(w.name)"`）：
   - `confirm("確定要把 worker「${name}」從名冊移除嗎？\n\n注意：如果該機的 worker-agent 行程還在跑，它每 30 分鐘會自己重新登記回來（停用狀態也會重置）。要讓它真正退役，請同時在該機停掉 worker-agent（launchctl bootout）。")`
   - `POST /api/cluster/worker/remove` body `{name}`。
   - 失敗才 `alert("移除失敗：${reason}")`；成功無提示。
   - 一律 `loadWorkers()`。

5. **每列「重連」按鈕**（`reconnectWorkerRow()` L696-702，`onclick="reconnectWorkerRow(w.name)"`）：
   - 無 confirm。**不打寫入 API**，只是 `GET /api/cluster/worker?name=<name>`（本來就是即時 live probe，沒有快取層可繞，見程式碼註解）觸發一次立即重新探測該台的 `/health`/`/capacity`，探測完 `await loadWorkers()` 刷新整個表格。
   - 無成功/失敗 alert（探測結果直接反映在表格的狀態欄）。

6. **詳情頁「← 返回列表」**（L223 `onclick="closeWorkerDetail()"`，JS L704）：`curWorkerName=null`，切回列表並 `loadWorkers()`。

7. **詳情頁「查詢」`#wkd-ticket-query`**（L230，JS L728 `queryWorkerTicket`）：讀 `#wkd-ticket-input`（trim），空值或無 `curWorkerName` 直接 return（不打 API、無提示）；否則 `GET /api/cluster/worker?name=<curWorkerName>&ticket=<ticket>`，渲染結果見 §3。無 confirm，無成功/失敗 alert（結果直接顯示在頁面上，含失敗時的說明文字）。

**跨頁跳轉入口（非本頁按鈕，但會操作本頁狀態，供 parity 測試留意）**：Pipelines 分頁「遠端執行中」列的 Worker 連結會呼叫 `openWorkerTicket(name, ticket)`（JS L729，定義在本頁 JS 區塊）：`curWorkerName=name`，`showTab('workers')`，展開該 worker 詳情，並自動把 `#wkd-ticket-input` 填入該票號後立即呼叫 `queryWorkerTicket()`。

## 5. 狀態與邊界

- **`CLUSTER_SHARED_SECRET` 未設定**：`#wk-secret-note` 顯示「（CLUSTER_SHARED_SECRET 未設定或格式不對：無法探測名額/票務，僅顯示名冊）」；此時名額欄一律顯示 `-`，中斷/恢復/移除三個動作會在後端 `handleWorkerAction` 直接回 409「CLUSTER_SHARED_SECRET 未設定，cluster 機制停用」（`alert` 呈現）。
- **載入中**：無 loading 骨架。
- **空資料**：見 §3「尚無已註冊的 worker...」文案。
- **worker 離線**：`online:false` → 狀態欄紅色 `DOWN`；詳情頁 `/health`、`/capacity` 顯示「連不上」提示文字而非空白或報錯畫面崩潰。
- **查票格式錯誤 / worker 連不上**：`#wkd-ticket-result` 顯示統一的「查詢失敗：worker 連不上，或票號格式不對，或 CLUSTER_SHARED_SECRET 未設定」（後端 `ticket` 需符合 `^(FAQ|ALDREQ)-\d+$` 才會真的去查，否則 `ticketStatus` 為 `null`，前端無法區分是格式錯誤還是連線失敗——三種情況共用同一句文案）。
- **head 名冊找不到該 worker**（例如另一分頁剛把它移除）：`GET /api/cluster/worker` 404，`$('#wkd-title').textContent=curWorkerName`（沿用原名稱），`$('#wkd-sub').textContent=d.error`，其餘欄位不繼續渲染。
- **寫入操作的錯誤呈現**：一律 `alert("...失敗：${reason}")`；成功一律靜默（無 alert），只靠列表刷新反映結果。

## 6. 原始碼行號對照

| 區塊 | HTML | JS render | JS event handler |
|---|---|---|---|
| section 容器 / bar | L215-216 | — | `#wk-reload` L673 |
| 列表 table | L217-220 | `loadWorkers()` L657-672 | `openWorkerDetail()` L703，`disableWorkerRow()` L679-684，`enableWorkerRow()` L685-689，`reconnectWorkerRow()` L696-702，`removeWorkerRow()` L690-695 |
| 詳情頁 bar / health / capacity | L222-227 | `loadWorkerDetail()` L705-714 | `closeWorkerDetail()` L704 |
| 指派票列表 | L228 | `loadWorkerDetail()` L713 | — |
| 查票工具 | L229-234 | `queryWorkerTicket()` L720-726 | `$('#wkd-ticket-query').onclick` L728 |
| 跨頁跳轉 | — | — | `openWorkerTicket()` L729（被 pipelines.md 的遠端列呼叫） |
| refresh 輪詢整合 | — | — | `refresh()` L835：`tab==='workers'` 分支 |

---

**本頁互動點：7 個，grep onclick 命中 7**（HTML 靜態區段 `sed -n '215,236p'` 命中 `onclick=` 1 次：「← 返回列表」；JS 區段 `sed -n '655,729p'` 命中 `onclick=`/`.onclick =` 6 次：詳情/中斷或恢復/重連/移除 4 個按鈕模板 + `#wk-reload` 賦值 + `#wkd-ticket-query` 賦值）。
