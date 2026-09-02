> ⚠️ 行號基準：本文件引用的 **server.ts 行號**是 2026-09-02 新增 `/next/*` 靜態路由**之前**的版本，
> 該次改動在第 44 行後插入 15 行，因此第 44 行之後的 server.ts 行號請 **+15**。
> **index.html 的行號正確無須調整**（該檔未被修改）。

# 分頁規格：總覽（overview）

route 值：`overview`　section id：`tab-overview`　HTML 行號：84–94　主要 render 函式：`loadOverview()`（第 288–329 行）+ `restartService()`（第 330–335 行）+ `fillServiceSelects()`（第 336–338 行）

---

## 1. 畫面結構

```
section#tab-overview
├─ div.section
│   ├─ h2  "服務 / Port（每 5 秒探測；「目前使用中」= 最近 <span id="win">5</span> 分鐘內有稽核紀錄的人）"
│   └─ div.grid#cards            ← 服務卡片牆（每個服務一張 .card，內容由 loadOverview() 動態產生，見第 3 節）
├─ div.two（第一組並排卡片）
│   ├─ div.card
│   │   ├─ h3  "Telegram Webhook"
│   │   └─ div#tg-webhook          ← 動態內容
│   └─ div.card
│       ├─ h3  "TG 連接名單"
│       └─ div#tg-summary          ← 動態內容
└─ div.two（第二組並排卡片）
    ├─ div.card
    │   ├─ h3  "背景 Pipeline 併發"
    │   └─ div#pipe-now            ← 動態內容
    └─ div.card
        ├─ h3  "最近狀態翻轉"
        └─ div#status-log.scroll   ← 動態內容
```

「服務 / Port」標題內的 `<span id="win">5</span>` 是動態值（來自 API 的 `activeWindowMin`），初始 HTML 寫死 `5` 只是佔位，實際渲染時被 `loadOverview()` 覆寫（見 3.1）。

---

## 2. 資料來源

| API | 方法 | 參數 | 呼叫時機 |
|---|---|---|---|
| `/api/overview` | GET | 無 | 進入分頁時（`refresh()` 判斷 `tab==='overview'` 即呼叫，見 `01-shell-and-shared.md` 第 5 節）；每 5 秒全域輪詢一次；點右上角「↻ 刷新」時 |
| `/api/status-log` | GET | 無 | 緊接在 `loadOverview()` 內部，同一次呼叫的最後一步（第 327 行），與 `/api/overview` 屬同一次刷新週期，同樣每 5 秒一次 |
| `/api/services/restart` | POST | body `{id: string}` | 使用者點某張服務卡片的「重啟」按鈕並確認 confirm 對話框後 |

`/api/overview` 回應結構（依 `server.ts` 第 60–89 行）：
```ts
{
  now: string, activeWindowMin: number,
  services: Array<{
    id, name, port, proxyPrefix, launchdLabel, hasAudit: boolean,
    probe: {status, detail, pid, latencyMs, uptimeSeconds} | null,
    lastStatusChange: {status, ts} | null,
    activeUsers: Array<{identity, n, last_ts, last_tool, source_ip}>,
    req1h: number | null, req24h: number | null, err24h: number | null,
    lastEvent: {ts, identity, tool, path, result} | null,
    rosterSize: number,
  }>,
  webhook: {ok, url, pendingUpdateCount, lastErrorMessage, lastErrorDate, ipAddress, checkedAt} | {ok:false, error},
  tgUsers: {connectedCount: number, pendingCount: number},
  pipelines: {
    running: Array<{kind, ticket, etime, pid, extra}>,
    queued: Array<{position, kind, ticket, enqueuedAt, triggeredBy}>,
    limitsSource: 'fallback' | string,
    bugSlots: {used, limit, queued}, demandSlots: {used, limit, queued},
    locks: Array<{ticket}>,
  },
}
```
`/api/status-log`（無參數版）回應：`{ rows: Array<{ts, service, status, detail}> }`（最新 200 筆，`ORDER BY id DESC`）。

`services`（模組層級全域陣列，第 279 行 `let services = []`）在 `loadOverview()` 內被賦值為 `d.services`（第 289 行），供 events/sessions 分頁的服務下拉選單（`fillServiceSelects()`）共用——這是本分頁對其他分頁的副作用：events/sessions 進入時若 `services` 為空會先觸發本分頁的 API 呼叫（見 `01-shell-and-shared.md` 5.1）。

---

## 3. 渲染邏輯

### 3.1 標題內的動態視窗分鐘數
`$('#win').textContent = d.activeWindowMin`（第 289 行）—— 後端常數 `ACTIVE_WINDOW_MIN`（`server.ts` 第 31 行值為 `5`），代表「目前使用中」的判定視窗。

### 3.2 服務卡片牆（`#cards`，第 291–305 行）

`d.services.map(s => ...)` 逐一產生一張 `.card`，欄位對應：

| 畫面元素 | 資料欄位 | 格式化方式 |
|---|---|---|
| 狀態圓點 `.dot` | `s.probe.status` | class 動態拼接 `dot ${p.status||''}`；`p.status==='up'` → 綠點發光，`'down'` → 紅點發光，其他值 → 灰點無發光 |
| 服務名稱 `.nm` | `s.name` | `esc()` 跳脫，超長截斷加省略號（CSS `.card h3 .nm`） |
| UP/DOWN 徽章 | `up = p.status==='up'` | `.pill.ok`+文字`UP` 或 `.pill.bad`+文字`DOWN` |
| 重啟按鈕（僅 `s.launchdLabel` 存在時顯示） | `s.launchdLabel` | `<button class="btn" onclick="restartService(id,name)" title="launchctl kickstart -k {label}">重啟</button>`，尺寸縮小（inline style `padding:3px 10px;font-size:14px`） |
| port 標籤 | `s.port` | `<span class="pill">port {port}</span>` |
| proxy 標籤（僅 `s.proxyPrefix` 存在時） | `s.proxyPrefix` | `<span class="pill">{esc(prefix)}</span>` |
| launchd 標籤（僅 `s.launchdLabel` 存在時） | `s.launchdLabel` | 顯示時把前綴 `com.aladdin.` 去掉（`.replace('com.aladdin.','')`），`title="launchd label"` |
| 「狀態」行（僅 `p.detail` 存在時） | `p.detail` | `<b class="{up?'ok':'err'}">{esc(detail)}</b>` —— 探測詳情文字，顏色隨 up/down 切換 |
| 「PID / 延遲」行 | `p.pid`、`p.latencyMs` | `{pid??'-'} / {latencyMs!=null?latencyMs+'ms':'-'}` |
| 「uptime」行 | `p.uptimeSeconds`、`s.lastStatusChange` | 用共用函式 `upt(p.uptimeSeconds)` 格式化；若有 `lastStatusChange` 則附加 `<span class="mute">({status} {ago(ts)})</span>` |
| 「請求 1h / 24h」行（僅 `s.hasAudit` 為真時顯示整段） | `s.req1h`、`s.req24h`、`s.err24h` | `{req1h} / {req24h} <span class="{err24h?'err':'mute'}">錯誤 {err24h}</span>` —— 有錯誤數時文字轉紅色，否則灰色 |
| 「最後事件」行（同上，僅 hasAudit） | `s.lastEvent` | `{identity||'-'} {tool||path||''} {ago(ts)}`；`s.lastEvent` 為 `null` 時整行顯示 `-` |
| 「名冊人數」行（同上，僅 hasAudit） | `s.rosterSize` | 原樣數字 |
| 使用者清單 `.users` | `s.hasAudit`、`s.activeUsers` | 見下方 3.2.1 |

**3.2.1 使用者清單三態邏輯**（第 293 行）：
1. `!s.hasAudit`（此服務無稽核 log）→ `<div class="mute" style="font-size:12.5px">（此服務無稽核 log，無法歸屬使用者）</div>`
2. `s.hasAudit && s.activeUsers.length===0`（有稽核但視窗內無人）→ `<div class="mute" style="font-size:12.5px">目前無人使用</div>`
3. `s.hasAudit && s.activeUsers.length>0` → 逐筆 `.user`：`<span class="who">{esc(identity)}</span><span class="meta">{n} req · {esc(last_tool||'')} · {ago(last_ts)}{source_ip?' · '+esc(source_ip):''}</span>`（`source_ip` 為空時不顯示該段）

排序：`activeUsers` 的順序由後端 SQL `ORDER BY last_ts DESC` 決定（`server.ts` `activeUsersStmt`），前端不重新排序。

### 3.3 Telegram Webhook 卡片（`#tg-webhook`，第 306–313 行）

`wh = d.webhook || {}`。

- **`wh.ok` 為真** → `.kv` 區塊：
  - 「URL」：`<b class="mono">{esc(url||'-')}</b>`（允許斷行）
  - 「待送達」：`pendingUpdateCount` — 非 0/真值時紅字（`err`），否則綠字（`ok`）；值本身 `??'-'`
  - 「上次錯誤」：有 `lastErrorMessage` 時顯示 `{esc(message)} <span class="mute">({fmt(date)} · {ago(date)}）</span>`；否則綠字 `無`
  - 「邊緣 IP」：`<b class="mono">{esc(ipAddress||'-')}</b>`
  - 下方附註（`.mute`，14px）：`查詢時間 {fmt(checkedAt)}（快取 30 秒）；「上次錯誤」只在真的有送達失敗時更新，修好後不會自動清空，時間比對照更重要`
- **`wh.ok` 為假** → `<div class="err">查詢失敗：{esc(wh.error||'unknown')}</div>`

### 3.4 TG 連接名單卡片（`#tg-summary`，第 314–318 行）

`tgu = d.tgUsers || {}`，`.kv` 區塊兩行：
- 「已連接」：`{connectedCount??'-'} <a href="#tg-connected" onclick="showTab('tg-connected');return false">查看</a>`
- 「待處理」：`<b class="{pendingCount?'err':''}">{pendingCount??'-'} <a href="#tg-pending" onclick="showTab('tg-pending');return false">查看</a></b>` —— 待處理數 > 0 時文字轉紅。

兩個「查看」連結都是程式化路由跳轉（呼叫 `showTab()` 並 `return false` 阻止 hash 的預設瀏覽器行為與 onclick 衝突）。這兩個目標分頁（`tg-connected`/`tg-pending`）不在本次拆解範圍內，重寫時仍需保留連結本身的可點擊行為。

### 3.5 背景 Pipeline 併發卡片（`#pipe-now`，第 319–326 行）

`pp = d.pipelines`，`queued = pp.queued || []`。

- 併發統計行（`.kv`）：
  - 「Bug /create-mr」：`{bugSlots.used} / {bugSlots.limit}`；若 `bugSlots.queued` 真值則附加 `<span class="pill warn">排隊 {n}</span>`；若 `pp.limitsSource==='fallback'` 則附加 `<span class="mute" title="啟動時讀不到 dispatcher 常數，顯示後備值">(後備值)</span>`
  - 「需求 pipeline」：同上結構，用 `demandSlots`
  - 「bug-lock」：`{locks.length ? locks.map(l=>esc(l.ticket)).join(', ') : '無'}`
- Running 表格（僅 `pp.running.length>0` 時顯示，否則 `<div class="mute" style="margin-top:8px">目前沒有背景 pipeline 在跑</div>`）：欄位「類型」「票號」「已跑」「PID」「附註」「」（操作欄）
  - 「類型」：`r.kind` 原樣（如 `bug`/`demand`）
  - 「票號」：`class="mono"`，`esc(r.ticket)`
  - 「已跑」：`class="mono"`，`esc(r.etime)`（後端 `ps` 指令輸出的 elapsed time 字串，前端不重新計算）
  - 「PID」：`class="mono"`，`r.pid` 原樣
  - 「附註」：僅 `r.kind==='demand'` 時顯示 `esc(r.extra)`，`bug` 類型顯示空字串
  - 操作欄：`cancelBtn(r.kind, r.ticket)`（第 515 行定義，見 4.3）
- Queued 表格（僅 `queued.length>0` 時顯示，否則不渲染任何內容）：欄位「排隊」「類型」「票號」「已等」「發起人」
  - 「排隊」：`#{q.position}`
  - 「已等」：`q.enqueuedAt ? dur(q.enqueuedAt, null) : '-'`（`dur` 的 `b` 傳 `null` 代表算到目前為止，見共用函式規格）
  - 「發起人」：`esc(q.triggeredBy||'')`

### 3.6 最近狀態翻轉卡片（`#status-log`，第 327–328 行）

呼叫 `/api/status-log`（無 `service` query param，取全部服務最新 200 筆）。

- `sl.rows.length>0` → 表格，只取前 30 筆（`sl.rows.slice(0,30)`，`server.ts` 已在 SQL 端 `LIMIT 200`，前端再截到 30 筆顯示）：欄位「時間」（`fmt(r.ts)`，mono）「服務」（`esc(r.service)`）「狀態」（`r.status`，`status==='up'` 綠字否則紅字）「detail」（`esc(r.detail||'')`，mono + mute）
- `sl.rows.length===0` → `<div class="mute">尚無紀錄</div>`

排序：依 API 回傳順序（`ORDER BY id DESC`，即最新在前），前端不重新排序。

---

## 4. 互動功能

### 4.1 服務卡片「重啟」按鈕（僅有 `launchdLabel` 的服務才顯示，第 294 行 `onclick="restartService('${id}','${name}')"`）

實作於 `window.restartService`（第 330–335 行）：
1. `confirm()` 對話框，文案：`確定要重啟「{name}」嗎？\n\n會執行 launchctl kickstart -k 重新拉起該 launchd job，服務會短暫離線幾秒。`
2. 使用者取消 → 直接 return，無任何動作。
3. 確認 → `POST /api/services/restart`，body `{id}`；失敗時（network 例外）自行 catch 成 `{ok:false, result:String(e)}`。
4. `alert()` 結果：成功 `已送出重啟：{result}`；失敗 `重啟失敗：{result}`。
5. 無論成功失敗，最後都呼叫 `refresh(true)` 強制重新整理當前分頁（會重新打 `/api/overview`，卡片狀態隨探測結果更新）。

### 4.2 「查看」連結（TG 連接名單卡片內，第 316–317 行）

- 「已連接」旁「查看」→ `showTab('tg-connected')`（跳到 TG 已連接分頁，非本次拆解範圍）。
- 「待處理」旁「查看」→ `showTab('tg-pending')`（跳到 TG 待處理分頁，非本次拆解範圍）。

### 4.3 Running Pipeline 表格「取消」按鈕（`cancelBtn`，第 515 行；`cancelPipeline` 定義在非本次範圍的 pipelines 區塊，第 423 行 API `POST /api/pipelines/cancel`）

按鈕文案固定為「取消」（`.btn.danger`），`onclick="cancelPipeline(kind, ticket)"`。此互動的完整行為（confirm 文案、成功/失敗處理）定義在 pipelines 分頁邏輯區（非本次 5 分頁拆解範圍），但**按鈕本身出現在總覽分頁的「背景 Pipeline 併發」卡片內**，重寫總覽分頁時仍需渲染此按鈕並綁定相同的 `onclick` 行為（否則使用者無法從總覽頁直接取消正在跑的 pipeline）。

### 4.4 `fillServiceSelects()`（第 336–338 行，由 `loadOverview()` 隱含觸發，非使用者直接互動）

```js
function fillServiceSelects(){
  for (const id of ['#ev-service','#ss-service']) {
    const sel=$(id); if (sel.options.length>1) continue
    services.filter(s=>s.hasAudit).forEach(s=>{ const o=document.createElement('option'); o.value=s.id; o.textContent=`${s.name} :${s.port}`; sel.appendChild(o) })
  }
}
```
每次 `loadOverview()` 都會呼叫，但只在對應下拉選單「還沒被填過」（`options.length>1`，即只剩預設的「全部服務」選項時）才會補上選項——避免重複輪詢時不斷 append 重複的 `<option>`。只有 `hasAudit` 為真的服務會出現在 events/sessions 分頁的服務篩選下拉中。選項文字格式：`{name} :{port}`（如 `agrabah-admin :4001`）。這個函式的輸出直接影響 `events.md`/`sessions.md` 的「全部服務」下拉選單內容，是總覽分頁對其他分頁的資料依賴來源。

---

## 5. 狀態與邊界

| 情境 | 畫面表現 |
|---|---|
| Webhook 查詢失敗 | `<div class="err">查詢失敗：{error}</div>`（3.3） |
| 服務無稽核 log | 使用者清單顯示「（此服務無稽核 log，無法歸屬使用者）」（3.2.1） |
| 有稽核但視窗內無人使用 | 「目前無人使用」（3.2.1） |
| 無背景 pipeline 在跑 | 「目前沒有背景 pipeline 在跑」（3.5） |
| 無排隊中的 pipeline | Queued 表格整段不渲染（無文案，直接空白） |
| 狀態翻轉紀錄為空 | 「尚無紀錄」（3.6） |
| `lastEvent` 為 `null` | 「最後事件」行顯示 `-` |
| `probe` 為 `null`（服務探測尚無資料） | `p = {}`（解構預設空物件），`up=false`，狀態點灰色 class 為空字串（既非 up 也非 down）、UP/DOWN 徽章顯示 DOWN（因 `up` 為 falsy）、PID/延遲/uptime 全部顯示 `-` |
| 首次載入（無先前資料） | 無 loading 骨架/spinner——`loadOverview()` 是單次 `await`，載入完成前畫面維持上一次渲染結果（或空白，若是頁面剛開啟第一次呼叫） |
| API 呼叫例外（network 錯誤） | 被 `refresh()` 外層 `try/catch` 吞掉，只 `console.error`，畫面不顯示任何錯誤提示、維持舊資料 |

---

## 6. 原始碼行號對照

| 內容 | 行號 |
|---|---|
| `<section id="tab-overview">` HTML | 84–94 |
| `loadOverview()` | 288–329 |
| `window.restartService` | 330–335 |
| `fillServiceSelects()` | 336–338 |
| `cancelBtn()`（背景 Pipeline 卡片用到） | 515 |
| 共用函式 `esc`/`fmt`/`ago`/`upt`/`resPill`/`api` | 271–278（見 `01-shell-and-shared.md` 第 4 節） |
| 全域輪詢 `setInterval(()=>refresh(false), 5000)` | 842 |
