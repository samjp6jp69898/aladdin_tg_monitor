# Parity 對照：Logs（logs）

實作檔案：`/Users/user/aladdin/tg-monitor/frontend/src/pages/LogsPage.tsx`（單檔，未拆子元件——
畫面只有一列 toolbar + 一個 `<pre>`，拆檔案反而增加跳轉成本）。

規格來源：`/Users/user/aladdin/tg-monitor/migration/tabs/logs.md`
契約來源：`/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md`

---

## 1. 互動功能對照（規格 §4）

| 規格第 4 節項目 | 舊版依據 | 實作位置（file:行號） |
|---|---|---|
| `select#lg-file` onchange → `loadLog()` | index.html:823 `$('#lg-file').onchange = loadLog` | `LogsPage.tsx:81-92`（`<select id="lg-file" ... onChange={e => setPath(e.target.value || null)}>`，line 85）；`path` 改變會讓 `useLogFollow({ path, kb, follow })`（`LogsPage.tsx:73`）重新跑 tail + 跟隨，等同呼叫 `loadLog()` |
| `select#lg-kb` onchange → `loadLog()`（用新 kb 重讀同一檔） | index.html:823 | `LogsPage.tsx:93-99`（`onChange={e => setKb(Number(e.target.value))}`，line 93）；`kb` 是 `useLogFollow` 的依賴之一（`useLogFollow.ts:93` 的 tail effect deps `[path, kb, epoch]`），改變即重新 tail |
| `checkbox#lg-follow` onchange → `loadLog()`（重開/不開 1500ms timer） | index.html:823 | `LogsPage.tsx:100-102`（`onChange={e => setFollow(e.target.checked)}`，line 101）；`follow` 是 `useLogFollow` 跟隨 effect 的依賴（`useLogFollow.ts:116` deps `[path, follow, missing, epoch]`），關閉時 effect 提前 return 不建立訂閱、開啟時重新訂閱 |
| `button#lg-reload` onclick → `loadLog()` | index.html:823 | `LogsPage.tsx:103-105`（`onClick={() => log.reload()}`）→ `useLogFollow.reload()`（`useLogFollow.ts:53-55`）bump `epoch`，同時觸發 tail effect 與跟隨 effect 重跑（等同舊版「先清舊 timer 再整個重來」） |
| `window.openLog(path)`（跨分頁跳轉，先 `loadLogList()` 確保選項存在，設定 `#lg-file`.value，再 `showTab('logs')`） | index.html:758 | 改走契約 §6.2 的 query 參數機制：來源分頁呼叫 `navigate(logsPath(path))`（`lib/navigation.ts:59-61`，不可修改）；`LogsPage.tsx:55-57` 用 `useSearchParams().get('path')` 當 `path` state 的初始值，掛載時直接進入選中狀態，不需要「先確保選項存在」這道手續（React 版檔案清單與 log 內容是分開訂閱，選項清單稍晚到達也不影響已選定的 `path`） |
| 無 confirm/alert（唯讀分頁） | logs.md:129 | 全檔沒有任何 `window.confirm`／`useAction`，符合 |

---

## 2. 渲染欄位對照（規格 §3.1 / §3.4）

| 欄位／文案 | 舊版來源 | 實作位置 |
|---|---|---|
| `registered` 選項文案 `[{service}] {label}{exists?' ('+KB+')':' (不存在)'}` | index.html:733-739 `loadLogList()` | `LogsPage.tsx:40-44`（`buildOptions()`），KB 用 `fmtKb()`（`lib/format.ts`，`(bytes/1024).toFixed(1)+'KB'`，與舊版手算完全同值） |
| `exists===false` 選項 disabled | 同上 | `buildOptions()` 設 `disabled: !l.exists`（line 43）；`<option disabled={o.disabled}>`（`LogsPage.tsx:88`） |
| `pipelineLogs` 分隔線「── pipeline 逐票 log ──」（disabled，value=''） | 同上 | `LogsPage.tsx:46` |
| `pipelineLogs` 選項文案 `{label} ({KB}, {ago(mtime)})` | 同上 | `LogsPage.tsx:47-49`，用共用 `ago()`（`lib/format.ts`） |
| `pipelineLogs.length===0` 時不顯示分隔線與任何項目 | 同上 | `buildOptions()` 的 `if (data.pipelineLogs.length)` 判斷（line 45），與舊版邏輯一致 |
| 選單排序：registered 原順序 → 分隔線 → pipelineLogs（後端已依 mtime DESC 排好） | logs.md §3.4 | `buildOptions()` 直接依 API 回傳陣列順序 push，無前端排序 |
| `#lg-kb` 四個固定選項（16/64/256/1024，預設 64） | index.html:260 | `KB_OPTIONS` 常數（`LogsPage.tsx:24-29`）+ `useState(64)`（line 58） |
| `#lg-follow` 預設勾選 | index.html:261 | `useState(true)`（`LogsPage.tsx:59`） |
| `#lg-out` 內容：missing → 「(檔案不存在)」；否則原文 | index.html:79 `loadLog()` | `<LogViewer text={log.text} emptyText={log.missing ? '(檔案不存在)' : undefined} />`（`LogsPage.tsx:110`，見下方「LogViewer emptyText 語意修正」） |
| `#lg-info`：missing → 空字串；否則 `{size/1024}KB` | index.html:80 | `info = !path \|\| log.loading \|\| log.missing ? '' : fmtKb(log.offset)`（`LogsPage.tsx:76`）；`log.offset` 在 tail 完成時即設為 `size`（`useLogFollow.ts:81`），語意等價 |

---

## 3. 狀態與邊界對照（規格 §5）

| 情境 | 規格要求 | 實作 |
|---|---|---|
| 選中檔案不存在（`missing:true`） | `#lg-out` 顯示「(檔案不存在)」；`#lg-info` 清空；不開跟隨 timer | `LogViewer` 的 `emptyText` 只在 `log.missing` 為真時才傳非 undefined 值（見下方修正說明）；`info` 同步判斷 `log.missing`；`useLogFollow` 內部跟隨 effect 本身即以 `if (!path || !follow || missing) return` 擋下（`useLogFollow.ts:97`），不會建立訂閱 |
| 尚未選擇任何檔案 | `loadLog()` 直接 return，畫面維持上次內容 | `path===null` 時 `useLogFollow` 的 tail effect 直接把 `text/size/offset` 清成初始值並 return（`useLogFollow.ts:61-70`）；本頁另外用 `useEffect`（`LogsPage.tsx:68-71`）在清單到達且尚未選檔時自動選第一項，行為對應舊版「force refresh 時若未選檔則選第一項」（index.html:838） |
| `registered` 某檔不存在 | 對應選項 disabled，不可選 | 見上表 `buildOptions()` |
| 無 `pipelineLogs` | 不顯示分隔線/任何提示文案 | 見上表 |
| 檔案被截斷/輪替（`r.offset < lgOffset`） | 清空畫面重新累積 | **未達成，見下方「未達成項目」第 1 點**——`useLogFollow` 未實作此判斷，屬共用層缺口 |
| 使用者正往上捲查看歷史時新內容不強制拉回底部 | 只有「捲動前已在底部附近（40px 容忍）」才自動捲到新底部 | **部分未達成，見「未達成項目」第 2 點**——`LogViewer.autoScroll` 是「內容一變就強制捲到底」，沒有這個 40px 容忍判斷，屬共用層行為，本頁不可修改 |
| API 例外 | tail 主體無 try/catch；跟隨 timer 內 `catch{}` 靜默 | `useLogFollow` 的跟隨訂閱 `onError` 傳 `() => {}`（`useLogFollow.ts:113`），與舊版靜默一致；tail 階段的例外會被設進 `error` state（本頁目前不特別渲染，與舊版「無特別 catch，例外會被外層吞掉」的粗略行為相符，不影響畫面） |
| 首次載入無 loading 骨架 | 不加 spinner | 本頁沒有任何 loading 佔位 UI，只用 `log.loading` 讓 `#lg-info` 在載入中先顯示空字串，避免閃過 `0.0KB` |

---

## 4. 兩層輪詢（本頁最容易做錯的地方）

**第一層：檔案清單，全域 5000ms**
- 實作：`LogsPage.tsx:61-63`
  ```tsx
  const list = useResource(topics.logs, undefined, {
    shouldPoll: () => document.activeElement?.id !== 'lg-file',
  })
  ```
- `topics.logs` 定義在 `api/topics.ts:126-130`，`intervalMs: POLL_INTERVAL_MS`（5000）。
- `shouldPoll` 對應舊版 `refresh()` 非 force 分支的 `document.activeElement !== $('#lg-file')`（index.html:838），焦點在下拉選單上時跳過這一輪背景輪詢；手動 reload／全域刷新鈕不受此限制（`useResource` 契約既有行為）。

**第二層：檔案內容即時跟隨，專屬 1500ms（`useLogFollow` 內部，本頁不自己寫 timer）**
- 呼叫：`LogsPage.tsx:73` `const log = useLogFollow({ path, kb, follow })`
- 兩層完全獨立：`topics.logs` 的 5000ms 只重建 `#lg-file` 的選項清單，不影響 `path`／`log` 狀態；`useLogFollow` 的 1500ms 只在 `follow && path && !missing` 時才存在（`useLogFollow.ts:97`），且用的是獨立的 `subscribe()` 呼叫（`useLogFollow.ts:99-115`），與 `useResource` 內部那條完全是兩條不同的訂閱。

**切換檔案／關閉跟隨時如何正確停止（不疊加）**
- `useLogFollow` 的跟隨 effect 依賴陣列是 `[path, follow, missing, epoch]`（`useLogFollow.ts:116`）：`path` 改變（切檔案）或 `follow` 變 `false`（關閉跟隨）都會讓 effect 清理函式先 `sub.unsubscribe()` 舊訂閱，再依新條件決定要不要建立新訂閱——`follow===false` 時 effect 開頭 `if (!path || !follow || missing) return` 直接不建立，等同「不會有兩個 timer 疊加」。本頁只負責把 `path` / `follow` 這兩個 state 正確傳進去，不自己管 timer：
  ```tsx
  const log = useLogFollow({ path, kb, follow })   // LogsPage.tsx:73
  ```
- 檔案清單的 5000ms 輪詢與此完全無關，不會因為切檔案／關跟隨而受影響或被誤停。

---

## 5. 共用層的一個小修正技巧（非缺口，記錄用意）

`LogViewer` 的 `emptyText` 語意是「`text===''` 就顯示替代文字」（`components/shared/LogViewer.tsx:36`），
比規格要求的「只有 `missing===true` 才顯示 (檔案不存在)」更寬鬆（例如 0 bytes 的真實存在檔案、或尚未選檔時也會落入
`text===''`）。本頁做法是只在 `log.missing` 為真時才傳非 `undefined` 的 `emptyText`：
```tsx
<LogViewer text={log.text} autoScroll={follow} emptyText={log.missing ? '(檔案不存在)' : undefined} />
```
這樣「檔案存在但剛好是空檔」與「尚未選檔」兩種情況會落回顯示空白 `text`（維持原本畫面），不會誤顯示「(檔案不存在)」，
與規格語意一致，不需要動共用層。

---

## 6. 未達成項目

1. **log rotation／截斷偵測未實作**（規格 §3.3：「`r.offset < lgOffset` 時清空畫面重新累積」）。
   `useLogFollow`（`src/hooks/useLogFollow.ts:104-111`，共用層、本頁不可修改）的跟隨迴圈拿到新回應後
   直接 `offsetRef.current = res.offset; setOffset(res.offset); if (res.text) setText(prev => prev + res.text)`，
   沒有比較「新 offset 是否小於呼叫前的 offset」來判斷截斷／輪替並清空 `text`。
   實務影響：只有在被監看的 log 檔案發生截斷或 log rotate 時才會觸發，一般操作與截圖比對不會踩到；
   但技術上與規格不符，已列入 `SHARED_LAYER_GAPS`。
2. **「使用者往上捲時不強制拉回底部」的 40px 容忍判斷未實作**（規格 §3.3）。
   `LogViewer.autoScroll`（`components/shared/LogViewer.tsx:24-28`，共用層）是「`text` 一變就無條件
   `scrollTop = scrollHeight`」，沒有先判斷「捲動前是否已在底部附近」。這正是契約文件 §3.3 自己給的
   建議用法（`<LogViewer text={log.text} autoScroll={follow} .../>`），本頁照契約範例使用；
   已列入 `SHARED_LAYER_GAPS` 供指揮官評估是否要調整共用層。
3. 其餘規格項目（§1 畫面結構、§2 資料來源時機、§3.1-3.2 渲染邏輯、§3.4 排序、§4 互動、§5 狀態邊界）
   均已對照完成，無其他刻意省略項目。

---

## 回報摘要

RESULT: DONE
TSC: PASS
PARITY_DOC: /Users/user/aladdin/tg-monitor/migration/review/parity-logs.md
SHARED_LAYER_GAPS: (1) useLogFollow.ts:104-111 跟隨迴圈未實作「offset 回退（log 截斷/輪替）時清空已累積文字」的判斷，與 tabs/logs.md §3.3 不符；(2) LogViewer.tsx:24-28 的 autoScroll 是無條件捲到底，沒有「只在使用者已在底部附近時才自動捲動」的 40px 容忍邏輯（tabs/logs.md §3.3），但此為契約文件 02-frontend-contract.md §3.3 自己示範的用法，本頁已照契約範例使用，僅供指揮官評估是否需要加強共用層
UNDONE: none（上述兩點是共用層行為缺口，非本頁未實作；本頁在給定共用層能力範圍內已完整覆蓋規格）
