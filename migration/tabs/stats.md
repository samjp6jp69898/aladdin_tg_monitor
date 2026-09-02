> ⚠️ 行號基準：本文件引用的 **server.ts 行號是舊快照，已不可直接使用**——後續多次改動讓漂移
> 變成非均勻的 53~91 行，先前「一律 +15」的指示已作廢。要查 server.ts 現行位置請以
> `migration/00-api-inventory.md`（行號已依現行檔案重新生成）為準。
> **index.html 的行號則是準確的歷史記錄**；該檔已於 2026-09-02 經使用者核准刪除，
> 需要對照原檔時：`git show 624ae25:public/index.html`。

# 分頁規格：歷史統計（stats）

route 值：`stats`　section id：`tab-stats`　HTML 行號：122–132　主要 render 函式：`loadStats()`（第 392–405 行）+ `barChart()`（第 370–389 行，共用 SVG 長條圖）

---

## 1. 畫面結構

```
section#tab-stats
├─ div.bar
│   ├─ select#st-days
│   │   ├─ option value="1"    "1 天"
│   │   ├─ option value="7" (selected)  "7 天"
│   │   ├─ option value="30"   "30 天"
│   │   └─ option value="365"  "1 年"
│   ├─ button#st-reload           "重算"
│   └─ span.mute#st-total          ← 動態文字："資料庫共 N 筆事件"
├─ div.section.card
│   ├─ h3  "近 24 小時每小時請求數"
│   └─ div.spark#st-spark          ← 動態內容（內嵌 SVG 長條圖）
├─ div.two                         ← 4 張卡片，2 欄 grid（超過 1000px 寬時 2x2 排列，否則單欄堆疊）
│   ├─ div.card
│   │   ├─ h3  "每日 × 服務"
│   │   └─ div.scroll#st-perday    ← 動態內容
│   ├─ div.card
│   │   ├─ h3  "使用者排行"
│   │   └─ div.scroll#st-ident     ← 動態內容
│   ├─ div.card
│   │   ├─ h3  "tool 排行（次數 / 錯誤 / 平均耗時）"
│   │   └─ div.scroll#st-tools     ← 動態內容
│   └─ div.card
│       ├─ h3  "認證失敗來源"
│       └─ div.scroll#st-auth      ← 動態內容
└─ div.card (style: margin-top:12px)
    ├─ h3  "Token 名冊（不含 token 值）"
    └─ div.scroll#st-roster        ← 動態內容
```

---

## 2. 資料來源

| API | 方法 | 參數 | 呼叫時機 |
|---|---|---|---|
| `/api/stats` | GET | `days`（來自 `#st-days`） | 首次進入分頁（全域 `refresh()`）；每 5 秒全域輪詢（**每次都重算，本分頁無「自動更新」開關**）；點「重算」按鈕；`#st-days` 變動（`onchange`） |
| `/api/rosters` | GET | 無 | 緊接在 `/api/stats` 之後，同一次 `loadStats()` 呼叫內（第 403 行），與 `/api/stats` 同步觸發（同上時機） |

`/api/stats` 回應結構（`server.ts` 第 182–193 行）：
```ts
{
  days: number,
  perDay: Array<{day: string, service: string, n: number}>,       // GROUP BY substr(ts,1,10)（UTC 日期）, service
  perHour: Array<{hour: string, n: number}>,                       // 近 24 小時，GROUP BY substr(ts,1,13)（UTC 到小時）
  topIdentities: Array<{identity, service, n, last_ts}>,           // 前 50 筆，ORDER BY last_ts DESC
  topTools: Array<{tool, service, n, errors, avg_ms}>,             // 前 50 筆，ORDER BY n DESC
  authFailures: Array<{service, source_ip, reason, n, last_ts}>,   // 前 50 筆，ORDER BY n DESC
  totalEvents: number,                                             // 全資料庫事件總數（不受 days 篩選）
}
```
`/api/rosters` 回應：`Array<{service: string, roster: Array<{id, display_name, issued_at}>}>`（只含有設定 `tokensPath` 的服務）。

---

## 3. 渲染邏輯

### 3.1 資料庫事件總數（`#st-total`，第 394 行）
```js
$('#st-total').textContent = `資料庫共 ${d.totalEvents} 筆事件`
```
注意：`totalEvents` 是**全資料庫**筆數，不受 `days` 篩選影響（後端 SQL 無 `WHERE`）。

### 3.2 近 24 小時每小時請求數（`#st-spark`，第 395–397 行）

```js
// 伺服器以 UTC 小時分組（ts 前 13 碼）；比對用 UTC key，顯示用本地時間
const hours=[...Array(24)].map((_,i)=>{
  const t=new Date(Date.now()-(23-i)*3600e3)
  const h=t.toISOString().slice(0,13)
  return {h, t, n:(d.perHour.find(x=>x.hour===h)||{}).n||0}
})
$('#st-spark').innerHTML = barChart(hours)
```
- 前端自行產生「過去 24 小時」的 24 個整點時間刻度（`i=0` 為 23 小時前，`i=23` 為當前小時），**不依賴後端回傳哪些小時有資料**——即使某小時完全沒事件，仍會補上 `n:0` 的刻度，確保 X 軸永遠是連續 24 格。
- 比對 key 用 UTC（`toISOString().slice(0,13)`，格式如 `2026-09-02T01`），因為後端 `perHour.hour` 也是用 UTC 字串分組；找不到對應小時的資料時 `n` 預設為 `0`。
- 顯示則用本地時間（`barChart()` 內用 `x.t.toLocaleString(...)`/`x.t.getHours()`）。

**`barChart(items)`（第 370–389 行）渲染規則**：
- 畫布尺寸：`W=1200, H=220`，內距 `padL=46, padR=12, padT=26, padB=34`。
- Y 軸刻度：`max = Math.max(1, ...items.map(x=>x.n))`；`step = max<=5 ? 1 : Math.ceil(max/4)`（依資料大小自動決定刻度間距，資料量小時每格 1，否則約分 4 格）；`top = Math.ceil(max/step)*step`（無條件進位到刻度倍數，作為 Y 軸最大值）。
- 每個 `step` 高度畫一條水平格線（`stroke="var(--line)"`）+ 左側刻度數字（`fill="var(--mute)"`，等寬字體 13px）。
- 每小時一根長條：寬度 `bw = (W-padL-padR)/24`，長條實際寬 `bw*0.7`（留 30% 間距），起始 x 偏移 `bw*0.15`（置中）；高度依 `n/top` 比例換算，`n===0` 時仍給最小高度保底可見（`Math.max(x.n?2:0,h)`——**注意：`n===0` 時 `x.n?2:0` 為 `0`，即完全無高度，不是「保底 2px」，只有 `n>0` 時才會保底至少 2px 高**）。
- 長條顏色：`fill="var(--acc)"`，`opacity` 依 `n` 是否為 0 決定：`n>0` → `0.85`（較實）、`n===0` → `0.25`（極淡，代表無資料的時段）。
- `n>0` 的長條上方標示數字（等寬字體 13px，`fill="var(--fg)"`）；`n===0` 不顯示數字。
- 每根長條下方 X 軸標示兩位數小時（`String(getHours()).padStart(2,'0')`，等寬字體 12px，`fill="var(--mute)"`）。
- Hover：每根長條包在 `<g class="bar">` 內附 `<title>{label} → {n} 次</title>`（原生瀏覽器 tooltip），`label` 格式為本地化的「月/日 時:00」（`toLocaleString('zh-TW',{hour12:false,month:'numeric',day:'numeric',hour:'2-digit'})+':00'`）；CSS `.spark .bar:hover rect` 使 hover 時該長條提亮（`opacity:1;filter:brightness(1.25)`）。
- 圖表右上角固定文字說明：「X 軸：本地時間（時）　Y 軸：請求數」（`fill="var(--mute)"` 12px）。

### 3.3 每日 × 服務（`#st-perday`，第 398–399 行）

```js
const days=[...new Set(d.perDay.map(x=>x.day))], svcs=[...new Set(d.perDay.map(x=>x.service))]
```
- 動態產生一個「日期 × 服務」交叉表：欄為去重後的服務清單（依 `perDay` 出現順序，非字母排序），列為去重後的日期清單，`days.reverse()`——即**最新日期在最上方**（`Set` 去重後原本是舊到新，`reverse()` 後變新到舊）。
- 表頭：第一欄「日期」，其餘欄為各服務名（`esc(s)`）。
- 每格：`(d.perDay.find(x=>x.day===day && x.service===s)||{}).n||''`——找不到對應日×服務的資料時顯示**空字串**（不是 `0` 或 `-`）。
- 無資料（`days.length===0`）→ `<div class="mute">無資料</div>`。

### 3.4 使用者排行（`#st-ident`，第 400 行）

逐筆 `d.topIdentities`：`<tr><td><b style="color:var(--acc)">{esc(identity)}</b></td><td>{esc(service)}</td><td class="mono">{n}</td><td class="mono mute">{ago(last_ts)}</td></tr>`。無表頭列（HTML 只用純 `<table>`，直接列資料列，沒有額外 `<tr>` 表頭）。空資料 → `<div class="mute">無資料</div>`。排序依 API 回傳順序（`ORDER BY last_ts DESC`）。

### 3.5 tool 排行（`#st-tools`，第 401 行）

逐筆 `d.topTools`：
| 欄位 | 資料 | 格式化 |
|---|---|---|
| 1 | `r.tool` | `.mono`，`esc(tool)` |
| 2 | `r.service` | `esc(service)` |
| 3 | `r.n` | `.mono`，原樣 |
| 4 | `r.errors` | `.mono {errors?'err':''}`——有錯誤數時紅字 |
| 5 | `r.avg_ms` | `.mono.mute`，`{avg_ms??'-'}ms` |
| 6 | — | 連結：`r.errors` 真值時文字「看錯誤」，否則「看事件」；`onclick="jumpEventsQuery(service, tool, errors?true:false)"` |

無表頭列。空資料 → `<div class="mute">尚無 tool 呼叫</div>`。排序依 API 回傳順序（`ORDER BY n DESC`，次數最多在前）。

### 3.6 認證失敗來源（`#st-auth`，第 402 行）

逐筆 `d.authFailures`：
| 欄位 | 資料 | 格式化 |
|---|---|---|
| 1 | `r.service` | `esc(service)` |
| 2 | `r.source_ip` | `.mono`，`esc(source_ip||'')` |
| 3 | `r.reason` | `.mono.err`（固定紅字），`esc(reason||'')` |
| 4 | `r.n` | `.mono`，原樣 |
| 5 | `r.last_ts` | `.mono.mute`，`ago(last_ts)` |
| 6 | — | 連結「看事件」，`onclick="jumpEventsQuery(service, source_ip||'', true)"`（固定帶 `errorsOnly=true`） |

無表頭列。空資料 → `<div class="ok">期間內無認證失敗</div>`（**注意這是唯一用綠色 `.ok` 而非灰色 `.mute` 的空狀態**，語意上「無認證失敗」是好消息）。排序依 API 回傳順序（`ORDER BY n DESC`）。

### 3.7 Token 名冊（`#st-roster`，第 404 行）

```js
'<table><tr><th>服務</th><th>id</th><th>display_name</th><th>核發時間</th></tr>'
+ ro.flatMap(x=>x.roster.map(t=>`<tr><td>${esc(x.service)}</td><td class="mono">${esc(t.id)}</td><td>${esc(t.display_name)}</td><td class="mono mute">${fmt(t.issued_at)}</td></tr>`)).join('')
+'</table>'
```
- **唯一有明確 `<tr><th>...</th></tr>` 表頭列的統計卡片**（其他 4 張卡片都沒有表頭列，只靠 `.card h3` 標題暗示欄位語意）。
- `ro`（`/api/rosters` 回應）用 `flatMap` 攤平成「每個 token 一列」，欄位：服務 id、token id（`.mono`）、display_name、核發時間（`fmt`，`.mono.mute`）。
- **沒有空資料分支**——`ro` 若整體為空陣列，`flatMap` 結果為空字串，畫面呈現只有表頭列、無資料列的空表格（不會顯示「無資料」文案）。

### 3.8 排序總結

所有子表格皆完全依賴 API 回傳順序，前端不做任何 `sort()`；唯一前端排序動作是「每日 × 服務」的 `days.reverse()`（3.3）。

---

## 4. 互動功能

| 元件 | 觸發方式 | 行為 |
|---|---|---|
| `select#st-days` | `onchange` | `loadStats()`（重新打 `/api/stats?days=N`） |
| `button#st-reload`（"重算"） | `onclick` | `loadStats()` |
| tool 排行表每列的「看錯誤」/「看事件」連結 | `onclick="jumpEventsQuery(service, tool, errorsOnly)"` | `window.jumpEventsQuery`（第 366 行，見 `01-shell-and-shared.md` 3.4）：設定 events 分頁的 `#ev-service`=service、`#ev-q`=tool（清空 `#ev-identity`）、`#ev-errors`=errorsOnly、`#ev-tool-only`=false，再 `showTab('events')` 跳轉 |
| 認證失敗來源表每列的「看事件」連結 | `onclick="jumpEventsQuery(service, source_ip, true)"` | 同上函式，`q` 填入來源 IP，`errorsOnly` 固定 `true` |
| 長條圖（每根 bar） | hover | 顯示原生 `<title>` tooltip：`{月/日 時:00} → {n} 次` |

無任何 confirm/alert 對話框（唯讀分頁）。

---

## 5. 狀態與邊界

| 情境 | 畫面表現 |
|---|---|
| 「每日 × 服務」查無資料 | 「無資料」（灰字，3.3） |
| 「使用者排行」查無資料 | 「無資料」（灰字，3.4） |
| 「tool 排行」查無資料 | 「尚無 tool 呼叫」（灰字，3.5） |
| 「認證失敗來源」查無資料 | 「期間內無認證失敗」（**綠字**，3.6，唯一正向語意的空狀態） |
| Token 名冊為空 | 只顯示表頭列，無提示文案（3.7 的已知限制） |
| 某小時完全無事件 | 長條圖該格仍顯示（`n=0`），長條高度為 0（無保底最小高度）、`opacity:0.25` 淡色、不顯示數字標籤，但仍有 X 軸小時刻度 |
| API 呼叫例外 | 透過 `refresh()` 觸發時被外層 `try/catch` 吞掉，畫面維持舊資料 |
| 首次載入 | 無 loading 骨架/spinner |

---

## 6. 原始碼行號對照

| 內容 | 行號 |
|---|---|
| `<section id="tab-stats">` HTML | 122–132 |
| `barChart(items)`（共用長條圖函式） | 370–389 |
| `loadStats()` | 392–405 |
| 重算鈕/天數變更綁定 | 406 |
| `window.jumpEventsQuery`（見 `01-shell-and-shared.md` 3.4） | 366 |
| 共用函式 `esc`/`fmt`/`ago` | 271–274（見 `01-shell-and-shared.md` 第 4 節） |
| `refresh()` 對 stats 分頁的輪詢邏輯 | 831 |
