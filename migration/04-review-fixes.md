# Review Fixes（2026-09-02）

修復對象：`migration/review/code-review-A.md`、`code-review-B.md`、`visual-review-A.md`、`visual-review-B.md` 抓出的 1 個 BLOCKER + 4 個 MAJOR + 5 個 MINOR。逐項記錄「問題 → 成因 → 改法 → 影響到哪些檔案」。判斷依據：`migration/tabs/*.md` 與 `public/index.html`（唯讀，衝突時以它為準）。

---

## BLOCKER

### 1. Logs：沒勾「即時跟隨」時完全不捲到底

- **問題**：`LogsPage.tsx` 把 `LogViewer` 的 `autoScroll` 綁死在 `follow`（即時跟隨 checkbox）上。`follow=false` 時 `LogViewer` 內所有捲動邏輯（含「初次載入/整批替換一律捲到底」）整組不執行。
- **成因**：`LogViewer` 的 `autoScroll` prop 語意是「這個元件實例要不要自動捲動」，但舊版真正的語意是「初次載入一律捲、只有追加內容才看 follow」（`index.html:744` 無條件 `out.scrollTop=out.scrollHeight`；`index.html:751-753` 才是追加時的 40px atBottom 判斷）。呼叫端把兩種語意錯誤地合併成同一個開關。
- **改法**：`LogsPage.tsx` 的 `<LogViewer autoScroll={follow} .../>` 改成 `<LogViewer autoScroll .../>`（固定 `true`，不再跟 `follow` 綁定）。`LogViewer` 內部（`03-shared-layer-patch.md` A2 補強）本來就用「新文字是否為舊文字的延伸（`startsWith` 且更長）」區分「整批替換」（無條件捲到底）與「純追加」（40px atBottom 才捲）；`follow=false` 時本來就不會有追加事件發生（見下一項），所以固定 `autoScroll=true` 剛好重現舊版兩個呼叫點的語意，不需要在 `LogViewer` 本身動刀。
- **影響檔案**：`frontend/src/pages/LogsPage.tsx`。

---

## MAJOR

### 2. Logs：切換「即時跟隨」不會重新拉一次 tail

- **問題**：`useLogFollow.ts` 階段 1（`/api/log/tail` 讀取）的 effect 依賴是 `[path, kb, epoch]`，不含 `follow`。切換 `follow` 只會啟停階段 2（`/api/log/since` 跟隨訂閱），不會重讀 tail、不會重設 offset。
- **成因**：舊版 `$('#lg-follow').onchange = loadLog`（`index.html:823`）——切換即時跟隨要重跑**整個 `loadLog()`**（含重打 tail、重置 `lgOffset`），不只是開關 timer；新版把這個行為漏掉了。
- **改法**：階段 1 的 effect 依賴改成 `[path, kb, epoch, follow]`，讓 `follow` 改變時也觸發 tail 重讀。這與階段 2（依賴 `[path, follow, missing, epoch]`）搭配後，切換 follow 會同時重讀 tail、重設 offset、並啟停跟隨訂閱，等同舊版整個 `loadLog()` 重跑一次。
- **影響檔案**：`frontend/src/hooks/useLogFollow.ts`。

### 3. 即時序列：`runQuery` 用競態決定正確性

- **問題**：`EventsPage.tsx` 的 `runQuery` 在 `setQueryParams(next)` 之後緊接同步呼叫 `void resource.reload()`。`useResource.reload()` 打到的是**呼叫當下既有訂閱閉包捕捉的舊參數**（`subscribe()` 的 `params` 在建立訂閱時就固定了，不會因為外部 state 之後改變而更新），此時 React 尚未重渲染、`queryParams` 還沒真的變成新值。結果一次篩選操作會打兩次 API：一次帶舊參數（`reload()`）、一次帶新參數（`paramsKey` 改變後 `useResource` 的取資料 effect 重建訂閱時的立即首抓）。最終畫面是否閃過舊篩選結果，取決於「effect cleanup 的 `abort()` 是否搶在舊請求 resolve 之前完成」——這是未受結構保證的時序競賽，違反專案硬規則「正確性必須由結構保證，不得用等待/時序處理」。
- **改法（結構性，不靠時序）**：`useResource` 的取資料 effect 本來就是依 `paramsKey`（`JSON.stringify(params)`）判斷要不要重建訂閱，而重建訂閱**保證**會立即打一次新參數的請求——這件事由 React 的 effect 排程保證發生，不是靠時序賭贏。所以：
  - 只要 `setQueryParams` 的新值與目前 `queryParams` **序列化後不同**（真的變了），完全不需要手動 `reload()`——新訂閱建立時自動打新參數的請求，不存在「舊參數請求」這件事，因為根本沒有呼叫 `reload()` 去用到那個過期的閉包。
  - 只有新舊值**序列化後相等**（值沒變，但使用者仍按了「查詢」鈕或 Enter，规格要求「不論欄位是否真的改變，觸發點就重查一次」）時，才呼叫 `reload()`——此時因為參數沒變，既有訂閱閉包捕捉的參數本來就等於「新」參數，不存在新舊落差、不會有多打一次或參數錯誤的問題。
  - 這個判斷（`changed = JSON.stringify(nextParams) !== JSON.stringify(queryParams)`）完全基於值比對、與呼叫時序無關，結果在任何情況下都是確定的——這正是「結構性正確」而非「靠時序賭贏」的差異所在。
- **為什麼不是靠時序**：舊寫法的錯誤在於「無條件」呼叫 `reload()`，让它在「參數变了」與「參數沒变」兩種情況下都執行同一段程式碼，而只有前者才會產生競態（因為此時确实存在一個「即将建立、帶新參數」的訂閱在路上，跟 `reload()` 打的「舊參數」訂閱互相競爭）。新寫法用值比對從**結構上**排除了这个组合本身会发生的条件——參數变了就完全不調用 `reload()`，讓「新参数请求」只有唯一一个来源（重建訂閱的首抓），从根本上消除了竞态双方中的一方，而不是靠 abort 谁先谁后。
- **影響檔案**：`frontend/src/pages/EventsPage.tsx`（`useResource`/`transport.ts` 本身未改動，向後相容）。

### 4. 使用 Session：「查詢」在值沒變時靜默無反應

- **問題**：`SessionsPage.tsx` 的 `runQuery` 只呼叫 `setIdentity(identityInput.trim())`。若 trim 後的值與目前已提交的 `identity` 相同，React 不會產生新的 state（`Object.is` 相等時 `setState` 是 no-op），`useResource` 的 `paramsKey` 不變，取資料 effect 不會重建訂閱，畫面完全沒反應——按「查詢」或 Enter 像沒用一样。
- **成因**：舊版 `#ss-reload`／identity 欄 Enter 都對應**無條件**重呼叫 `loadSessions()`（`sessions.md §4`），與值是否改變無關；新版漏掉了「值沒變也要重查」這一半。
- **改法（結構性，同第 3 項的思路）**：
  ```ts
  const runQuery = () => {
    const trimmed = identityInput.trim()
    const changed = trimmed !== identity
    setIdentity(trimmed)
    if (!changed) void sessions.reload()
  }
  ```
  值真的改變時，交給 `useResource` 的 paramsKey 變化自動觸發重抓（與第 3 項同一個保證來源，不需要手動 `reload()`）；值沒變時才顯式 `reload()`——因為沒變，既有訂閱閉包捕捉的參數本來就等於「新」參數，`reload()` 打的請求絕對不會是「用错误的旧参数」，不存在竞态窗口。
- **影響檔案**：`frontend/src/pages/SessionsPage.tsx`。

### 5. TG 已連接：空狀態多了一列表頭

- **問題**：`TgConnectedPage.tsx` 的 `DataTable` 沒傳 `emptyMode`，用預設值 `'row'`——`connected` 為空時仍會渲染 `<table><thead>...</thead><tbody><tr><td colSpan>尚無已連接的同事</td></tr></tbody></table>`，多一列表頭。
- **成因**：`tabs/tg-connected.md §3` 與 `index.html:763-764`（`d.connected.length ? '<table>...' : '<div class="mute">尚無已連接的同事</div>'`）都是「空資料時整段直接换成 `<div class="mute">`，完全没有 `<table>`」——`DataTable` 的 `emptyMode="replace"` 就是为了重现这个语意，只是这一页漏传了（同批次的 `TokenListView.tsx` 已经正确使用）。
- **改法**：`<DataTable<ConnectedUser> ... emptyMode="replace" ...>`。
- **影響檔案**：`frontend/src/pages/TgConnectedPage.tsx`（`DataTable` 元件本身未改動）。

---

## MINOR

### 6. 卡片標題全形括號計數的空白字元（多頁）

檢查範圍：11 個分頁所有含全形括號（`（`/`）`）與動態計數的卡片/區塊標題，逐一對照 `public/index.html` 原文。

| 分頁 | 標題 | index.html 原文結構 | 舊版修復前 JSX | 修復後 |
|---|---|---|---|---|
| Token 權限 | Token 持有人（N 人） | `index.html:142` `Token 持有人（<span id="tk-n">0</span> 人）` | `` `Token 持有人（${data.people.length} 人）` ``（純字串插值，無 `<span>` 邊界） | `<>Token 持有人（<span>{data.people.length}</span> 人）</>` |
| TG 已連接 | 已連接（N） | `index.html:245` `已連接（<span id="tuc-n">0</span>）` | `` `已連接（${connected.length}）` ``（同上） | `<>已連接（<span>{connected.length}</span>）</>` |
| Workers | 已註冊 Worker（N） | `index.html:218` `已註冊 Worker（<span id="wk-n">0</span>）` | `<>已註冊 Worker（{resource.data?.workers.length ?? 0}）</>`（計數直接插值，無 `<span>` 邊界） | `<>已註冊 Worker（<span>{resource.data?.workers.length ?? 0}</span>）</>` |
| TG 待處理 | 待處理（N） | `index.html:255` `待處理（<span id="tup-n">0</span>）` | 已是 `<>待處理（<span>{pending.length}</span>）</>` | **未動**（本來就對，視覺審查兩份都確認 tg-pending 兩版空格一致，是唯一沒受影響的頁面） |

其餘分頁的卡片/區塊標題檢查過，**沒有**含全形括號+動態計數的組合，逐一列出核對結果（皆為純靜態文字，`index.html` 原文本身也無 `<span>` 計數，兩版本來就一致，不需改動）：
- 總覽：`服務 / Port（每 5 秒探測；「目前使用中」= 最近 N 分鐘內有稽核紀錄的人）`——`N` 本身也在 `<span>{d.activeWindowMin}</span>` 裡（`OverviewPage.tsx:112`），與 `index.html:85` 的 `<span id="win">5</span>` 結構一致，未受影響；`Telegram Webhook`、`TG 連接名單`、`背景 Pipeline 併發`、`最近狀態翻轉` 皆無括號計數。
- 歷史統計：`近 24 小時每小時請求數`、`每日 × 服務`、`使用者排行`、`tool 排行（次數 / 錯誤 / 平均耗時）`、`認證失敗來源`、`Token 名冊（不含 token 值）`——括號內都是靜態說明文字，無動態計數，`index.html:124-131` 對應處也都沒有 `<span>`，兩版本來就是純字串、無需修改。
- Token 權限：`新增 token（核發新 kit）`、`環境權限`——同上，靜態文字。
- Pipelines：`Pipeline 階段檢核表`、`Agent 流程（依開始時間）`、`進度 log`——同上。
- Workers：`GET /health`、`GET /capacity`、`目前指派在這台的票`、`查詢任一票在這台的 GET /jobs/:ticket`——無括號計數。
- Toolsmith：本頁無獨立 `<Card title>` 卡片（見 `ToolsmithPage.tsx`），純表格頁。

**根因**：老版本每個計數都包在獨立的 `<span id="...">` 元素裡（JS 只 `.textContent = n` 更新那個 span，不動周圍文字），新版三處遺漏用 `<span>` 包住的分頁改成了直接字串插值/JSX 表達式插值——實測（兩份視覺 review 各自獨立截圖比對）證實只有維持 `<span>` 元素邊界的頁面（tg-pending）在瀏覽器裡渲染出與舊版一致的視覺間距，另外三頁把計數直接插入純文字/模板字串反而讓視覺間距消失。因此修法統一改成「計數包在獨立 `<span>` 裡」，忠實复刻舊版 DOM 結構。

同批一併修復的相關問題（同一根因的 JSX 空白遺漏，code-review-A 指出）：

- **`OverviewPage.tsx:211-213`（同樣模式於 `221-223`）**：「背景 Pipeline 併發」卡片「Bug /create-mr」「需求 pipeline」兩行，`{used} / {limit}` 之後的 `<Badge>排隊 N</Badge>` 與 `{limitNote}` 前各漏了一個 `{' '}`。舊版樣板 `` `${used} / ${limit}${queued?` <span class="pill warn">...`:''}${limitNote}` `` 在 badge/limitNote 前有字面空格，JSX 拆成多個獨立表達式後 JSX 編譯器會丟棄純空白的行間文字節點。修法：`{pp.bugSlots.queued ? <>{' '}<Badge .../></> : null}`、`{limitNote ? <> {limitNote}</> : null}`（`demandSlots` 同步修正）。

**影響檔案**：`frontend/src/pages/tokens/TokenListView.tsx`、`frontend/src/pages/TgConnectedPage.tsx`、`frontend/src/pages/workers/WorkersList.tsx`、`frontend/src/pages/OverviewPage.tsx`。

### 7. 歷史統計：改 days 時 rosters 沒跟著重取

- **問題**：`StatsPage.tsx` 的 `stats`／`rosters` 是各自獨立的 `useResource`，`#st-days` 變更只重打 `/api/stats`，不會連帶重打 `/api/rosters`。
- **成因**：舊版 `loadStats()` 每次觸發（含 `days` 變更）都同步呼叫 `/api/rosters`（`stats.md §2`）。
- **改法**：`#st-days` 的 `onChange` 除了 `setDays(...)` 外，額外呼叫 `void rosters.reload()`。因為 `rosters` 的查詢參數本身不含 `days`（`useResource(topics.rosters, undefined)`），`reload()` 打的請求與 `days` 是否已完成 state 更新完全無關——不是靠時序才正確，純粹是「多顯式呼叫一次既有、參數不變的訂閱」。
- **影響檔案**：`frontend/src/pages/StatsPage.tsx`。

### 8. Token 權限：多餘的「載入中…」文字

- **問題**：`TokensPage.tsx` 首次載入（`loading && !data`）時顯示 `<div className="mute">載入中…</div>`。
- **成因**：`tokens.md §5`「無專屬 loading 狀態／骨架，`fetch` 期間畫面維持上一次渲染內容不變」；舊版 `#tk-list-view` 首次載入前是空白（無預設內容），不會顯示任何文字。
- **改法**：拿掉 `loading && !data` 分支，直接讓 `!data` 走到 `null`（維持空白）；連帶移除不再使用的 `loading` 解構欄位。
- **影響檔案**：`frontend/src/pages/TokensPage.tsx`。

### 9. Toolsmith：`pendingQuestions` 檢查過嚴

- **問題**：`ToolsmithDetail.tsx` 判斷「待回答問題」是否顯示時多加了 `run.pendingQuestions.length > 0`，比舊版嚴格。
- **成因**：舊版 `index.html:647` `` r.pendingQuestions?`<span>待回答問題</span>...`:'' `` 只做 truthy 判斷，空陣列 `[]` 也會顯示（空的 `<ul>`）。雖然實務上後端只在 `needs_clarification` 且 `lastRound` 存在時才賦值、幾乎不會是空陣列（理論邊界差異、無實際影響），但既然要求「若確認無實際影響也要修成與規格一致」，予以修正。
- **改法**：拿掉 `.length > 0` 判斷，只保留 `run.pendingQuestions &&`（truthy 判斷），並修正因拿掉巢狀條件而多出的縮排層級。
- **影響檔案**：`frontend/src/pages/toolsmith/ToolsmithDetail.tsx`。

### 10. 全域 nav 分頁按鈕水平間距比舊版緊

- **問題**：兩組視覺審查都獨立發現，全 6-11 個 route 一致：新版頂部 9 顆 nav 按鈕（總覽/即時序列/.../Logs）彼此間距略窄於舊版。
- **成因**：`nav`（`header` 內的 `<nav>`）本身**沒有** `display:flex` 或 `gap`（`index.html` 與 `global.css` 的 `nav button{...}` 規則都只設定單顆按鈕的 padding/border/font-size，不涉及按鈕之間的排版）。舊版是手寫 HTML，`<button>...</button>` 之間有換行與縮排，這些純空白的文字節點在 `nav` 預設的 block + 按鈕預設的 inline-block 排版下會塌縮成「一個空白字元寬度」，靠這個天然的文字節點撐出按鈕間距。新版用 `NAV_ITEMS.map(item => <button key={item.tab}>...)` 產生陣列，陣列裡的元素彼此之間**沒有**任何空白文字節點（JSX `.map()` 不會在陣列項目間插入空白），導致按鈕比舊版貼得更緊。
- **改法**：不是去猜一個 CSS gap 數字硬湊視覺效果，而是結構性地重現舊版的 DOM——在 `.map()` 產生的每個按鈕前面插入字面空白 `{' '}`（第一顆除外），用 `<Fragment key={item.tab}>{i > 0 && ' '}<button>...</button></Fragment>` 包裝：
  ```tsx
  {NAV_ITEMS.map((item, i) => (
    <Fragment key={item.tab}>
      {i > 0 && ' '}
      <button type="button" className={...} onClick={...}>{item.label}</button>
    </Fragment>
  ))}
  ```
  這樣渲染出來的文字節點結構與舊版手寫 HTML 完全對應（每顆按鈕間恰好一個空白字元），不依賴任何猜測的像素值。
- **影響檔案**：`frontend/src/components/shell/HeaderNav.tsx`。

---

## 判斷不該修的項目（review 已確認非缺陷，或另有處理）

- **`tabs/tg-pending.md §4` SET_CONFLICT 取消路徑描述**：`code-review-B.md` 指出規格文件寫「取消則不再動作，也不 alert」與 `index.html:817-818` 原始碼矛盾——原始碼 `confirm` 取消時 `if` 條件為假、不會 `return`，會直接落到下一行 `alert('指定失敗：...')`，也就是**取消時舊版其實還是會跳 alert**。`frontend/src/pages/TgPendingPage.tsx` 的實作忠實複刻了原始碼行為，是對的，不需要改程式碼。已在 `migration/tabs/tg-pending.md` 該處補上一段 `⚠️ 2026-09-02 修正` 註記，說明規格文件描述有誤、以 `index.html` 為準。
- **pipelines「重試」按鈕在 1440px 下的裁切差異**：新版完整顯示、舊版被裁掉半個字（`visual-review-B.md` MINOR #3）——新版是修正後的更完整呈現，不是缺陷，維持現狀。
- **events/sessions 表格「耗時」欄與操作連結欄在兩版都未顯示**：`visual-review-A.md` 已確認兩版現象完全相同（非本次 migration 引入的差異），維持現狀。
- **toolsmith 摘要欄視窗邊緣截斷**：`visual-review-B.md` 已確認新舊版截斷位置像素級相同，非缺陷。
- **`02-frontend-contract.md §8` 的 5 條刻意行為差異**：本輪未觸碰，維持既有正確實作（Toolsmith 展開列不被輪詢收合、Token 詳情頁 checkbox 不被輪詢沖掉、tg-connected/tg-pending 各自打一次 `/api/tg-users` 等）。

---

## 驗收結果

- `bunx tsc --noEmit -p tsconfig.app.json`：零錯誤。
- `NODE_OPTIONS=--max-old-space-size=8192 bun run build`：成功（`tsc -b && vite build`，98 modules transformed，`dist/assets/index-*.js` 306.59 kB / gzip 97.19 kB）。

## 修改檔案總覽

- `frontend/src/pages/LogsPage.tsx`
- `frontend/src/hooks/useLogFollow.ts`
- `frontend/src/pages/EventsPage.tsx`
- `frontend/src/pages/SessionsPage.tsx`
- `frontend/src/pages/TgConnectedPage.tsx`
- `frontend/src/pages/tokens/TokenListView.tsx`
- `frontend/src/pages/workers/WorkersList.tsx`
- `frontend/src/pages/OverviewPage.tsx`
- `frontend/src/pages/StatsPage.tsx`
- `frontend/src/pages/TokensPage.tsx`
- `frontend/src/pages/toolsmith/ToolsmithDetail.tsx`
- `frontend/src/components/shell/HeaderNav.tsx`
- `migration/tabs/tg-pending.md`（文件修正註記，非程式碼）

未修改（硬邊界）：`public/index.html`、`server.ts`、`lib/*.ts`。

---

## 第 11 項（視覺複驗後追加，指揮官直接修）

**問題**：overview 的「最近狀態翻轉」表格，新版多渲染了一列欄位標題（時間/服務/狀態/detail），舊版沒有。
由 fresh-context 視覺複驗 agent 抓到，判定 MAJOR（不在「已知刻意不修」清單內）。

**查證**：`public/index.html:328` 舊版渲染的是
`'<table>' + rows.slice(0,30).map(r => '<tr><td class="mono">...' ).join('') + '</table>'`
——**只有 `<tr><td>`，沒有 `<thead>`、沒有表頭列**；空狀態是 `<div class="mute">尚無紀錄</div>`（取代整個 table）。
確認 reviewer 判斷正確，新版的表頭列確實不該存在。

**改法**：`src/pages/OverviewPage.tsx` 的該 `DataTable` 補上 `showHeader={false}`。
共用元件本來就支援無表頭模式（`DataTable.tsx:37-38`，stats 的四張排行表也在用），不需改共用層。

**影響檔案**：`src/pages/OverviewPage.tsx`（單一 prop）。

**驗證**：`tsc --noEmit` 零錯誤、`bun run build` 成功；重新採集截圖後 overview 的新舊檔案大小差異從 2437 bytes 收斂到 338 bytes（殘差為即時監控資料的秒級漂移）。

---

## 截圖產物版本說明

| 目錄 | 採集時機 |
|---|---|
| `review/shots/` | 11 分頁實作完成、第一輪 review 前 |
| `review/shots-v2/` | 10 項 review 缺陷修復後 |
| `review/shots-v3/` | 第 11 項（狀態翻轉表頭）修復後，**最終版** |

最終版新舊差異（bytes，正值代表舊版較大）：
stats / tg-connected / tg-pending / logs = **0**；events / workers = 1；toolsmith = 81；tokens = 89；sessions = 169；overview = -338；
pipelines = -1977（**已知且刻意不修**：舊版「重試」按鈕在 1440px 被裁切、新版完整顯示）。
