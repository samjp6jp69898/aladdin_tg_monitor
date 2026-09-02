# 歷史統計分頁 — Parity 對照表

實作範圍：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/StatsPage.tsx`（單檔，未拆子元件——五張表 + 一個長條圖都直接靠共用 `DataTable` / `SparkBarChart` 表達，沒有需要另外封裝的頁面私有邏輯，Rule 2/3 判斷不需額外拆分）

規格依據：`migration/tabs/stats.md`（畫面結構 §1、資料來源 §2、渲染邏輯 §3、互動功能 §4、狀態與邊界 §5）、`migration/02-frontend-contract.md`、`migration/03-shared-layer-patch.md`。

---

## 1. 互動功能對照表（stats.md §4，5 項）

| # | 規格項目 | 實作位置 |
|---|---|---|
| 1 | `select#st-days` `onchange` → `loadStats()`（重打 `/api/stats?days=N`） | `StatsPage.tsx:132-137`：`<select value={days} onChange={e => setDays(Number(e.target.value))}>`。`days` 是 `useResource(topics.stats, { days })` 的 params（`StatsPage.tsx:26`），改變後 `useResource` 依 `JSON.stringify(params)` 偵測差異自動重打 `/api/stats`，效果等同呼叫 `loadStats()`。 |
| 2 | `button#st-reload`（"重算"）`onclick` → `loadStats()` | `StatsPage.tsx:138`：`<Button onClick={handleReload}>重算</Button>`；`handleReload`（`StatsPage.tsx:29-31`）同時 `stats.reload()` 與 `rosters.reload()`，對應舊版 `loadStats()` 單次呼叫內同時重打 `/api/stats` 與 `/api/rosters`（stats.md §2）。 |
| 3 | tool 排行表每列「看錯誤」/「看事件」連結 `onclick="jumpEventsQuery(service, tool, errorsOnly)"` | `StatsPage.tsx:82-93`：`<a href={eventsPath({service:r.service,q:r.tool,errors:!!r.errors})} onClick={e=>{e.preventDefault(); navigate(eventsPath({...}))}}>`；`errors: !!r.errors` 對應 `errorsOnly=r.errors?true:false`；文字依 `r.errors` 在「看錯誤」/「看事件」間切換，與規格一致。`eventsPath()` 未帶 `identity`/`toolOnly`，等效舊版 `jumpEventsQuery` 明確清空 `#ev-identity`、`#ev-tool-only`（因為目標頁 `EventsPage` 用 `useSearchParams()` 讀值，沒帶的 query 参数即為預設空/false）。 |
| 4 | 認證失敗來源表每列「看事件」連結 `onclick="jumpEventsQuery(service, source_ip, true)"` | `StatsPage.tsx:106-116`：`<a href={eventsPath({service:r.service,q:r.source_ip||'',errors:true})} onClick={...}>看事件</a>`，`errors` 固定 `true`，`q` 帶 `source_ip||''`，與規格一致。 |
| 5 | 長條圖每根 bar hover 顯示原生 `<title>` tooltip | 由共用 `SparkBarChart` 元件負責（`components/shared/SparkBarChart.tsx:74`：`<title>{`${label} → ${x.n} 次`}</title>`），`StatsPage.tsx:143` 只需傳入 `items={hours}`，元件內部已完整重現舊版 `barChart()` 的座標/刻度/顏色/tooltip 演算法。 |

**5/5 對應完成。**

無任何 confirm/alert 對話框（唯讀分頁）——與規格「無任何 confirm/alert 對話框」一致，程式碼中沒有任何 `window.confirm`/`window.alert` 呼叫。

**額外說明（設計差異，非缺陷）**：舊版 `#st-days` 的 `onchange` 明確呼叫一次 `loadStats()`（內含 stats + rosters 兩支 API）；新版把 `days` 直接綁進 `topics.stats` 的 `params`，改變即自動重查 `/api/stats`，但**不會**連帶重打 `/api/rosters`（因為 roster 內容不受 `days` 篩選影響，重打與否對畫面結果無可觀察差異）。`topics.rosters` 自己維持獨立的全域 5 秒輪詢（`useResource` 預設 `autoRefresh: true`），所以即使不隨 `days` 變動重打，也會在下一輪全域輪詢內自然同步，效果等效。

---

## 2. 渲染欄位對照表（stats.md §3，含長條圖與 6 張卡片）

### 2.1 `#st-total`（stats.md §3.1）

| 規格 | 實作 |
|---|---|
| `資料庫共 ${d.totalEvents} 筆事件`，`totalEvents` 為全資料庫筆數，不受 `days` 篩選 | `StatsPage.tsx:139`：`{stats.data ? `資料庫共 ${stats.data.totalEvents} 筆事件` : ''}`；直接讀 `StatsResponse.totalEvents`，未對其做任何篩選運算，與後端「無 WHERE」語意一致。首次資料尚未回來時顯示空字串，對應舊版腳本尚未執行完成前 `<span>` 是空的（無 loading 文案）。 |

### 2.2 近 24 小時每小時請求數（stats.md §3.2，見圖表節）

見本文件末「圖表如何用 SparkBarChart 呈現」一節。

### 2.3 每日 × 服務（stats.md §3.3）

| 規格行為 | 實作位置 |
|---|---|
| 欄＝去重服務清單（依出現順序），列＝去重日期清單 `reverse()`（最新在最上方） | `StatsPage.tsx:43-44`：`[...new Set(perDayRows.map(x=>x.day))].reverse()`／`[...new Set(perDayRows.map(x=>x.service))]`，未排序，維持 `Set` 插入順序，與規格一致 |
| 表頭：第一欄「日期」，其餘欄為各服務名 | `StatsPage.tsx:47-56`：`perDayColumns` 第一欄 `key:'day', header:'日期'`，其餘由 `perDayServices.map()` 動態產生（`header: s`）。**本頁對此表採 `showHeader` 預設值 `true`**（見下方「已知文件內部落差」說明） |
| 每格：找不到對應日×服務資料時顯示空字串（非 `0`/`-`） | `StatsPage.tsx:45`：`perDayRows.find(...)?.n \|\| ''`——找不到（`undefined?.n` → `undefined`）或 `n` 本身為 `0`（falsy）都會落到 `\|\| ''`，與規格 `(...||{}).n||''` 完全一致 |
| 無資料（`days.length===0`）→「無資料」 | `StatsPage.tsx:148`：`emptyText="無資料" emptyMode="replace"` |

### 2.4 使用者排行（stats.md §3.4）

| 欄 | 規格格式化 | 實作位置 |
|---|---|---|
| 使用者 | `<b style="color:var(--acc)">{esc(identity)}</b>` | `StatsPage.tsx:60`：`<b style={{color:'var(--acc)'}}>{r.identity}</b>`（React 自動跳脫，等效 `esc`） |
| 服務 | 原樣 | `StatsPage.tsx:61` |
| 次數 | `.mono` | `StatsPage.tsx:62` |
| 最後出現 | `.mono.mute`，`ago(last_ts)` | `StatsPage.tsx:63` |

無表頭（`showHeader={false}`，`StatsPage.tsx:155`），空資料 →「無資料」（`StatsPage.tsx:156-157`），排序依 API（`ORDER BY last_ts DESC`，前端未 `sort()`）。

### 2.5 tool 排行（stats.md §3.5）

| 欄 | 規格格式化 | 實作位置 |
|---|---|---|
| tool | `.mono` | `StatsPage.tsx:68` |
| service | 原樣 | `StatsPage.tsx:69` |
| n | `.mono` | `StatsPage.tsx:70` |
| errors | `.mono {errors?'err':''}` | `StatsPage.tsx:71-77`：`className:'mono'` + `cellClassName: r=>r.errors?'err':undefined`，`DataTable` 合併成 `class="mono err"` |
| avg_ms | `.mono.mute`，`{avg_ms??'-'}ms` | `StatsPage.tsx:78`：`` `${r.avg_ms ?? '-'}ms` ``（`??` 只擋 null/undefined，`0` 會顯示 `0ms`，與規格一致） |
| 操作欄 | 「看錯誤」/「看事件」連結 | `StatsPage.tsx:79-93`（見互動表第 3 項） |

無表頭（`StatsPage.tsx:165`），空資料 →「尚無 tool 呼叫」（`StatsPage.tsx:166-167`），排序依 API（`ORDER BY n DESC`）。

### 2.6 認證失敗來源（stats.md §3.6）

| 欄 | 規格格式化 | 實作位置 |
|---|---|---|
| service | 原樣 | `StatsPage.tsx:98` |
| source_ip | `.mono`，`esc(source_ip||'')` | `StatsPage.tsx:99`：`r.source_ip \|\| ''` |
| reason | `.mono.err`（固定紅字） | `StatsPage.tsx:100`：`className:'mono err'`（固定，非依 row 判斷） |
| n | `.mono` | `StatsPage.tsx:101` |
| last_ts | `.mono.mute`，`ago(last_ts)` | `StatsPage.tsx:102` |
| 操作欄 | 「看事件」，`errorsOnly` 固定 `true` | `StatsPage.tsx:103-117`（見互動表第 4 項） |

無表頭（`StatsPage.tsx:175`），空資料 →「期間內無認證失敗」**綠字**（`StatsPage.tsx:176-177`：`emptyText="期間內無認證失敗" emptyTone="ok"`），排序依 API（`ORDER BY n DESC`）。

### 2.7 Token 名冊（stats.md §3.7）

| 欄 | 規格格式化 | 實作位置 |
|---|---|---|
| 服務 | 原樣 | `StatsPage.tsx:123` |
| id | `.mono` | `StatsPage.tsx:124` |
| display_name | 原樣 | `StatsPage.tsx:125` |
| 核發時間 | `.mono.mute`，`fmt(issued_at)` | `StatsPage.tsx:126`：`fmt(r.issued_at)` |

明確表頭列 `<tr><th>服務</th><th>id</th><th>display_name</th><th>核發時間</th></tr>`（`showHeader` 預設 `true`，`StatsPage.tsx:185` 未覆寫）；資料來源 `rosterRows = (rosters.data??[]).flatMap(x=>x.roster.map(t=>({...t,service:x.service})))`（`StatsPage.tsx:121`），對應舊版 `ro.flatMap(x=>x.roster.map(t=>...))`。**沒有空資料分支**——見下方「未達成項目」的說明。

### 2.8 排序總結

所有子表格皆完全依賴 `stats.data`/`rosters.data` 的 API 回傳順序，程式碼中沒有任何 `.sort()`；唯一前端排序動作是每日 × 服務的 `.reverse()`（`StatsPage.tsx:43`），與規格 §3.8 一致。

---

## 3. 圖表如何用 SparkBarChart 呈現

`StatsPage.tsx` 只負責依規格 §3.2 產生 24 個整點刻度（UTC key 比對、`n` 找不到時補 `0`），實際 SVG 長條圖演算法（尺寸/刻度/顏色/opacity/tooltip）完全交給共用元件 `SparkBarChart`（`src/components/shared/SparkBarChart.tsx`），本頁不自行另寫圖表邏輯：

```tsx
// StatsPage.tsx:34-39
const perHour = stats.data?.perHour ?? []
const hours: SparkBarItem[] = Array.from({ length: 24 }, (_, i) => {
  const t = new Date(Date.now() - (23 - i) * 3600e3)
  const h = t.toISOString().slice(0, 13)
  return { t, n: perHour.find(x => x.hour === h)?.n ?? 0 }
})
```

```tsx
// StatsPage.tsx:142-144
<Card className="section" title="近 24 小時每小時請求數">
  <SparkBarChart items={hours} />
</Card>
```

`SparkBarChart` 的尺寸（`W=1200 H=220`）、`step`/`top` 刻度演算法、`n===0` 時高度為 0（非保底 2px）、`opacity` 0.25/0.85、hover `<title>` 文字格式，皆已在共用層實作並照舊版 `barChart()` 逐行比對過（見 `03-shared-layer-patch.md` 與 `SparkBarChart.tsx` 檔頭註解），本頁直接信任共用層，未再重複驗證或覆寫。

---

## 4. 狀態與邊界對照（stats.md §5）

| 情境 | 規格畫面表現 | 實作 |
|---|---|---|
| 「每日 × 服務」查無資料 | 「無資料」（灰字） | `StatsPage.tsx:148`：`emptyText="無資料"`（`emptyTone` 預設 `'mute'`） |
| 「使用者排行」查無資料 | 「無資料」（灰字） | `StatsPage.tsx:156-157` |
| 「tool 排行」查無資料 | 「尚無 tool 呼叫」（灰字） | `StatsPage.tsx:166-167` |
| 「認證失敗來源」查無資料 | 「期間內無認證失敗」（**綠字**，唯一正向語意的空狀態） | `StatsPage.tsx:176-177`：`emptyTone="ok"` |
| Token 名冊為空 | 只顯示表頭列，無提示文案 | 近似實作，見「未達成項目」 |
| 某小時完全無事件 | 長條圖該格仍顯示（`n=0`），高度為 0、`opacity:0.25`、不顯示數字、仍有 X 軸刻度 | 由 `SparkBarChart` 共用元件保證（見上節），本頁只需確保 `hours` 陣列總是 24 筆、含 `n:0` 的格子（`StatsPage.tsx:35-39` 用 `Array.from({length:24}...)` 保證） |
| API 呼叫例外 | 透過 `refresh()` 觸發時被外層 `try/catch` 吞掉，畫面維持舊資料 | `StatsPage.tsx` 未讀取 `stats.error`/`rosters.error`、未渲染任何錯誤訊息；`useResource` 失敗時只更新內部 `error` state 並保留既有 `data`（`hooks/useResource.ts:93-96`），畫面自然維持上次成功取得的資料，效果等同舊版靜默吞例外 |
| 首次載入 | 無 loading 骨架/spinner | `StatsPage.tsx` 未針對 `stats.loading`/`rosters.loading` 渲染任何骨架/spinner；各表格在 `data` 為 `null` 時吃到 `rows={[]}` fallback，短暫顯示對應空狀態文案直到第一批資料回來，與舊版初始空 `div` 效果一致 |

---

## 5. 已知的規格內部落差（實作時的取捨依據，非缺陷）

`02-frontend-contract.md` §4 DataTable 能力清單第 2 點把「每日 × 服務」與另外三張排行表一併列為 `showHeader={false}` 範例，但 `stats.md §3.3` 逐行對照舊版原始碼 `'<table><tr><th>日期</th>'+svcs.map(s=>...)+'</tr>'+...`，以及 `stats.md §3.7`（「Token 名冊」段落自陳「**唯一有明確 `<tr><th>...</th></tr>` 表頭列的統計卡片**」）都明確指出「每日 × 服務」實際上**有**表頭列，只有「使用者排行／tool 排行／認證失敗來源」這 3 張才是真正無表頭。已對照 `public/index.html`（只讀，第 398-399 行 `loadStats()` 內的 `$('#st-perday').innerHTML=...`）確認原始碼行為與 `stats.md §3.3`/`§3.7` 一致，`02-frontend-contract.md §4` 該行摘要文字有誤。本次實作依「每日 × 服務」`showHeader` 預設 `true`（有表頭）、其餘三張排行表 `showHeader={false}`（無表頭）處理，與 source-of-truth（`index.html` + `stats.md` 細節段落）一致。未回報 SHARED_LAYER_GAPS，因為這不是 `DataTable` 元件能力缺口，只是契約摘要行文字與細節規格不一致，`showHeader` 本身可自由選填 true/false，兩種用法元件都已支援。

---

## 6. 未達成項目

1. **Token 名冊為空時的「無空資料分支」語意未 100% 精確重現**（`stats.md §3.7`／§5：`ro` 整體為空陣列時，舊版畫面應只有表頭列、完全沒有額外的資料列或提示文字）。共用 `DataTable` 元件的 `emptyText` 是必填 `string`，且 `rows=[]` 時一定會在 `<tbody>` 內渲染一個 `<tr><td colSpan className={emptyTone}>{emptyText}</td></tr>`（`components/shared/DataTable.tsx:108-113`），沒有「完全不渲染任何空狀態列」的選項。本頁以 `emptyText=""`（`StatsPage.tsx:185`）取最接近的近似：會多一個視覺上幾乎不可見的空白列（無文字、`class="mute"` 但內容為空），而非規格描述的「完全沒有多餘列」。這是 `DataTable` 目前的能力邊界，不在本頁允許修改的共用層範圍內，故列為 SHARED_LAYER_GAPS 回報而非自行繞過。此邊界案例只會在「所有服務都沒有設定 tokensPath」時觸發（正常環境下 roster 幾乎不會整體為空），對日常畫面比對影響極小。

其餘 5 項互動功能、全部渲染欄位、8 種狀態/邊界皆已對應完成。

---

RESULT: DONE
TSC: PASS
PARITY_DOC: /Users/user/aladdin/tg-monitor/migration/review/parity-stats.md
SHARED_LAYER_GAPS: DataTable 的 `rows=[]` 時一定會渲染一個 `<tr><td colSpan>{emptyText}</td></tr>`（無法完全不渲染任何空狀態列），導致 stats 分頁「Token 名冊」規格要求的「查無資料時只留表頭列、無任何額外列」無法 100% 精確重現，只能用 `emptyText=""` 近似（見本文件 §6 第 1 項）。建議：`DataTable` 可考慮新增類似 `emptyMode: 'none'`（rows 為空時完全不渲染任何列，含表頭下方的 tbody）的選項，但這是建議、非本次必須修復項。
UNDONE: none
