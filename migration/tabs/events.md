> ⚠️ 行號基準：本文件引用的 **server.ts 行號是舊快照，已不可直接使用**——後續多次改動讓漂移
> 變成非均勻的 53~91 行，先前「一律 +15」的指示已作廢。要查 server.ts 現行位置請以
> `migration/00-api-inventory.md`（行號已依現行檔案重新生成）為準。
> **index.html 的行號則是準確的歷史記錄**；該檔已於 2026-09-02 經使用者核准刪除，
> 需要對照原檔時：`git show 624ae25:public/index.html`。

# 分頁規格：即時序列（events）

route 值：`events`　section id：`tab-events`　HTML 行號：96–109　主要 render 函式：`loadEvents()`（第 346–352 行）+ `evRow()`（第 344–345 行）+ `evQuery()`（第 342 行）

---

## 1. 畫面結構

```
section#tab-events
├─ div.bar                                        ← 篩選列
│   ├─ select#ev-service                          ← 首個 option: "全部服務"（value=""），其餘由 fillServiceSelects() 動態填入
│   ├─ input#ev-identity          placeholder="identity（使用者）"
│   ├─ input#ev-q                 placeholder="搜尋 tool / path / result / IP"
│   ├─ label > input[type=checkbox]#ev-errors      "只看錯誤"
│   ├─ label > input[type=checkbox]#ev-tool-only   "只看有呼叫 tool（隱藏 initialize/list 等握手雜訊）"
│   ├─ label > input[type=checkbox]#ev-live  (checked)  "自動更新"
│   ├─ button#ev-reload            "查詢"
│   └─ span.mute#ev-count                          ← 動態文字："顯示 N 筆"
├─ div.scroll (style: max-height:80vh)
│   └─ table
│       ├─ thead > tr: th "時間" / "服務" / "使用者" / "tool" / "結果" / "耗時" / ""（操作欄，無標題文字）
│       └─ tbody#ev-body                            ← 動態列（每筆事件兩個 <tr>：資料列 + 隱藏的詳情列）
└─ div.bar (style: margin-top:8px)
    └─ button#ev-more   "載入更早"
```

---

## 2. 資料來源

| API | 方法 | 參數 | 呼叫時機 |
|---|---|---|---|
| `/api/events` | GET | 見下表 | 首次進入分頁（透過全域 `refresh()`）；每 5 秒全域輪詢（僅當 `#ev-live` 勾選，或 `force=true`）；點「查詢」按鈕；篩選條件（服務/只看錯誤/只看有呼叫 tool）變動時（`onchange`）；`identity`/`q` 輸入框按 Enter；點「載入更早」（`before` 模式，累加載入） |

`evQuery(before)`（第 342 行）組出查詢字串：
```js
function evQuery(before){
  const p=new URLSearchParams()
  const s=$('#ev-service').value, i=$('#ev-identity').value.trim(), q=$('#ev-q').value.trim()
  if(s)p.set('service',s)
  if(i)p.set('identity',i)
  if(q)p.set('q',q)
  if($('#ev-errors').checked)p.set('errors','1')
  if($('#ev-tool-only').checked)p.set('toolOnly','1')
  if(before)p.set('before_id',before)
  p.set('limit','200')
  return '/api/events?'+p
}
```

| query param | 對應 UI | 說明 |
|---|---|---|
| `service` | `#ev-service` 選中值 | 空字串（「全部服務」）時不帶此參數 |
| `identity` | `#ev-identity`（trim 後） | 空字串時不帶 |
| `q` | `#ev-q`（trim 後） | 空字串時不帶；後端對 `tool`/`path`/`result`/`source_ip`/`agrabah_identifier` 五欄做 `LIKE %q%` |
| `errors` | `#ev-errors` checkbox | 勾選時帶 `'1'`；後端條件 `(event='auth_failure' OR result LIKE 'error:%')` |
| `toolOnly` | `#ev-tool-only` checkbox | 勾選時帶 `'1'`；後端條件 `tool IS NOT NULL` |
| `before_id` | 內部狀態 `evOldest` | 只有「載入更早」（`append=true`）時才帶，值為目前畫面最後一筆事件的 `id`；後端條件 `id < before_id` |
| `limit` | 固定 `'200'` | 前端固定值，後端另外 `Math.min(limit, 1000)` 上限保護 |

後端 SQL（`server.ts` 第 118–147 行）：`ORDER BY id DESC LIMIT {limit}` —— 永遠是「最新在前」，`before_id` 機制搭配 DESC 排序即可實現「向舊資料翻頁」。回應：`{ rows: EventRow[], limit }`，其中 `EventRow = {id, service, ts, event, identity, source_ip, method, path, tool, result, agrabah_identifier, duration_ms, reason}`。

---

## 3. 渲染邏輯

### 3.1 `loadEvents(append)`（第 346–352 行）

```js
async function loadEvents(append){
  const d = await api(evQuery(append?evOldest:null))
  if (!append) $('#ev-body').innerHTML = ''
  $('#ev-body').insertAdjacentHTML('beforeend', d.rows.map(evRow).join(''))
  if (d.rows.length) evOldest = d.rows[d.rows.length-1].id
  $('#ev-count').textContent = `顯示 ${$('#ev-body').querySelectorAll('tr[id^="ev-r-"]').length} 筆`
}
```

- `append=false`（一般查詢/輪詢/篩選變更）：先清空 `#ev-body`，再插入新查到的列——**每次都是「取代」而非「合併」**，代表輪詢時畫面永遠只顯示最新一批 200 筆，不會無限累積。
- `append=true`（點「載入更早」）：不清空，直接把新查到的列 append 到表格尾端（`insertAdjacentHTML('beforeend', ...)`），配合 `before_id` 達成「向下翻頁載入更舊資料」的效果，畫面上資料會持續累加。
- `evOldest`（模組層級變數，第 341 行 `let evOldest = null`）在每次查詢後更新為本次結果最後一筆（即最舊一筆，因為是 DESC 排序）的 `id`，供下次「載入更早」使用。
- `#ev-count` 文案：`顯示 {N} 筆`，N 是**目前 DOM 中實際的資料列數**（用 `querySelectorAll('tr[id^="ev-r-"]')` 現場計算，而非用 API 回傳的 `rows.length` 直接顯示）——因為 `append` 模式下畫面列數會超過單次 API 回傳的 200 筆。

### 3.2 單筆事件的兩行渲染（`evRow`，第 344–345 行）

每筆事件產生兩個 `<tr>`：一個常駐顯示的資料列，一個預設 `hidden` 的詳情列（點「▸」展開）。

**資料列** `<tr id="ev-r-{id}">`：

| 表格欄 | 資料欄位 | 格式化方式 |
|---|---|---|
| 時間 | `r.ts` | `fmt(r.ts)`（`.mono`） |
| 服務 | `r.service` | `esc(r.service)` 原樣 |
| 使用者 | `r.identity` | `<b style="color:var(--acc)">{esc(identity||'')}</b>`（強調色） |
| tool | `r.tool` | `esc(tool||'')`（`.mono`） |
| 結果 | `r.event`、`r.result`、`r.reason` | 見 3.2.1（狀態徽章規則） |
| 耗時 | `r.duration_ms` | `{duration_ms??''}{duration_ms!=null?'ms':''}`（`.mono`）——無值時整格空白，不顯示 `ms` |
| （操作欄） | — | `<button class="btn" id="ev-t-{id}" style="padding:2px 8px" onclick="toggleEvDetail({id})">▸</button>` |

**詳情列** `<tr id="ev-d-{id}" hidden><td colspan="7">`，內含 `.kv` 區塊：

| kv 標籤 | 資料欄位 | 格式化方式 |
|---|---|---|
| `#` | `r.id` | 原樣數字 |
| 事件 | `r.event` | `event==='auth_failure'` → `<span class="pill bad">auth_failure</span>`；否則 → `<span class="pill">req</span>`（固定文字 `req`，不顯示實際 `event` 值） |
| method | `r.method` | `esc(method||'')` |
| path | `r.path` | `esc(path||'')` |
| IP | `r.source_ip` | `esc(source_ip||'')` |
| agrabah 帳號 | `r.agrabah_identifier` | `esc(agrabah_identifier||'')` |

### 3.2.1「結果」欄狀態徽章規則

```js
r.event==='auth_failure' ? '<span class="pill bad">'+esc(r.reason||'')+'</span>' : resPill(r.result)
```
- `event==='auth_failure'` → 紅色 pill，文字為 `r.reason`（**不是 `r.result`**——認證失敗事件顯示失敗原因，而非結果欄位）。
- 其餘一般請求事件 → 套用共用函式 `resPill(r.result)`（見 `01-shell-and-shared.md` 4.7）：`result` 為空/`'unknown'` → 灰色；`'success'`/`'recovered'` → 綠色；其他（含所有 `error:*`）→ 紅色。

### 3.3 排序

完全依 API 回傳順序（`ORDER BY id DESC`，最新在前），前端不做任何重新排序或 sort。

---

## 4. 互動功能

| 元件 | 觸發方式 | 行為 |
|---|---|---|
| `select#ev-service` | `onchange` | `loadEvents(false)`（重新查詢，非累加） |
| `input#ev-identity` | `onkeydown`，僅 `Enter` 鍵 | `loadEvents(false)` |
| `input#ev-q` | `onkeydown`，僅 `Enter` 鍵 | `loadEvents(false)` |
| `checkbox#ev-errors` | `onchange` | `loadEvents(false)` |
| `checkbox#ev-tool-only` | `onchange` | `loadEvents(false)` |
| `checkbox#ev-live` | 無直接 `onchange` 綁定 | 純粹作為狀態旗標，被 `refresh()` 在每次 5 秒輪詢時讀取（`force || $('#ev-live').checked` 才會呼叫 `loadEvents(false)`），取消勾選即停止自動更新，但不影響手動操作（查詢鈕、篩選變更、Enter、載入更早皆仍正常運作） |
| `button#ev-reload`（"查詢"） | `onclick` | `loadEvents(false)` |
| `button#ev-more`（"載入更早"） | `onclick` | `loadEvents(true)`（append 模式，用 `evOldest` 當 `before_id`） |
| 每列的「▸/▾」按鈕 | `onclick="toggleEvDetail(id)"` | `window.toggleEvDetail`（第 343 行）：切換對應 `#ev-d-{id}` 的 `hidden`；按鈕文字同步切換 `▸`（收合）/`▾`（展開） |

無任何 confirm/alert 對話框（本分頁沒有破壞性操作，全部是唯讀查詢）。

---

## 5. 狀態與邊界

| 情境 | 畫面表現 |
|---|---|
| 查無資料（`d.rows.length===0`） | `#ev-body` 為空（`append=false` 時先清空，之後沒有任何列插入），表格只剩表頭；`#ev-count` 顯示「顯示 0 筆」。**沒有專屬的「無資料」文案/EmptyState**——這點與其他分頁（sessions/stats）不同，重寫時需注意此分頁刻意沒有空狀態提示，若要加上須視為額外增強而非 parity 必要項 |
| 「載入更早」查到 0 筆（已到最舊） | `d.rows.length===0` → `evOldest` 不更新（`if (d.rows.length) evOldest=...` 條件不成立），再次點「載入更早」會用同一個 `before_id` 重查，永遠回傳 0 筆——沒有 disable 按鈕或提示「已到底」的機制，這是原版的已知行為，重寫時可視為 parity 範圍內需保留（或標記為已知可強化點，但非必須修） |
| API 呼叫例外 | 若透過 `refresh()` 觸發，被外層 `try/catch` 吞掉；若透過查詢鈕等直接 `await api(...)` 觸發但無 try/catch 包裹，例外會是 unhandled rejection（無使用者可見提示，畫面停留在呼叫前狀態） |
| `services` 尚未載入（下拉選單為空） | 進入本分頁時 `refresh()` 先檢查 `if (!services.length) await loadOverview()` 自動補上（見 `01-shell-and-shared.md` 5.1），使用者一般不會看到空的服務下拉 |
| 首次載入 | 無 loading 骨架/spinner |

---

## 6. 原始碼行號對照

| 內容 | 行號 |
|---|---|
| `<section id="tab-events">` HTML | 96–109 |
| `evQuery(before)` | 342 |
| `window.toggleEvDetail` | 343 |
| `evRow` | 344–345 |
| `loadEvents(append)` | 346–352 |
| 事件按鈕/篩選綁定 | 353–355 |
| `resPill()`（共用函式） | 277（見 `01-shell-and-shared.md` 4.7） |
| `refresh()` 對 events 分頁的輪詢邏輯 | 829 |
