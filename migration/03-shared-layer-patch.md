# 共用層缺口修補紀錄（2026-09-02）

第一波 5 個分頁（OverviewPage、PipelinesPage、TokensPage、LogsPage、WorkersPage）各自撞到下列
6 個共用層缺口、用頁面私有繞法擋著。本次修補全部補回共用層，第二波 6 個分頁不必再各自繞。

原則：只做加法，新增 optional prop / 補型別欄位，不改既有 prop 語意（除非該語意本身就是 parity
缺陷）。改完 `bunx tsc --noEmit -p tsconfig.app.json` 與 `bun run build` 皆通過。

---

## A1. `src/hooks/useLogFollow.ts` — 缺 log 截斷/輪替偵測

**成因**：即時跟隨迴圈（1500ms）拿到新 `offset` 時，未檢查新 offset 是否小於前一次 offset。
後端 `/api/log/since`（server.ts:789-804）偵測到請求 offset 大於檔案目前大小時會把 offset 重設為
0 回傳，代表 log 檔被截斷或輪替過；舊版 `index.html:751`（`if (r.offset < lgOffset) out.textContent
= ''`）依此清空畫面重新累積，新版原本直接把新內容接在舊內容後面，畫面會錯亂（看到不連續的內容併在
一起）。

**改法**（`useLogFollow.ts` 第 107-113 行附近）：

```ts
res => {
  // 對應舊版 index.html:751：新 offset 小於前一次代表 log 檔被截斷/輪替，清空重新開始。
  if (res.offset < offsetRef.current) setText('')
  offsetRef.current = res.offset
  setOffset(res.offset)
  if (res.text) setText(prev => prev + res.text)
},
```

**影響到哪些呼叫端**：只有 `LogsPage`（唯一使用 `useLogFollow` 的頁面）。行為修正，無需改呼叫端程式碼。

---

## A2. `src/components/shared/LogViewer.tsx` — autoScroll 太粗暴

**成因**：`autoScroll` 開啟時，每次 `text` 變動都無條件 `scrollTop = scrollHeight`。舊版行為
（`index.html:753`）只在「使用者當前已經在底部附近（40px 容忍）」時才自動捲動——否則使用者往上翻看
歷史內容時，每 1500ms 的即時跟隨輪詢就會把畫面強制拉回底部，打斷閱讀。

同時舊版對「初次載入 / 整批替換」（`loadLog()` 首次載入，或本次順帶修的截斷重來）與「單純追加新內容」
（即時跟隨 timer 內）是兩種不同的捲動邏輯：前者一律捲到底（`index.html:744`，不受 atBottom 門檻限
制），後者才受 40px atBottom 門檻限制（`index.html:751-753`）。`LogViewer` 是純呈現元件，不知道呼叫
端是哪種情境，因此用「新文字是否為舊文字的延伸（`startsWith` 且更長）」來判斷目前是純追加還是整批替
換，重現這兩種語意。

**改法**（`LogViewer.tsx`）：

```tsx
const handleScroll = () => {
  const el = ref.current
  if (!el) return
  atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

useEffect(() => {
  const el = ref.current
  if (autoScroll && el) {
    const isAppend = text.length > prevTextRef.current.length && text.startsWith(prevTextRef.current)
    if (!isAppend || atBottomRef.current) el.scrollTop = el.scrollHeight
  }
  prevTextRef.current = text
}, [text, autoScroll])
```

`atBottomRef` 由新增的 `onScroll` handler（僅 `autoScroll` 開啟時掛上）持續追蹤，反映使用者上一次
互動後的捲動位置，避免用「更新後才讀到的 DOM 狀態」誤判。

**依據**：`tabs/logs.md` §3.2（`out.scrollTop=out.scrollHeight` 初次載入無條件執行）與 §3.3（`atBottom`
40px 判定式）；對照 `index.html:744` 與 `751-753`（只讀，未修改）。

**影響到哪些呼叫端**：`LogsPage`（`autoScroll={follow}`，行為修正，無需改呼叫端）。`AgentConversationCard`
與 `WorkerDetail` 的 `LogPre` 未傳 `autoScroll`（預設 false），不受影響。

---

## B1. `src/api/types.ts` 的 `PipelineRunDetailResponse['run']` 漏欄位

**成因**：`server.ts` 的 `GET /api/pipelines/run` handler（server.ts:342-377，見下方證據）呼叫
`attachAgentRuns(siblings)` 後，直接把該筆 `me`（也就是回傳的 `run`）整包塞進
`c.json({ run: me, ... })`。`attachAgentRuns()`（server.ts:219-236）會替每一列掛上 `agents[]` /
`agent_count` / `total_input` / `total_output` / `total_cost`，只有 `GET /api/pipelines` 列表端點
才會在回傳前 `delete r.agents`（server.ts:251，只留彙總欄）。`GET /api/pipelines/run` 完全沒有這個
delete，所以 `run.agents` 與四個彙總欄實際上一定存在（無條件賦值，即使是空陣列/0）。但
`src/api/types.ts` 原本把 `PipelineRunDetailResponse['run']` 宣告成 `PipelineRunBase & { running:
boolean }`，漏了這 5 個欄位；`00-api-inventory.md` 對這支端點的文件敘述也寫反了（誤植成「不含彙總
欄」）。

**server.ts 證據**：

```
219:function attachAgentRuns(rows: any[]) {
...
342:app.get('/api/pipelines/run', async c => {
...
347:  attachAgentRuns(siblings)
348:  const me = siblings.find(r => r.key === key)
```

`/api/pipelines/run` 的 handler 內、`/api/pipelines`（server.ts:251 `delete r.agents`）唯一有這行
刪除；`/api/pipelines/run` 沒有對應的刪除語句，最終 `return c.json({ run: me, progress, stages })`
把完整的 `me`（含 `agents`/`agent_count`/`total_input`/`total_output`/`total_cost`）回傳。

（注：`tabs/logs.md` 開頭記載 2026-09-02 新增 `/next/*` 靜態路由在 server.ts 第 44 行後插入 15
行，故本節指的行號一律是**現版** server.ts 行號，即含 `+15` offset 後的行號。）

**改法**：

1. `src/api/types.ts` 新增 `AgentRunRow`（agent_runs 表一列，`lib/db.ts:66-82`）介面，並把
   `PipelineRunDetailResponse['run']` 改成
   `PipelineRunBase & { running: boolean; agents: AgentRunRow[]; agent_count: number; total_input:
   number; total_output: number; total_cost: number }`（非 optional，因為
   `attachAgentRuns()` 對每列無條件賦值）。同時修正 `PipelineRun` 介面上方過時的註解（原本說
   `/api/pipelines/run` 的 `run` 沒有彙總欄，已更正為說明兩者彙總欄一致、`run` 只是多了
   `agents[]` 本體）。
2. `00-api-inventory.md` 的 `GET /api/pipelines/run` 小節與「給下游 agent 的重點提醒」第 4 點都已
   更新，並各加一行 `2026-09-02 修正` 註記說明原文漏列 `agents`/`agent_count`/`total_input`/
   `total_output`/`total_cost`（第 4 點原文甚至寫反方向）。
3. `src/pages/pipelines/types.ts` 原本的本地 workaround 型別（`AgentRunRow` 重複定義、
   `PipelineRunWithAgents` 局部型別、`Omit<PipelineRunDetailResponse,'run'> & {...}` 組合）已刪除，
   改成直接 `export type { AgentRunRow } from '../../api/types'` 與
   `export type PipelineRunDetail = PipelineRunDetailResponse` 兩行 re-export，型別回到單一來源。
   `PipelineDetailView.tsx`、`AgentConversationCard.tsx` 等呼叫端的 import 路徑未變（仍從
   `./types` 匯入），不需改動。

**影響到哪些呼叫端**：`src/pages/pipelines/PipelineDetailView.tsx`（`r?.agents`、
`r?.total_input`/`r?.total_output` 等既有的 `?? []`/`?? 0` 防呆寫法保持相容，欄位改為非 optional
不影響既有的可選鏈語法）；`AgentConversationCard.tsx` 不受影響（用的是 `AgentTraceResponse`，非本次
改動的型別）。

---

## C1. `src/components/shared/Badge.tsx` — 新增 `style` prop

**成因**：呼叫端原本只能用外層 `<span style={{marginLeft:'auto'}}>` 包裹 `Badge` 才能做版面調整。

**改法**：新增 optional `style?: React.CSSProperties`，直接透傳到內層 `<span>`（與既有 `className`
並存，不互相取代）。未傳 `style` 時行為與之前完全一致。

**影響到哪些呼叫端**：無強制修改；第一波頁面若有用外層 `<span>` 包裹 `Badge` 的繞法，維持不動（等
效，改動只會增加風險，符合驗收條件「不需要回頭改」）。第二波頁面可直接用新 `style` prop。

---

## C2. `src/components/shared/DataTable.tsx` — `Column` 新增 per-cell inline style

**成因**：`Column` 定義只有 `className`，沒有依 row 動態算 inline style 的能力。

**改法**：新增 optional `cellStyle?: CSSProperties | ((row: T, index: number) => CSSProperties |
undefined)`，命名與型別設計比照既有 `cellClassName`（同樣支援固定值或 per-row function）。渲染時
與既有 `align` 算出的 `alignStyle` 合併（`cellStyle` 覆寫同名屬性，`textAlign` 之外的屬性不受影
響）：

```tsx
const cellStyle = typeof c.cellStyle === 'function' ? c.cellStyle(row, i) : c.cellStyle
const style = cellStyle ? { ...alignStyle(c.align), ...cellStyle } : alignStyle(c.align)
```

**影響到哪些呼叫端**：無強制修改，純加法；未傳 `cellStyle` 的既有 `<td>` 渲染結果不變。

---

## C3. `src/components/shared/LogViewer.tsx` — 新增 `maxHeight` prop

**成因**：舊版 `pre.log` 在 workers 詳情頁三處用 `height:auto;max-height:30vh`，pipelines 的
Prompt/rawStdout 用 `height:auto;max-height:40vh`，共用 `LogViewer` 原本只有單一 `height` 覆寫，
表達不出這種「auto + 上限」組合，兩處各自用私有繞法（`WorkerDetail.tsx` 的 `LogPre` 手刻
`<pre className="log">`；`AgentConversationCard.tsx` 只傳 `height="auto"`，缺上限、內容可無限撐
高，屬於**近似而非等效**的真實視覺差異，而非單純程式碼繞法）。

**改法**：`LogViewer.tsx` 新增 optional `maxHeight?: string`，與既有 `height` 一起併入同一個
`style` 物件：

```tsx
style={height || maxHeight ? { height, maxHeight } : undefined}
```

補完後回頭修正兩處「近似」寫法（因為是真實視覺差異，非單純繞法等效，依指示需改回）：

- `src/pages/workers/WorkerDetail.tsx`：`LogPre` 改成 `<LogViewer text={text} height="auto"
  maxHeight="30vh" />`，取代原本手刻的 `<pre className="log" style={{height:'auto',
  maxHeight:'30vh'}}>`。
- `src/pages/pipelines/AgentConversationCard.tsx`：兩處 `<LogViewer ... height="auto" />`（Prompt
  區塊、`rawStdout` 區塊）都補上 `maxHeight="40vh"`，修正原本無上限、內容可無限撐高的視覺差異。

**影響到哪些呼叫端**：`WorkerDetail.tsx`、`AgentConversationCard.tsx`（視覺行為修正，貼近舊版
`max-height` 上限；其餘沒傳 `maxHeight` 的呼叫端，如 `LogsPage`，行為不變）。

---

## 驗收結果

- `bunx tsc --noEmit -p tsconfig.app.json`：零錯誤（含第一波 5 個分頁）。
- `bun run build`：成功，`vite build` 產出 `dist/`。

---

## 第二輪補強（11 分頁完成後）

11 個分頁全部實作完成後，`StatsPage`（Token 名冊）與 `EventsPage`（空狀態）**各自獨立**撞到同一個
`DataTable` 缺口，確認是共用層真問題而非個案；同時 `EventsPage` 的 `#ev-live` 開關在切換 `useResource`
的 `autoRefresh` 時有多餘 fetch，一併修掉。修完即封版共用層，準備進 Playwright 新舊截圖比對。

### D1. `src/components/shared/DataTable.tsx` — 缺「零資料列且不放填充列」的模式

**缺口**：`DataTable` 資料為空時一定會渲染一個 `<td colSpan>` 的填充列，即使 `emptyText=""` 也是渲染
一個空白 `<tr>`。舊版部分表格查無資料時是**完全不放任何 `<tr>`、只留表頭列**，兩者在 DOM 結構上不等效
（尤其影響 Playwright 截圖比對時的列高與邊框）。

**成因**：`stats.md`「狀態與邊界」小節明記 Token 名冊查無資料時「只顯示表頭列，無提示文案（3.7 的已知
限制）」；`events.md`「狀態與邊界」小節明記本頁「沒有專屬的『無資料』文案/EmptyState」。兩處重寫時都只能
用 `emptyText=""` 近似（仍會渲染一個空白列），不是真正等效。

**改法**：`emptyMode` 新增 `'none'` 值（原本只有 `'row' | 'replace'`），並把 `emptyText` 改成
optional（`'none'` 模式不需要文案）：

```ts
emptyText?: string
emptyMode?: 'row' | 'replace' | 'none'
```

`isEmpty` 分支內，`emptyMode === 'none'` 時 `tbody` 直接不渲染任何 `<tr>`（表頭列不受影響，
`showHeader` 語意不變）：

```tsx
{isEmpty ? (
  emptyMode === 'none' ? null : (
    <tr><td colSpan={columns.length} className={emptyTone}>{emptyText}</td></tr>
  )
) : ( /* 原本的 rows.map(...) */ )}
```

未傳 `emptyMode`（預設 `'row'`）或傳 `'replace'` 的既有呼叫端行為完全不變；`emptyText` 由必填改
optional 也不影響任何既有呼叫端（他們本來就有傳）。

**影響到哪些呼叫端**：

- `src/pages/StatsPage.tsx`：Token 名冊表 `emptyText=""` → `emptyMode="none"`。
- `src/pages/EventsPage.tsx`：主表 `emptyText=""` → `emptyMode="none"`。
- 其餘 19 處 `<DataTable>` 呼叫（`OverviewPage`×3、`ToolsmithPage`、`TgPendingPage`、
  `SessionsPage`、`TgConnectedPage`、`StatsPage` 其餘 4 處、`PipelineDetailView`×2、
  `PipelinesListView`、`WorkerDetail`×2、`WorkersList`、`TokenDetailView`、`TokenListView`）
  都明確傳 `emptyText` 且要嘛用預設 `'row'`、要嘛用 `'replace'`，皆需要保留文案，不受影響、不用改。

### D2. `src/hooks/useResource.ts` — 切換 `autoRefresh` 會多打一次 API

**缺口**：原本單一 `useEffect` 把 `autoRefresh` 放進依賴陣列，`autoRefresh` 一變就整個重建
`subscribe()` 訂閱；而 `subscribe()` 內部「首次載入立即打一次」的邏輯是無條件執行（見
`src/api/transport.ts:148-149` `void run(false)`，不受 `autoRefresh` 參數影響）。結果是使用者重新
打開 `EventsPage` 的 `#ev-live`（`autoRefresh: live`）時，除了恢復輪詢外還會多打一次 API；舊版
`public/index.html` 的「自動更新」checkbox 只恢復輪詢，不會立刻重打。

**改法**：拆成兩個 effect（都在 `useResource.ts` 內，未改動 `transport.ts`）：

```ts
// 取資料 effect：只吃 topic.key / paramsKey / enabled，subscribe() 一律傳 autoRefresh:false
// （交由下面的排程 effect 自己管），所以 autoRefresh 改變不會落入這個 effect 的依賴陣列。
useEffect(() => { /* setLoading + subscribe(...) 立即首抓 + 存 subRef */ },
  [topic.key, paramsKey, enabled])

// 排程 effect：只負責 setInterval 要不要開、多久跳一次；tick 內先過 shouldPoll 這道守門，
// 再呼叫 subRef.current?.refresh()——不會重建訂閱，也就不會觸發首抓那次 fetch。
useEffect(() => {
  if (!enabled || !autoRefresh) return
  const period = intervalMs ?? topicRef.current.intervalMs ?? POLL_INTERVAL_MS
  const timer = setInterval(() => {
    if (shouldPollRef.current && !shouldPollRef.current()) return
    void subRef.current?.refresh()
  }, period)
  return () => clearInterval(timer)
}, [autoRefresh, intervalMs, enabled, topic.key, paramsKey])
```

`autoRefresh` 從 false→true 只會讓排程 effect 重跑、重新掛上 `setInterval`，不會讓取資料 effect
重跑，所以不會多打即時 fetch；`shouldPoll` 守門邏輯從 `subscribe()` 內部搬到排程 effect 自己做
（`refresh()` 本身依文件定義就是「忽略 shouldPoll」的手動重抓，語意不變，`reload()` 呼叫路徑不受影響）。
params/topic 改變仍落在取資料 effect 依賴陣列內，行為不變；`enabled=false` 時兩個 effect 都提早
return，不訂閱不排程，行為不變；unmount 時取資料 effect 的 cleanup 仍呼叫 `sub.unsubscribe()`
（含 abort），排程 effect 的 cleanup 仍 `clearInterval`，都不變。

**影響到哪些呼叫端**：`useResource()` 對外簽名、`Resource<T>` 回傳形狀完全沒變，純內部實作重構，
11 個分頁的 18 處呼叫都不需要跟著改。唯一實際會表現出行為差異的是 `src/pages/EventsPage.tsx:68`
的 `useResource(topics.events, queryParams, { autoRefresh: live })`——這是全站唯一會動態切換
`autoRefresh` 的呼叫點，修完後重新打開 `#ev-live` 只恢復輪詢、不再多打一次 API，其餘呼叫點的
`autoRefresh` 要嘛是預設 `true` 全程不變、要嘛從未被傳入，行為不受影響。

### 驗收結果（第二輪）

- `bunx tsc --noEmit -p tsconfig.app.json`：零錯誤。
- `bun run build`：成功。
- Regression grep：`<DataTable` 21 處（13 個檔案）、`useResource(` 18 處（13 個分頁），逐一核對
  確認只有上述 D1/D2 列出的呼叫端需要跟著改，其餘不需要改的原因已在各節「影響到哪些呼叫端」列出。

## 第三輪補強：autoScroll 改用真訊號

### 背景：A2 的猜測式做法在真實情境下失效（BLOCKER）

A2 用「新文字是否為舊文字的延伸（`text.startsWith(prev) && text.length > prev.length`）」判斷
這次 `text` 變動是「整批替換」還是「純追加」，藉此重現舊版 `loadLog()` 無條件捲到底
（`index.html:744`）vs 即時跟隨 timer 的 40px `atBottom` 門檻（`index.html:751-753`）兩種語意。

**這個猜測在下面這個情境下會判錯**：即時跟隨關閉、`kb` 視窗設定小到每次 `/api/log/tail` 都是從
第 0 byte 重新截一段固定大小的 tail、而 log 檔案本身在兩次載入之間繼續長大。此時使用者捲到一半
按「重新載入」（或切換 kb、或切換 follow），新抓回來的 tail 內容**字面上**可能就是「舊 tail 文字
+ 檔案這段期間新增的位元組」——因為兩次 tail 都是取檔尾固定 KB，檔案長大後新的 tail 視窗自然把
舊視窗的內容含括在內、後面再接上新內容。這種情況下 `text.startsWith(prev)` 為真、`text.length >
prev.length` 也為真，heuristic 判定為「追加」，套用 40px 門檻——但這其實是一次不折不扣的
`/api/log/tail` 整批替換，規格要求無條件捲到底。使用者捲到一半按重新載入、畫面卻沒有捲到底，正是
這個 BLOCKER 最初被回報的行為。

**根本成因**：`LogViewer` 是純呈現元件，只看得到 `text` 這個最終字串，看不到這次更新是呼叫
`/api/log/tail`（整批替換）產生的、還是 `/api/log/since`（純追加）產生的。而**內容形狀本質上無法
可靠區分這兩種情境**——「新文字剛好是舊文字的字首延伸」在「純追加」與「tail 視窗因檔案長大而整批
換內容、但兩次視窗有重疊」這兩種情況下都會發生，字串比對本身沒有足夠資訊分辨呼叫端的意圖。只要
存在任何一種「整批替換後字面上仍是舊文字的延伸」的情境，這類 heuristic 就必然誤判，不是把判斷式
改精細一點能修好的，因為問題出在資訊來源不對，不是規則不夠精確。

### 改法：訊號從呼叫端結構性地產生，不再靠內容猜

`src/hooks/useLogFollow.ts` 內部本來就結構性地知道自己在跑哪個階段——階段 1 呼叫
`fetchLogTail()`（`/api/log/tail`，整批替換）、階段 2 呼叫 `fetchLogSince()`
（`/api/log/since`，純追加，含 index.html:751 的截斷清空分支）。新增一個只在階段 1 成功回應時才
+1 的單調遞增計數 `loadId`，隨 `LogFollowState` 一起回傳：

```ts
const [loadId, setLoadId] = useState(0)
// 階段 1（tail）成功回應時：
setText(res.text)
// ...
setLoadId(id => id + 1)   // 階段 2（since）完全不碰這個 state
```

`loadId` 遞增的時機（等於觸發階段 1 重跑的 effect 依賴：`path` / `kb` / `follow` / `epoch`）自然涵
蓋所有整批替換情境：換檔案、改 kb、切換 follow、呼叫 `reload()`（重新載入按鈕）。階段 2 的截斷清空
分支（`if (res.offset < offsetRef.current) setText('')`）不動 `loadId`，維持「仍屬於追加迴圈內、走
40px 門檻」的舊版語意（對照 `index.html:751` 那個清空發生在 `setInterval` 內、`atBottom` 是清空前
就算好的，不是無條件捲到底）。

`LogViewer.tsx` 新增 optional prop `reloadToken?: string | number` 承接這個訊號，判斷式從內容比對
改成訊號比對：

```tsx
const isReplace = reloadToken !== prevReloadTokenRef.current
if (isReplace || atBottomRef.current) el.scrollTop = el.scrollHeight
```

`text.startsWith(prev)` 的猜測邏輯整段移除。`reloadToken` 不傳時（`undefined === undefined`
恆為 `false`）等於「訊號恆定」，`isReplace` 永遠是 `false`，但這不影響任何現有靜態呼叫端，因為它們
的 `autoScroll` 本來就是 `false`，整段 `if (autoScroll && el)` 直接被短路跳過，程式碼根本不會走到
這個判斷式。

`src/pages/LogsPage.tsx` 把 `useLogFollow()` 回傳的 `log.loadId` 接到 `<LogViewer reloadToken=
{log.loadId} .../>`；`autoScroll` 維持原本「固定 `true`、不綁 `follow`」的寫法不變。

### 為什麼新做法對失效情境結構性正確

沿用問題描述的情境：即時跟隨關閉、`kb` 視窗小、檔案在兩次載入間長大、使用者捲到一半按「重新載入」。

1. 使用者點「重新載入」→ `LogsPage` 呼叫 `log.reload()` → `useLogFollow` 內 `setEpoch(e => e+1)`。
2. `epoch` 變動使階段 1 的 `useEffect`（deps 含 `epoch`）重跑，呼叫 `fetchLogTail(path, kb)`——
   這一步**不看檔案內容長什麼樣**，純粹是「這是階段 1 的程式碼路徑」這個結構事實。
3. 回應成功時，`setText(res.text)` 與 `setLoadId(id => id+1)` 在同一個 `.then()` callback 內同步
   呼叫，會被 React 批次進同一次重新渲染——`text` 與 `loadId` 保證同一拍變動，不會有「text 換了但
   loadId 還沒跟上」的競態窗口。
4. `LogsPage` 重新渲染，把新的 `log.text`（此時字面上可能就是「舊文字 + 新位元組」）與新的
   `log.loadId`（= N+1）一起傳給 `LogViewer`。
5. `LogViewer` 的 effect 重跑：`isReplace = (N+1) !== prevReloadTokenRef.current(N)` 為 `true`。
   判斷式完全不看 `text` 的內容或長度，只看這個計數變了沒有——所以就算 `text` 剛好長得像「舊文字的
   延伸」，也不會被誤判成追加。
6. `isReplace || atBottomRef.current` 為真（第一項就已經是 true），無條件 `el.scrollTop =
   el.scrollHeight`，不受 `atBottomRef.current`（使用者當時捲到一半、應為 false）影響。

判斷的資訊來源從「猜內容形狀」換成「呼叫端在呼叫哪一支 API」這個結構事實，兩者在任何情境下都不會
混淆——`fetchLogTail` 與 `fetchLogSince` 是兩個不同的函式呼叫，不存在「內容剛好長得像」這種歧義。

### 影響到哪些呼叫端

全專案 grep `<LogViewer` 共 4 處呼叫點：

- `src/pages/LogsPage.tsx:113`：唯一 `autoScroll={true}` 的呼叫點，新增傳入
  `reloadToken={log.loadId}`。**行為改變**（且是本次要修的行為）：`follow` 關閉、`kb` 小、檔案
  長大、使用者捲到一半按重新載入時，現在會正確無條件捲到底；其餘情境（純追加、初次載入）行為與
  修改前一致。
- `src/pages/pipelines/AgentConversationCard.tsx:69`（Prompt 區塊）與 `:89`（`rawStdout`
  區塊）：兩處都未傳 `autoScroll`，維持預設 `false`。不受影響——沒傳 `reloadToken`，且
  `if (autoScroll && el)` 直接短路，捲動 effect 整段不執行。
- `src/pages/workers/WorkerDetail.tsx:22`（經 `LogPre` 包一層）：同樣未傳 `autoScroll`，理由同上，
  不受影響。

### 驗收結果（第三輪）

- `bunx tsc --noEmit -p tsconfig.app.json`：零錯誤。
- `bun run build`：成功（`tsc -b && vite build`，98 modules transformed，無錯誤）。
