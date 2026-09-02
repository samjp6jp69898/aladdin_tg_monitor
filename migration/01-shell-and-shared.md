# tg-monitor 前端拆解：應用殼層 + 共用資產

來源：`/Users/user/aladdin/tg-monitor/public/index.html`（845 行單檔 vanilla JS SPA）。本檔涵蓋 `<style>`（第 7–65 行）、`<header>` 殼層、hash routing、共用工具函式、全域輪詢機制、以及重寫時可抽出的共用元件清單。

本檔只涵蓋「總覽 / 即時序列 / 使用 Session / 歷史統計 / Logs」這 5 個分頁需要的殼層與共用邏輯；`tokens` / `pipelines` / `toolsmith` / `workers` / `tg-connected` / `tg-pending` 分頁的細節不在本次拆解範圍內（但其 nav 按鈕、subtab、路由值仍列出，因為它們是殼層的一部分）。

---

## 1. CSS 設計 token 與全域樣式

### 1.1 CSS 變數（定義於 `:root`，第 8 行）

| 變數 | 值 | 用途 |
|---|---|---|
| `--bg` | `#0f1216` | 頁面底色（近黑）；也用於 `.card h3 .dot`、`pre.log` 以外元件的背景、input/select/button.btn 背景 |
| `--panel` | `#171b21` | 卡片 / header / th 背景色（比 `--bg` 稍亮一階） |
| `--line` | `#262c35` | 邊框、分隔線顏色（`.card` 邊框、`th/td` 底線、`.subnav` 底線等） |
| `--fg` | `#e6e9ee` | 主要文字顏色（近白） |
| `--mute` | `#8b94a3` | 次要/靜音文字顏色（標籤、說明文字、灰階狀態） |
| `--ok` | `#3ddc84` | 成功/正常狀態色（綠） |
| `--bad` | `#ff5c5c` | 錯誤/危險狀態色（紅） |
| `--warn` | `#ffb547` | 警告/進行中狀態色（橙） |
| `--acc` | `#5aa9ff` | 強調色（連結、目前選中的 nav/subnav、identity 使用者名稱） |
| `--mono` | `ui-monospace,SFMono-Regular,Menlo,monospace` | 等寬字體堆疊，用於數字/ID/路徑/tool 名等技術性文字 |

深色主題是唯一主題，沒有淺色模式切換；上述值即完整配色。

### 1.2 全域重置與基礎排版

- `*{box-sizing:border-box}`
- `body`：`margin:0`；背景 `var(--bg)`；文字色 `var(--fg)`；字型 `18px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif`（中文優先用蘋方/思源黑體）。
- `a{color:var(--acc)}`：全域連結色。
- `.err{color:var(--bad)}` / `.ok{color:var(--ok)}` / `.mute{color:var(--mute)}`：文字狀態修飾 class，可疊加在任意元素上。

### 1.3 各 class 用途與樣式重點

**Header / Nav**
- `header`：flex 排列，`gap:20px`，`padding:12px 22px`，下邊框 `1px solid var(--line)`，背景 `var(--panel)`，`position:sticky;top:0;z-index:2`（永遠釘在頂部）。
- `header h1`：`font-size:20px;margin:0`。
- `nav button`：無背景、透明邊框、`color:var(--mute)`、`padding:8px 14px`、`border-radius:6px`、`cursor:pointer`、`font-size:18px`。
- `nav button.on`：選中態 —— 文字轉 `var(--fg)`、邊框 `var(--line)`、背景 `var(--bg)`（與 header 背景 `--panel` 形成對比，呈現「按下去」的凹陷感）。

**Subnav（分頁內次分頁，如 Token 權限/TG 已連接/TG 待處理三個 subtab 共用）**
- `.subnav`：flex，`gap:6px`，`margin-bottom:14px`，下邊框 `1px solid var(--line)`，`padding-bottom:12px`。
- `.subnav button`：無背景、透明邊框、`color:var(--mute)`、`padding:6px 12px`、`border-radius:6px`、`font-size:16.5px`（比主 nav 略小）。
- `.subnav button.on`：選中態文字轉 `var(--acc)`、邊框 `var(--acc)`（與主 nav 選中態的樣式不同 —— subnav 用強調色描邊，主 nav 用填色塊）。

**版面容器**
- `main`：`padding:20px 22px`，`max-width:1700px`，`margin:0 auto`（置中、限寬）。
- `.grid`：`display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:16px` —— 響應式卡片牆，每張卡最小寬 440px，自動換行。
- `.two`：`display:grid;grid-template-columns:1fr 1fr;gap:16px`；`@media(max-width:1000px)` 時降級為單欄。
- `.stack`：`display:grid;grid-template-columns:1fr;gap:16px`（單欄堆疊）。
- `.section`：`margin-bottom:24px`；`.section h2`：`font-size:18px;color:var(--mute);margin:0 0 8px;font-weight:500`（灰色小標題，用於總覽的「服務 / Port」區塊標題）。
- `.scroll`：`max-height:60vh;overflow:auto`（表格/列表區的滾動容器；events 分頁另外用 inline style 覆寫為 `max-height:80vh`）。

**Card**
- `.card`：背景 `var(--panel)`，邊框 `1px solid var(--line)`，`border-radius:12px`，`padding:16px 18px`，`min-width:0`（允許 grid 子項縮小、避免內容溢出撐爆版面）。
- `.card h3`：`margin:0 0 8px;font-size:19px;display:flex;align-items:center;gap:10px`（標題列可放圖示/按鈕在同一行）。
- `.card h3 .nm`：`white-space:nowrap;overflow:hidden;text-overflow:ellipsis`（服務名稱過長時截斷加省略號）。

**狀態指示**
- `.dot`：`width:12px;height:12px;border-radius:50%;background:var(--mute);flex:none`（預設灰點）。
- `.dot.up`：綠底 + `box-shadow:0 0 8px var(--ok)` 發光。
- `.dot.down`：紅底 + `box-shadow:0 0 8px var(--bad)` 發光。
- `.pill`：`display:inline-block;padding:2px 9px;border-radius:10px;font-size:15px;border:1px solid var(--line);color:var(--mute);font-family:var(--mono)`（膠囊徽章，預設灰框灰字）。
- `.pill.ok`：綠字綠框。`.pill.bad`：紅字紅框。`.pill.warn`：橙字橙框。

**Key-Value 區塊（卡片內常見的標籤/數值排列）**
- `.kv`：`display:grid;grid-template-columns:minmax(96px,auto) 1fr;gap:6px 12px;font-size:16.5px;color:var(--mute)`（左欄標籤右欄值，標籤欄最小 96px）。
- `.kv b`：`color:var(--fg);font-weight:500;font-family:var(--mono);word-break:break-all`（值用等寬字體、允許斷行）。

**使用者列表（卡片內「目前使用中」清單）**
- `.users`：`margin-top:8px;border-top:1px dashed var(--line);padding-top:8px`（虛線分隔）。
- `.user`：`display:flex;justify-content:space-between;gap:12px;padding:4px 0;flex-wrap:wrap;font-size:17px`。
- `.user .who`：`color:var(--acc);font-weight:600`（使用者 identity）。
- `.user .meta`：`color:var(--mute);font-family:var(--mono);font-size:15.5px`（次要資訊：次數/tool/時間/IP）。

**Tags（服務卡片頂部的 port/proxy/launchd 標籤列）**
- `.tags`：`display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px`（內部元素通常是 `.pill`）。

**表格**
- `table`：`width:100%;border-collapse:collapse;font-size:16.5px`。
- `th,td`：`text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap`（預設不換行，避免表格因長文字亂跳版）。
- `th`：`color:var(--mute);font-weight:500;position:sticky;top:0;background:var(--panel)`（表頭黏頂，搭配 `.scroll` 容器做內部滾動時表頭固定）。
- `td.mono,th.mono`：等寬字體 `font-size:16px`。
- `.tools`：`white-space:normal;min-width:260px;max-width:460px`（sessions 分頁 tool 序列欄，允許換行且限制寬度範圍）。
- `.tools span`：`display:inline-block;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 7px;margin:2px 4px 2px 0;font-family:var(--mono);font-size:15px`（每個 tool 名一顆小標籤）。
- `tr.stage-running td`（pipelines 分頁專用，非本次 5 分頁範圍）：`color:var(--warn);border-top/bottom:1px solid var(--warn)`。
- `tr.agent-row`（pipelines 分頁專用）：`cursor:pointer`；hover 背景 `rgba(90,169,255,.08)`；`.on` 態背景 `rgba(90,169,255,.15)`。
- `#pl-list.hide-outcome .col-outcome{display:none}`（pipelines 分頁專用，隱藏結果欄的 toggle 機制）。

**工具列 / 表單控制項**
- `.bar`：`display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px`（篩選列的標準容器，各分頁的搜尋列都用它）。
- `input,select`：背景 `var(--bg)`，文字 `var(--fg)`，邊框 `1px solid var(--line)`，`border-radius:8px`，`padding:8px 10px`，`font-size:17px`。
- `button.btn`：背景 `var(--bg)`，文字 `var(--fg)`，邊框 `1px solid var(--line)`，`border-radius:8px`，`padding:8px 14px`，`cursor:pointer`；hover 時邊框轉 `var(--acc)`。
- `button.btn.danger`：紅字紅框，`padding:4px 10px;font-size:15px`（比一般 btn 小）；hover 時背景轉紅、文字轉白。
- `button.btn.warn`：橙字橙框，同上尺寸；hover 時背景轉橙、文字轉白。

**Log 檢視器**
- `pre.log`：背景 `#0a0c10`（比 `--bg` 更深，非 CSS 變數，直接寫死），邊框 `1px solid var(--line)`，`border-radius:10px`，`padding:14px`，等寬字體 `font-size:16px`，`height:70vh`，`overflow:auto`，`white-space:pre-wrap;word-break:break-all`，`margin:0`。Logs 分頁的 `#lg-out` 直接套用此 class。

**折線圖 / Sparkline（歷史統計「近 24 小時每小時請求數」用）**
- `.spark`：`width:100%;overflow-x:auto`。
- `.spark .bar:hover rect`：hover 時 `opacity:1;filter:brightness(1.25)`（長條圖 bar hover 提亮）。

**其他（pipelines/agent 對話紀錄用，非本次 5 分頁範圍，列出以求完整）**
- `.turn`、`.turn.assistant`、`.turn.user`、`.turn .role`、`.turn pre`、`.turn details`、`.turn summary`、`.turn details.result/.err summary`、`.turn details pre`、`.turn .thinking`、`.final`、`.final pre`：agent 對話回放 UI 用的樣式，屬於 pipelines/toolsmith 分頁範疇。

---

## 2. 應用殼層

### 2.1 Header 結構（第 68–82 行）

```
<header>
  <h1>tg-monitor</h1>
  <nav> ... 9 個分頁按鈕 ... </nav>
  <button id="global-reload">↻ 刷新</button>
</header>
```

### 2.2 9 個 nav 分頁按鈕（`data-tab` 值與中文標籤，依原始順序）

| 順序 | `data-tab` | 中文標籤 | `data-group` | 備註 |
|---|---|---|---|---|
| 1 | `overview` | 總覽 | — | 初始 `class="on"`（預設分頁） |
| 2 | `events` | 即時序列 | — | |
| 3 | `sessions` | 使用 Session | — | |
| 4 | `stats` | 歷史統計 | — | |
| 5 | `tokens` | 連接 | `tokens tg-connected tg-pending` | 本身路由值是 `tokens`，但代表一整組（見 2.3） |
| 6 | `pipelines` | Pipelines | — | |
| 7 | `toolsmith` | Toolsmith | — | |
| 8 | `workers` | Workers | — | |
| 9 | `logs` | Logs | — | |

### 2.3 `data-group` 機制

`data-group="tokens tg-connected tg-pending"`（第 75 行）是空白分隔的路由值清單。`showTab(t)`（第 284 行）在決定每顆 nav 按鈕是否顯示 `.on` 高亮時，判斷式為：

```js
b.dataset.tab===t || (b.dataset.group||'').split(' ').includes(t)
```

也就是說：「連接」這顆 nav 按鈕本身 `data-tab="tokens"`，但只要目前路由 `t` 是 `tokens`、`tg-connected`、`tg-pending` 三者之一，它都會被標記為選中（`.on`）。這讓「連接」底下的 3 個 subtab（各自是獨立 section/route）在導覽列上共用同一顆父層按鈕的高亮狀態，UX 上呈現「一個大分頁、內部再切 3 個子分頁」的層級。

「連接」下的 3 個 subtab（各自的 section 內都重複放一份相同的 `.subnav` 三顆按鈕，第 135–139、239–243、249–253 行）：

| `data-tab` | 中文標籤 |
|---|---|
| `tokens` | Token 權限 |
| `tg-connected` | TG 已連接 |
| `tg-pending` | TG 待處理 |

subtab 按鈕的 `onclick` 直接寫 `onclick="showTab('tokens')"` 等（inline handler，不像主 nav 是事後用 `forEach` 綁 `onclick`），且 `.subtab` 的選中判斷（第 284 行）是單純比對 `b.dataset.tab===t`，不吃 `data-group`。

### 2.4 右上角「↻ 刷新」按鈕（`#global-reload`，第 81、285 行）

```html
<button class="btn" id="global-reload" title="立即刷新當前分頁的資料" style="margin-left:auto">↻ 刷新</button>
```

- `style="margin-left:auto"`：在 flex header 裡把自己推到最右側。
- `title` tooltip 原文：「立即刷新當前分頁的資料」。
- 點擊行為：`$('#global-reload').onclick = () => refresh(true)` —— 呼叫全域 `refresh()` 並強制 `force=true`（見第 5 節，`force=true` 會讓某些分頁忽略「僅在特定條件才刷新」的節流邏輯，強制重新打 API）。

---

## 3. 路由機制

### 3.1 原始碼（第 281–284 行）

```js
let tab = location.hash.slice(1) || 'overview'
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab))
function showTab(t){
  tab = t
  location.hash = t
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab===t || (b.dataset.group||'').split(' ').includes(t)))
  document.querySelectorAll('.subtab').forEach(b => b.classList.toggle('on', b.dataset.tab===t))
  document.querySelectorAll('main > section').forEach(s => s.hidden = s.id !== 'tab-'+t)
  refresh(true)
}
```

初始化呼叫在檔案最尾端（第 841 行）：`showTab(tab)`。

### 3.2 運作方式

1. **初始載入還原分頁**：`tab` 變數在 script 頂部（第 282 行）就以 `location.hash.slice(1) || 'overview'` 初始化 —— 若網址帶 `#events` 之類的 hash，去掉開頭 `#` 後即為初始分頁；沒有 hash 時預設 `overview`。腳本執行到最後一行才真正呼叫 `showTab(tab)`（第 841 行），此時所有 DOM 綁定、`$()` 查詢都已備妥。
2. **切換分頁**：`showTab(t)` 是唯一入口，做四件事：(a) 更新全域變數 `tab` 與 `location.hash`（產生瀏覽器歷史紀錄、可用瀏覽器上一頁/下一頁、可分享網址直達分頁）；(b) 更新主 nav 按鈕的 `.on` class（含 data-group 邏輯）；(c) 更新 `.subtab` 按鈕的 `.on` class；(d) 用 `section.hidden = section.id !== 'tab-'+t` 切換每個 `<section>` 的可見性 —— **沒有任何路由庫，純粹靠 `hidden` attribute 顯示/隱藏對應 section，所有分頁的 DOM 一直都在，只是被隱藏**；(e) 呼叫 `refresh(true)` 立即載入該分頁資料。
3. `main > section` 選擇器只抓 `<main>` 的直接子層 `<section>`，共 9 個（見下方合法 route 清單），彼此互斥顯示。
4. 使用者手動改網址列的 hash（例如貼上 `#stats` 分享連結）會觸發瀏覽器原生 hashchange，但**程式碼並未監聽 `window.onhashchange`** —— 這代表使用者手動編輯網址列 hash 後按 Enter，`tab` 變數與畫面不會自動同步更新，必須透過點擊 nav 按鈕呼叫 `showTab()` 才會生效。這是重寫時的行為差異點：若用 React Router 之類的正規 hash routing，會自動監聽 hashchange，行為會比原版更完整（功能對等比對時這屬於「原版的已知限制」，非必須複製的 bug，但需在文件中註記避免誤判為缺失）。

### 3.3 全部合法 route 值（對應 9 個 `<section id="tab-*">`，第 84–267 行）

| route 值 | section id | 說明 |
|---|---|---|
| `overview` | `tab-overview` | 總覽（本次拆解範圍） |
| `events` | `tab-events` | 即時序列（本次拆解範圍） |
| `sessions` | `tab-sessions` | 使用 Session（本次拆解範圍） |
| `stats` | `tab-stats` | 歷史統計（本次拆解範圍） |
| `tokens` | `tab-tokens` | Token 權限（連接 subtab 之一，非本次範圍） |
| `pipelines` | `tab-pipelines` | Pipelines（非本次範圍） |
| `toolsmith` | `tab-toolsmith` | Toolsmith（非本次範圍） |
| `workers` | `tab-workers` | Workers（非本次範圍） |
| `tg-connected` | `tab-tg-connected` | TG 已連接（連接 subtab 之一，非本次範圍） |
| `tg-pending` | `tab-tg-pending` | TG 待處理（連接 subtab 之一，非本次範圍） |
| `logs` | `tab-logs` | Logs（本次拆解範圍） |

注意：共 11 個合法 route 值對應 9 個 `<section>` —— `tokens`／`tg-connected`／`tg-pending` 各有獨立 section，但主 nav 只有一顆「連接」按鈕（`data-tab="tokens"`），彼此的切換要靠各 section 內重複的 `.subnav` 三顆 subtab 按鈕。

### 3.4 分頁間的程式化跳轉（附加路由行為，events/sessions/stats 互相關聯時使用）

- `window.jumpEvents(svc, who)`（第 363 行）：設定 `#ev-service`/`#ev-identity` 的值後呼叫 `showTab('events')`。由 sessions 分頁「看事件」連結呼叫（見 `sessions.md`）。
- `window.jumpEventsQuery(svc, q, errorsOnly)`（第 366 行）：設定 `#ev-service`/`#ev-q`/`#ev-errors`（並清空 `#ev-identity`、`#ev-tool-only`）後呼叫 `showTab('events')`。由 stats 分頁的 tool 排行/認證失敗來源表格連結呼叫（見 `stats.md`）。
- overview 分頁的「查看」連結（`#tg-connected`/`#tg-pending`）直接 `onclick="showTab('tg-connected');return false"`（第 316–317 行）。

---

## 4. 共用工具函式

以下全部定義於 `<script>` 區塊頂部（第 271–278 行），全域可見（未用 module，靠 `<script>` 全域作用域）。

### 4.1 `$`（第 271 行）
```js
const $ = s => document.querySelector(s)
```
- 輸入：CSS selector 字串。
- 輸出：`document.querySelector` 結果（`Element | null`）。無特殊邊界處理，選不到就是 `null`，後續呼叫方法會拋錯（原程式碼假設所有 selector 都存在對應 DOM，重寫為 React 時此函式本身不需要遷移，直接用 ref / 元件狀態取代）。

### 4.2 `esc`（第 272 行）—— HTML escape
```js
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
```
- 輸入：任意值 `s`（可能是 `undefined`/`null`/數字/字串）。
- 行為：`s ?? ''` —— `null` 或 `undefined` 轉為空字串，其餘值原樣保留（含 `0`、`false` 這種 falsy 但非 nullish 的值不會被清空）；`String(...)` 轉字串；正則取代 4 個字元 `&` `<` `>` `"`（**不含單引號 `'`**，這是既有限制——若資料含單引號且被插入 HTML 屬性值時仍有 XSS 風險，此為原程式碼行為，非規格缺失，重寫時應注意是否要補強）。
- 輸出：跳脫後的字串，只跳脫 `&→&amp;`、`<→&lt;`、`>→&gt;`、`"→&quot;`。
- TypeScript 等價實作：
```ts
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] as string))
}
```
（在 React 中通常不需要手動 esc，因為 JSX 預設會跳脫文字節點；此函式主要在原版用 template string 拼 innerHTML 時才需要，重寫時多數呼叫點應改為讓 React 自動處理，只有少數仍手動組 HTML 字串的地方才需要保留邏輯對等物。）

### 4.3 `fmt`（第 273 行）—— 完整日期時間格式化
```js
const fmt = ts => ts ? new Date(ts).toLocaleString('zh-TW', {hour12:false}) : '-'
```
- 輸入：`ts`（ISO 字串或任何 `Date` 建構子可接受的值，或 `null`/`undefined`/空字串/`0`）。
- 行為：falsy 值（`null`/`undefined`/`''`/`0`）→ 回傳 `'-'`；否則 `new Date(ts).toLocaleString('zh-TW', {hour12:false})` —— 台灣地區格式、24 小時制。
- 輸出：字串，格式類似 `2026/9/2 09:30:15`（實際格式依執行環境 `Intl` 實作而定，Node/瀏覽器可能有差異）。
- 邊界：無效日期字串（`Date` 解析失敗）會產出 `Invalid Date` 字串本身被 `toLocaleString` 呼叫，結果通常是 `'Invalid Date'`，原程式碼未特別防禦。

### 4.4 `ago`（第 274 行）—— 相對時間（多久以前）
```js
const ago = ts => { if(!ts) return '-'; const s=Math.max(0,(Date.now()-Date.parse(ts))/1000); return s<60?`${s|0}s前`:s<3600?`${(s/60)|0}m前`:s<86400?`${(s/3600)|0}h前`:`${(s/86400)|0}d前` }
```
- 輸入：`ts`（時間字串），falsy → `'-'`。
- 行為：`s = max(0, (now - parse(ts)) / 1000)`（秒數，用 `Math.max(0, ...)` 防止未來時間出現負值）；`|0` 是無條件捨去取整數（bitwise OR 0 的位元運算 trick，等同 `Math.floor` 對非負數的效果）。
- 分段規則：`s<60` → `${秒}s前`；`s<3600` → `${分}m前`；`s<86400` → `${時}h前`；否則 → `${天}d前`。
- 輸出範例：`45s前`、`12m前`、`3h前`、`2d前`、`-`（無值時）。
- TypeScript 等價：
```ts
function ago(ts?: string | null): string {
  if (!ts) return '-'
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000)
  if (s < 60) return `${Math.floor(s)}s前`
  if (s < 3600) return `${Math.floor(s / 60)}m前`
  if (s < 86400) return `${Math.floor(s / 3600)}h前`
  return `${Math.floor(s / 86400)}d前`
}
```

### 4.5 `dur`（第 275 行）—— 兩個時間點之間的時長
```js
const dur = (a,b) => { if(!a) return '-'; const s=((b?Date.parse(b):Date.now())-Date.parse(a))/1000; return s<60?`${s|0}s`:s<3600?`${(s/60)|0}m${(s%60)|0}s`:`${(s/3600)|0}h${((s%3600)/60)|0}m` }
```
- 輸入：`a`（起始時間字串，必填語意上）、`b`（結束時間字串，可省略/falsy）。
- 行為：`a` falsy → 回傳 `'-'`；`b` 有值則用 `Date.parse(b)`，否則用 `Date.now()`（代表「持續到現在」，常用於顯示尚未結束的排隊/執行時長）；`s` = 秒數（**沒有 `Math.max(0,...)` 防護**，若 `b < a` 會出現負值，未特別處理，重寫時應保留此行為或視情況修正——本文件建議照原樣實作以維持 parity）。
- 分段規則：`s<60` → `${秒}s`；`s<3600` → `${分}m${秒}s`（分與秒都顯示，秒不補零）；否則 → `${時}h${分}m`（時與分都顯示，分不補零）。**注意與 `ago()` 不同：`ago` 每個量級只顯示一個單位，`dur` 中間兩個量級顯示兩個單位（分+秒、時+分），最大量級（天）沒有對應分支——超過 24 小時的時長會落在 `else` 分支持續以「時+分」顯示，不會轉成「天」。**
- 輸出範例：`45s`、`3m20s`、`2h15m`、`-`。
- TypeScript 等價：
```ts
function dur(a?: string | null, b?: string | null): string {
  if (!a) return '-'
  const s = ((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}
```

### 4.6 `upt`（第 276 行）—— uptime 秒數格式化（overview 專用）
```js
const upt = s => s==null?'-':s<3600?`${(s/60)|0}m`:s<86400?`${(s/3600)|0}h${((s%3600)/60)|0}m`:`${(s/86400)|0}d${((s%86400)/3600)|0}h`
```
- 輸入：`s`（秒數，數字），`null`/`undefined`（用 `==null` 寬鬆比對，兩者都算）→ `'-'`。注意 `0` 不會被擋掉（`0 == null` 為 `false`），`0` 秒會走入 `s<3600` 分支輸出 `0m`。
- 行為：`s<3600` → `${分}m`（只顯示分鐘，不顯示秒）；`s<86400` → `${時}h${分}m`；否則 → `${天}d${時}h`。
- 輸出範例：`45m`、`3h20m`、`5d12h`、`-`。
- TypeScript 等價：
```ts
function upt(s?: number | null): string {
  if (s == null) return '-'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`
}
```

### 4.7 `resPill`（第 277 行）—— 結果狀態徽章（events 分頁「結果」欄用）
```js
const resPill = r => { if(!r||r==='unknown') return '<span class="pill">'+esc(r||'-')+'</span>'; if(r==='success'||r==='recovered') return '<span class="pill ok">'+esc(r)+'</span>'; return '<span class="pill bad">'+esc(r)+'</span>' }
```
- 輸入：`r`（`result` 欄位字串，如 `'success'`、`'error:xxx'`、`'recovered'`、`'unknown'`、空字串、`null`）。
- 行為：
  1. `!r || r==='unknown'` → 灰色 `.pill`（無強調色），文字為 `r||'-'`（空/null 時顯示 `-`，字面值 `'unknown'` 時原樣顯示 `unknown`）。
  2. `r==='success' || r==='recovered'` → 綠色 `.pill.ok`，文字原樣。
  3. 其餘所有值（含所有 `error:*` 開頭的字串）→ 紅色 `.pill.bad`，文字原樣。
- 輸出：一段 HTML 字串（`<span class="pill ...">...</span>`），內部文字經過 `esc()` 處理。
- 顏色對應規則彙總：`-`/`unknown` → 灰；`success`/`recovered` → 綠；其他一律紅（含所有錯誤訊息）。
- TypeScript 等價（在 React 中應改為回傳一個 `<Badge>` 元件而非 HTML 字串，見第 6 節共用元件候選）：
```ts
type ResultPillVariant = 'default' | 'ok' | 'bad'
function resultPillVariant(r?: string | null): ResultPillVariant {
  if (!r || r === 'unknown') return 'default'
  if (r === 'success' || r === 'recovered') return 'ok'
  return 'bad'
}
```

### 4.8 `api`（第 278 行）—— fetch 包裝
```js
const api = (p) => fetch(p).then(r => r.json())
```
- 輸入：`p`（URL 字串，相對路徑如 `/api/overview`）。
- 行為：`fetch(p)` 後直接 `.then(r => r.json())`，**沒有檢查 `r.ok`／HTTP status**——非 2xx 回應只要 body 是合法 JSON 就會被當成正常資料回傳，不會拋錯；只有 network 層失敗（連不上、JSON 解析失敗）才會 reject。呼叫端各處理方式不一致：多數 `await api(...)` 呼叫沒有包 try/catch（例外會冒泡到 `refresh()` 的 `try/catch`，見第 5 節）；少數操作型 API（POST）呼叫另外用 `.catch(e=>({ok:false, result:String(e)}))` 手動接住錯誤。
- 輸出：`Promise<any>`（解析後的 JSON）。
- TypeScript 等價：
```ts
async function api<T = any>(path: string): Promise<T> {
  const r = await fetch(path)
  return r.json()
}
```

### 4.9 `barChart`（第 370–389 行）—— SVG 長條圖（stats 分頁「近 24 小時每小時請求數」專用）

詳細規格見 `tabs/stats.md`（渲染邏輯章節），此處僅列出函式簽名與職責：輸入 `items: {t: Date, n: number}[]`（24 筆，每筆代表一個小時），輸出一段內嵌 SVG 的 HTML 字串（長條圖，Y 軸自動取整數刻度，X 軸標示小時數字，hover 顯示 tooltip）。

---

## 5. 全域輪詢與資料刷新機制

### 5.1 `refresh(force)`（第 826–840 行）

```js
async function refresh(force){
  try {
    if (tab==='overview') await loadOverview()
    else if (tab==='events') { if (!services.length) await loadOverview(); if (force || $('#ev-live').checked) await loadEvents(false) }
    else if (tab==='sessions') { if (!services.length) await loadOverview(); await loadSessions() }
    else if (tab==='stats') await loadStats()
    else if (tab==='tokens') { ... }         // 非本次範圍
    else if (tab==='pipelines') { ... }      // 非本次範圍
    else if (tab==='toolsmith') await loadToolsmith()  // 非本次範圍
    else if (tab==='workers') { ... }        // 非本次範圍
    else if (tab==='tg-connected') await loadTgConnected()  // 非本次範圍
    else if (tab==='tg-pending') { ... }     // 非本次範圍
    else if (tab==='logs') { if (force) { await loadLogList(); if (!$('#lg-file').value && $('#lg-file').options.length) $('#lg-file').selectedIndex=0; await loadLog() } else if (document.activeElement !== $('#lg-file')) await loadLogList() }
  } catch (e) { console.error(e) }
}
```

**核心設計：`refresh()` 是唯一的「重新載入目前分頁資料」入口**，靠全域變數 `tab`（由 `showTab()` 維護）判斷該呼叫哪個分頁的 loader。整個函式包在一個 `try/catch` 裡，任何分頁的 loader 拋錯都只會 `console.error`，不會中斷輪詢迴圈或讓其他分頁失效。

各分頁在 `refresh()` 中的行為（僅列本次範圍的 5 個分頁）：

| 分頁 | `force=false`（背景輪詢） | `force=true`（切換分頁 / 按刷新鈕） |
|---|---|---|
| `overview` | 呼叫 `loadOverview()` | 同左（overview 沒有 force 差異） |
| `events` | 若 `services` 尚未載入（`services.length===0`）先呼叫 `loadOverview()` 補上服務清單（用於下拉選單）；接著只有在 `#ev-live`（自動更新 checkbox）勾選時才呼叫 `loadEvents(false)` | 若 `services` 空則同上補；**強制**呼叫 `loadEvents(false)`，無視 `#ev-live` 是否勾選 |
| `sessions` | 若 `services` 為空先補 `loadOverview()`；接著**每次都**呼叫 `loadSessions()`（sessions 沒有像 events 的「自動更新」開關，輪詢與 force 行為一致） | 同左 |
| `stats` | 呼叫 `loadStats()`（每次輪詢都重算） | 同左 |
| `logs` | 若目前焦點**不在** `#lg-file` 下拉選單上，才呼叫 `loadLogList()`（只重整檔案清單，不重新載入 log 內容——避免使用者正在下拉選檔案時清單被打斷） | 呼叫 `loadLogList()`；若目前沒有選中檔案（`#lg-file` 為空）且清單非空，自動選第一個（`selectedIndex=0`）；接著呼叫 `loadLog()`（重新載入該檔案內容並重啟即時跟隨 timer，見 `tabs/logs.md`） |

### 5.2 全域輪詢間隔

```js
setInterval(()=>refresh(false), 5000)
```
（第 842 行）—— **每 5000ms（5 秒）** 呼叫一次 `refresh(false)`，是整個應用唯一的「背景自動刷新」心跳。所有分頁的資料新鮮度上限都是 5 秒（events 分頁另有 `#ev-live` checkbox 可關閉此行為，但只影響 events；其餘分頁無法個別關閉輪詢）。

### 5.3 分頁專屬的額外 timer

- **Logs 分頁的「即時跟隨」**（第 748 行）：`loadLog()` 內部另外開一個 `setInterval(..., 1500)`（**1500ms**），輪詢 `/api/log/since` 取得檔案自上次讀取後新增的內容並附加到畫面。此 timer 與全域 5 秒心跳是**兩條獨立的輪詢迴圈**同時運作——全域心跳在非 force 情況下只重整檔案「清單」（見 5.1 表格），真正的 log 內容追加靠這個 1.5 秒的專屬 timer。切換 log 檔案或關閉「即時跟隨」checkbox 都會先 `clearInterval` 舊 timer（第 742 行）再視情況重開。

### 5.4 SSE / 即時連線

**本應用完全不使用 SSE（Server-Sent Events）或 WebSocket。** 原始碼註解明確說明原因（`server.ts` 第 787–788 行附近）：

> 「即時跟隨：客戶端帶上次看到的 offset 來拿新增部分（輪詢，不用 SSE——Bun 1.2.9 的 ReadableStream 在客戶端中斷連線時會 segfault，實測踩到）。」

所有「即時性」都是靠上述兩層輪詢（全域 5 秒 + logs 專屬 1.5 秒）達成，重寫時若換掉 Bun 版本或改用其他 runtime，可考慮改用 SSE/WebSocket，但這屬於架構升級而非 functional parity 範圍內必須保留的行為——parity 比對只需確認「畫面上的資料新鮮度」等價（即輪詢間隔/行為一致），不需要底層傳輸機制一致。

---

## 6. 可抽成共用 React 元件的候選清單

| 元件名稱 | 對應原始碼 pattern | 使用分頁 | 建議 props |
|---|---|---|---|
| **Card** | `.card` + `.card h3` | overview（服務卡片、Telegram Webhook、TG 連接名單、背景 Pipeline 併發、最近狀態翻轉）、stats（各統計卡片） | `title: ReactNode`（可含右側 icon/按鈕）、`children: ReactNode`、`className?: string` |
| **CardGrid** | `.grid` | overview（服務卡片牆） | `children: ReactNode`（內部各項自動 minmax(440px,1fr) 排列） |
| **TwoColumn** | `.two` | overview（Webhook/TG 名單並排、Pipeline 併發/狀態翻轉並排） | `left: ReactNode`、`right: ReactNode`（≤1000px 自動疊成單欄） |
| **StatusDot** | `.dot`/`.dot.up`/`.dot.down` | overview 服務卡片 | `status: 'up' \| 'down' \| undefined'` |
| **Badge / Pill** | `.pill`/`.pill.ok`/`.pill.bad`/`.pill.warn` | overview（UP/DOWN、排隊數）、events（結果欄 `resPill`）、tokens/pipelines 等其他分頁 | `variant: 'default' \| 'ok' \| 'bad' \| 'warn'`、`children: ReactNode` |
| **KeyValueGrid** | `.kv` + `.kv b` | overview（服務卡片內數據、Webhook 資訊、TG 連接統計） | `rows: {label: ReactNode, value: ReactNode}[]` |
| **DataTable** | 裸 `table`/`th`/`td` + `.scroll` 容器 + sticky `th` | events、sessions、stats（4 張表）、logs 檔案下拉的資料來源、overview 的狀態翻轉/running pipeline 小表 | `columns: {key, header, className?, render?}[]`、`rows: T[]`、`emptyText: string`（各分頁的「無資料」文案不同，需可自訂）、`maxHeight?: string`（對應 `.scroll` 的 60vh/80vh 差異） |
| **Toolbar** | `.bar` | events（篩選列）、sessions（篩選列）、stats（天數選單+重算鈕）、logs（檔案/大小/跟隨/重載列）、overview 無此需求 | `children: ReactNode`（flex-wrap 容器，純樣式元件，不需要特別 props） |
| **EmptyState** | 各分頁散落的 `<div class="mute">...無資料/無紀錄...</div>` 或 `<div class="ok">...無...</div>` | events（隱含於空表格）、sessions（`無資料`）、stats（`無資料`/`尚無 tool 呼叫`/`期間內無認證失敗`）、logs（`(檔案不存在)`） | `text: string`、`tone?: 'mute' \| 'ok' \| 'err'` |
| **SubNav** | `.subnav` + `.subnav button.on` | 連接分頁的 3 個 subtab（非本次範圍，但屬殼層共用機制，值得列出） | `items: {key, label}[]`、`active: string`、`onSelect(key)` |
| **ResultBadge** | `resPill()` 函式（第 277 行） | events（結果欄）、間接影響 stats 的 tool 排行（`看錯誤`/`看事件` 連結邏輯基於同一套 result 語意） | `result?: string`（內部即 `Badge`/`Pill` 套用 `resultPillVariant()` 邏輯） |
| **SparkBarChart** | `barChart()` 函式（第 370–389 行，內嵌 SVG） | stats（近 24 小時每小時請求數） | `items: {t: Date, n: number}[]`、可選 `width/height` |
| **RelativeTime** | `ago()` 函式的顯示端 | overview（多處 `ago(ts)`）、events（`toggleEvDetail` 詳情列）、sessions（`ago(s.end)`）、stats（`ago(r.last_ts)`） | `ts?: string \| null`（元件內部呼叫 `ago()`，可選是否加上 `title={fmt(ts)}` 顯示完整時間作為 hover tooltip，原版無此 tooltip 但是常見強化，若要嚴格 parity 則不加） |
| **LogViewer** | `pre.log` + `#lg-out` 的 tail/since 輪詢邏輯 | logs 分頁專屬（見 `tabs/logs.md`） | `path: string`、`kb: number`、`follow: boolean` |

**共用樣式基礎設施**（非 React 元件，但重寫時應對等移植）：全域 CSS 變數（token）建議直接搬進 Tailwind theme 或 CSS custom properties；`.mono`/`.mute`/`.err`/`.ok` 這類單一用途 utility class 建議保留為 CSS class 或對應的 Tailwind utility，不必特地包成元件。

---

## Appendix：`<style>` 區塊原文（第 7–65 行）

```html
<style>
  :root{--bg:#0f1216;--panel:#171b21;--line:#262c35;--fg:#e6e9ee;--mute:#8b94a3;--ok:#3ddc84;--bad:#ff5c5c;--warn:#ffb547;--acc:#5aa9ff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif}
  header{display:flex;align-items:center;gap:20px;padding:12px 22px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
  header h1{font-size:20px;margin:0}
  nav button{background:none;border:1px solid transparent;color:var(--mute);padding:8px 14px;border-radius:6px;cursor:pointer;font-size:18px}
  nav button.on{color:var(--fg);border-color:var(--line);background:var(--bg)}
  .subnav{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--line);padding-bottom:12px}
  .subnav button{background:none;border:1px solid transparent;color:var(--mute);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:16.5px}
  .subnav button.on{color:var(--acc);border-color:var(--acc)}
  main{padding:20px 22px;max-width:1700px;margin:0 auto}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;min-width:0}
  .card h3{margin:0 0 8px;font-size:19px;display:flex;align-items:center;gap:10px}
  .card h3 .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
  .dot{width:12px;height:12px;border-radius:50%;background:var(--mute);flex:none}
  .dot.up{background:var(--ok);box-shadow:0 0 8px var(--ok)}.dot.down{background:var(--bad);box-shadow:0 0 8px var(--bad)}
  .kv{display:grid;grid-template-columns:minmax(96px,auto) 1fr;gap:6px 12px;font-size:16.5px;color:var(--mute)}
  .kv b{color:var(--fg);font-weight:500;font-family:var(--mono);word-break:break-all}
  .users{margin-top:8px;border-top:1px dashed var(--line);padding-top:8px}
  .user{display:flex;justify-content:space-between;gap:12px;padding:4px 0;flex-wrap:wrap;font-size:17px}
  .user .who{color:var(--acc);font-weight:600}.user .meta{color:var(--mute);font-family:var(--mono);font-size:15.5px}
  .pill{display:inline-block;padding:2px 9px;border-radius:10px;font-size:15px;border:1px solid var(--line);color:var(--mute);font-family:var(--mono)}
  .pill.ok{color:var(--ok);border-color:var(--ok)}.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.warn{color:var(--warn);border-color:var(--warn)}
  tr.stage-running td{color:var(--warn);border-top:1px solid var(--warn);border-bottom:1px solid var(--warn)}
  table{width:100%;border-collapse:collapse;font-size:16.5px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
  th{color:var(--mute);font-weight:500;position:sticky;top:0;background:var(--panel)}
  td.mono,th.mono{font-family:var(--mono);font-size:16px}
  .tools{white-space:normal;min-width:260px;max-width:460px}
  .tools span{display:inline-block;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 7px;margin:2px 4px 2px 0;font-family:var(--mono);font-size:15px}
  .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  input,select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:17px}
  button.btn{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 14px;cursor:pointer}
  button.btn:hover{border-color:var(--acc)}
  button.btn.danger{color:var(--bad);border-color:var(--bad);padding:4px 10px;font-size:15px}button.btn.danger:hover{background:var(--bad);color:#fff}
  button.btn.warn{color:var(--warn);border-color:var(--warn);padding:4px 10px;font-size:15px}button.btn.warn:hover{background:var(--warn);color:#fff}
  #pl-list.hide-outcome .col-outcome{display:none}
  pre.log{background:#0a0c10;border:1px solid var(--line);border-radius:10px;padding:14px;font-family:var(--mono);font-size:16px;height:70vh;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0}
  .section{margin-bottom:24px}.section h2{font-size:18px;color:var(--mute);margin:0 0 8px;font-weight:500}
  .err{color:var(--bad)}.ok{color:var(--ok)}.mute{color:var(--mute)}
  .spark{width:100%;overflow-x:auto}.spark .bar:hover rect{opacity:1;filter:brightness(1.25)}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:1000px){.two{grid-template-columns:1fr}}
  .stack{display:grid;grid-template-columns:1fr;gap:16px}
  .scroll{max-height:60vh;overflow:auto}
  a{color:var(--acc)}
  .turn{border-left:3px solid var(--line);padding:6px 12px;margin:8px 0}
  .turn.assistant{border-color:var(--acc)}.turn.user{border-color:var(--mute)}
  .turn .role{font-size:15px;color:var(--mute);margin-bottom:4px;font-family:var(--mono)}
  .turn pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;font-family:inherit;font-size:16.5px;line-height:1.5}
  .turn details{margin:4px 0}.turn summary{cursor:pointer;color:var(--warn);font-family:var(--mono);font-size:15px}
  .turn details.result summary{color:var(--mute)}.turn details.err summary{color:var(--bad)}
  .turn details pre{font-family:var(--mono);font-size:14.5px;background:#0a0c10;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:40vh;overflow:auto}
  .turn .thinking{color:var(--mute);font-style:italic}
  .final{border:1px solid var(--ok);border-radius:10px;padding:12px 14px;background:rgba(61,220,132,.05)}
  .final pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font-family:inherit}
  tr.agent-row{cursor:pointer}tr.agent-row:hover td{background:rgba(90,169,255,.08)}tr.agent-row.on td{background:rgba(90,169,255,.15)}
</style>
```
