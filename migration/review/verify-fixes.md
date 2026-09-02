# 驗收報告：tg-monitor React 遷移 10 項修復

驗收者為 fresh-context，未參與實作/修復，逐項對照 `public/index.html`（唯一事實來源）與 `migration/tabs/*.md` 規格獨立驗證。未讀取 `04-review-fixes.md` 與 `review/parity-*.md`。

---

## 逐項驗收

1. **BLOCKER — LogsPage 無條件捲到底** — **FAIL** — `src/components/shared/LogViewer.tsx:44-48`、`src/pages/LogsPage.tsx:113`、`src/hooks/useLogFollow.ts:61-96` — LogsPage 已把 `autoScroll` 固定傳 `true`（不再綁 `follow`），方向正確；但 `LogViewer` 內部用「新文字是否為舊文字的字面延伸」（`isAppend = prev!=='' && text.length>prev.length && text.startsWith(prev)`）猜測這次文字變動是「整批替換」還是「純追加」，而不是由呼叫端明確告知。當 `follow` 關閉、`kb` 視窗足以整份讀入一個小檔案（`start=0`）時，同一檔案兩次 `重新載入`／輪詢間檔案只是單純變長，第二次讀到的內容會**字面上**是第一次內容的延伸，於是被誤判成「純追加」，改套用 40px `atBottom` 閘門，而非規格要求的無條件 `scrollTop=scrollHeight`（`index.html:744`：`loadLog()` 內對 `out.scrollTop=out.scrollHeight` 沒有任何條件判斷）。也就是說：使用者在未勾「即時跟隨」時往上捲查看歷史、按「重新載入」，若剛好命中上述視窗未滑動的情況，畫面**不會**被捲到底——與 BLOCKER 要求的「無條件」矛盾。這是內容形狀啟發式取代結構性訊號（呼叫來源本身）的典型反例，且此路徑（同檔案、視窗覆蓋全檔、檔案持續變長）正是「重新載入」按鈕最常見的使用情境，並非罕見邊界。

2. **MAJOR — useLogFollow 切換即時跟隨要重拉 tail** — **PASS** — `src/hooks/useLogFollow.ts:96` — 階段 1（tail）effect 的依賴陣列為 `[path, kb, epoch, follow]`，明確把 `follow` 列入依賴，切換「即時跟隨」勾選框會整個重新打一次 `/api/log/tail`（重設 offset），對應 `index.html:823` `$('#lg-follow').onchange = loadLog`（整段流程重跑，非只是啟停 1500ms timer）。

3. **MAJOR — EventsPage setQueryParams 結構性正確** — **PASS** — `src/pages/EventsPage.tsx:95-100`、`src/hooks/useResource.ts:69-110` — 見下方專節論證。

4. **MAJOR — SessionsPage 查詢按鈕/Enter 結構性正確** — **PASS** — `src/pages/SessionsPage.tsx:47-52` — 與 EventsPage 同一模式：`identity` 是 `useResource` params 的一部分，值改變時交給 `useResource` 內以 `paramsKey`（`JSON.stringify(params)`）為依賴的 effect 自動重建訂閱並立即打新請求；值不變但使用者仍觸發查詢時才顯式呼叫 `sessions.reload()`（此時新舊參數本來就相等，不存在時序落差）。已修復「identity 未變時靜默無反應」的問題。

5. **MAJOR — TgConnectedPage 空狀態取代整個 table** — **PASS** — `src/pages/TgConnectedPage.tsx:70`（`emptyMode="replace"`）、`src/components/shared/DataTable.tsx:92-94`（`isEmpty && emptyMode==='replace'` 時直接 `return <div>{emptyText}</div>`，完全不渲染 `<table>`） — 對應 `index.html:763-764`（`loadTgConnected()`）：`d.connected.length ? '<table>...':'<div class="mute">尚無已連接的同事</div>'`，同樣是「整段取代」而非多渲染一列表頭。`emptyMode="replace"` 是 DataTable 既有能力，全站已有 11 處使用，非本次新發明。

6. **MINOR — 全形括號 + 動態計數的空白** — **PASS** — 掃過 11 個分頁全部「全形括號＋動態計數」標題，逐一與 `index.html` 原始碼位元組級比對：
   - `src/pages/tokens/TokenListView.tsx:109` `Token 持有人（<span>{n}</span> 人）` = `index.html:142` `Token 持有人（<span id="tk-n">0</span> 人）`（`（`與數字間無空白，數字與「人」間有一個空白）
   - `src/pages/workers/WorkersList.tsx:119` `已註冊 Worker（<span>{n}</span>）` = `index.html:218`（全無空白）
   - `src/pages/TgConnectedPage.tsx:62` `已連接（<span>{n}</span>）` = `index.html:245`（全無空白）
   - `src/pages/TgPendingPage.tsx:119` `待處理（<span>{n}</span>）` = `index.html:255`（全無空白，確認未被改壞）
   四處全部逐字元相符，無任何一處多加空白。

7. **MINOR — StatsPage 改 days 時 rosters 跟著重取** — **PASS** — `src/pages/StatsPage.tsx:134-140` — `days` select 的 `onChange` 內除 `setDays(...)` 外，明確呼叫 `void rosters.reload()`；因 `topics.rosters` 的 params 恆為 `undefined`（本來就不含 `days`），`useResource` 不會因 `days` 變動自動重建訂閱，靠顯式 `reload()` 補上，對應規格「`loadStats()` 每次觸發都同步呼叫 `/api/rosters`」（`stats.md §2`）。

8. **MINOR — TokensPage 移除多餘「載入中…」** — **PASS** — `src/pages/TokensPage.tsx:51-57` — `!data ? null` 直接不渲染任何內容，全檔（含 `tokens/` 子目錄）grep 不到任何「載入中」字樣渲染在畫面上，對應 `tokens.md:170`「無專屬 loading 狀態」。

9. **MINOR — ToolsmithPage pendingQuestions 檢查** — **PASS** — `src/pages/toolsmith/ToolsmithDetail.tsx:27` `run.pendingQuestions && {...}` — 純 truthy 判斷，未額外加 `.length > 0`，與 `index.html:647` `r.pendingQuestions?...`（同樣純 truthy）語意一致；空陣列仍會顯示（含空 `<ul>`）的行為與舊版相同。

10. **MINOR — 全域 nav 水平間距** — **PASS** — `src/components/shell/HeaderNav.tsx:29-40` — 用 `{i > 0 && ' '}` 在每個 `<button>` 之間插入字面空白文字節點，重現舊版手寫 HTML 換行縮排在 inline 排版下塌縮成一個空白字元的效果（`index.html:70-79`）。確認 CSS（`nav button{...}`）本身沒有 `gap`（只有 `.subnav` 有 `gap:6px`），空白間距完全依賴這個文字節點，修復方式正確且完整。

---

## 迴歸檢查

- **`sleep`/`setTimeout` 延遲**：全專案 grep 無任何命中，未見用等待掩蓋正確性問題。
- **`dangerouslySetInnerHTML`**：全專案 grep 僅命中註解（提醒禁止使用），無實際使用。
- **繞過 `src/api` 自寫 fetch**：`useAction.ts`/`useResource.ts` 內的 `fetch(` 命中皆為委派呼叫（`topic.fetch(...)`）或說明性註解，非直接打 `window.fetch`。
- **繞過 `src/lib/format.ts` 自寫格式化**：本次 10 項修復觸及的檔案（`LogsPage.tsx`、`LogViewer.tsx`、`useLogFollow.ts`、`EventsPage.tsx`、`SessionsPage.tsx`、`TgConnectedPage.tsx`、`StatsPage.tsx`（days handler 部分）、`TokensPage.tsx`、`ToolsmithDetail.tsx`、`HeaderNav.tsx`）內未見自製格式化邏輯。`AgentConversationCard.tsx`/`SparkBarChart.tsx`/`StatsPage.tsx` 內既有的 `toFixed`/`toLocaleString`/`new Date` 用法為既有程式碼、與本輪 10 項修復無關，非本輪新增迴歸。
- **共用層改動影響面**：
  - `LogViewer.tsx` 的 `autoScroll` 內部啟發式僅由 `LogsPage.tsx` 以 `autoScroll={true}` 觸發使用；其餘呼叫者（`AgentConversationCard.tsx`、`WorkerDetail.tsx` 的 `LogPre`）皆未傳 `autoScroll`，維持預設 `false`，不受影響，無迴歸。
  - `DataTable.tsx` 的 `emptyMode="replace"` 為既有能力（全站 11 處已使用），TgConnectedPage 的修復只是採用既有選項，未新增/修改 DataTable 邏輯本身。
  - 未發現其他共用層檔案在本輪被觸及。
- **未發現本輪修復引入的其他新缺陷**（除項目 1 之外）。

---

## 第 3、4 項的結構性論證

**結論：兩者皆為結構性正確，不依賴時序/競態。**

`useResource`（`src/hooks/useResource.ts`）的取資料 effect：

```ts
const paramsKey = JSON.stringify(params ?? null)
useEffect(() => {
  ...
  const sub = subscribe({...}, paramsRef.current, ...)
  ...
}, [topic.key, paramsKey, enabled])
```

依賴陣列是 `params`的**序列化字串**（值比較），不是 reference。這代表：

- 只要 `EventsPage`/`SessionsPage` 呼叫 `setQueryParams(nextParams)` / `setIdentity(trimmed)` 讓下一次 render 產出的 `params` 序列化後與上一次不同，React 保證會重新執行這個 effect（這是 React 依賴陣列的語言層保證，不是「通常會」而是「一定會」）。
- effect 重新執行時會先跑 cleanup（`sub.unsubscribe()`），再呼叫新的 `subscribe(...)`；`subscribe()` 內部第一行就是 `void run(false)`（`src/api/transport.ts:149`），也就是**建立訂閱的當下就會立即用新參數打一次請求**，不需要額外呼叫 `reload()`。
- 若額外呼叫 `reload()`（`EventsPage.tsx:99` 的 `if (!changed) void resource.reload()`），只發生在「新舊參數序列化後相等」的分支——此時新參數在數學上就等於舊訂閱閉包捕捉的參數，兩者不存在「新值 vs 舊值」的落差，`reload()` 打出去的參數與「應該打」的參數必然相同。這個分支的正確性靠的是**值相等的判斷**（`JSON.stringify(nextParams) !== JSON.stringify(queryParams)`），而非等待某個非同步流程完成。

反之，原本被抓到的錯誤模式是：`setQueryParams(next)` 後**緊接著**（同一個事件處理函式內、還沒有重新 render）呼叫 `reload()`——此時 `reload()` 打的是既有訂閱閉包裡的 `paramsRef.current`／`params` 參數，而 React state 更新是非同步的，`queryParams` 尚未真的變成 `next`，所以會用**舊參數**多打一次請求，正確性取決於「這次多打的請求會不會恰好在下一輪真正的請求之前/之後回來」——這才是真正的競態。

新做法完全避開了這個陷阱：**改變值的路徑**完全不呼叫 `reload()`，讓 React 的依賴陣列機制保證重新訂閱與立即抓取；**只有值不變的路徑**才呼叫 `reload()`，而這條路徑上「新舊參數相等」是由程式碼顯式比對過的事實，不是假設。兩條路徑合起來，任何時候呼叫 `subscribe()`/`run()` 所用的 `params` 都與「使用者最後一次操作後應該生效的參數」一致，這是靠值比對與 React re-render 語意保證的，不是賭時序。

`SessionsPage.tsx:47-52` 的 `runQuery` 是同一模式的原樣複製（`identity` 換成 `trimmed`），論證完全相同。

---

## 總結

10 項中 9 項（2、3、4、5、6、7、8、9、10）驗證通過，第 3、4 項的結構性正確性論證成立。第 1 項（BLOCKER）方向正確（`autoScroll` 不再綁死 `follow`）但實作手段（`LogViewer` 內以「新文字是否為舊文字延伸」的內容啟發式取代明確的呼叫來源訊號）在「同檔案、kb 視窗覆蓋全檔、檔案持續變長」這個常見情境下仍會違反「無條件捲到底」的規格要求，判定 FAIL。未發現本輪修復引入的其他迴歸；`tsc --noEmit` 通過、零錯誤。

由於 BLOCKER 未完全修復，整體判定為 **FAILED**。

---

VERIFY_RESULT: FAILED
FAILED_ITEMS: 1（LogViewer 的 isAppend 內容啟發式在「follow 關閉、同檔案、kb 視窗覆蓋全檔、檔案變長、使用者已往上捲」情境下，重新載入/切檔不會無條件捲到底，違反 tabs/logs.md §3.2 與 index.html:744 的要求）
REGRESSIONS: none
TSC: PASS
REPORT_PATH: /Users/user/aladdin/tg-monitor/migration/review/verify-fixes.md