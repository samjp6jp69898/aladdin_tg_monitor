# 驗收報告：logs 分頁自動捲動 BLOCKER（第三版修復）

驗收者：fresh-context 驗收 agent（未參與實作/修復）
驗收對象：
- /Users/user/aladdin/tg-monitor/frontend/src/hooks/useLogFollow.ts
- /Users/user/aladdin/tg-monitor/frontend/src/components/shared/LogViewer.tsx
- /Users/user/aladdin/tg-monitor/frontend/src/pages/LogsPage.tsx

事實來源：/Users/user/aladdin/tg-monitor/public/index.html（唯讀）
- `loadLog()` 定義於 index.html:740，整批載入無條件捲到底於 index.html:744
  （`out.scrollTop=out.scrollHeight`，緊接在 `out.textContent = ...` 之後，執行不看任何 follow 狀態）。
- 跟隨 timer 增量追加於 index.html:751-753：751 行是截斷/輪替清空分支
  （`if (r.offset < lgOffset) out.textContent=''`），753 行是純追加 + 40px atBottom 閘門
  （`const atBottom = out.scrollHeight-out.scrollTop-out.clientHeight<40; ...; if (atBottom) out.scrollTop=out.scrollHeight`）。

## 猜測邏輯是否移除

跑了全 src 的 grep，找尋任何殘留的「用內容形狀猜測是替換還是追加」寫法：

```
grep -rn "startsWith\|endsWith\|prev\.length\|text\.slice\|text\.substring" src --include="*.tsx" --include="*.ts"
```

命中僅兩處，皆與 log 無關：
- `src/pages/TgPendingPage.tsx:27` — `shouldPoll: () => !document.activeElement?.id?.startsWith('tup-sel-')`（下拉選單 focus 判斷，跟 log 文字內容無關）
- `src/pages/TgPendingPage.tsx:51` — `out.message.startsWith('SET_CONFLICT')`（錯誤碼字串比對，跟 log 文字內容無關）

`useLogFollow.ts` 與 `LogViewer.tsx` 全文都沒有 `startsWith`／任何比較「新舊文字內容」的程式碼。第二版失效的 `text.startsWith(prev)` heuristic 已完全移除，改成由 `useLogFollow` 提供 `loadId`（傳給 `LogViewer` 的 `reloadToken` prop），`LogViewer.tsx:55` 只用 `reloadToken !== prevReloadTokenRef.current` 這個引用值比對，不碰 `text` 內容本身做形狀判斷。**確認移除**。

## 訊號設計驗證

`loadId`（`useLogFollow.ts:61`，對外命名 `LogFollowState.loadId`）只在一個地方遞增：`useLogFollow.ts:94`，位於階段 1（tail）`fetchLogTail(...).then(res => {...})` 的成功分支尾端，緊接在 `setText(res.text)`（87 行）之後。

**階段 1（整批載入，`useLogFollow.ts:70-106`）觸發 `loadId` 遞增的四個依賴（106 行 `[path, kb, epoch, follow]`）逐一核對：**

| 情境 | 是否在 phase-1 useEffect 依賴內 | 會不會使 loadId 遞增 |
|---|---|---|
| 切換檔案（`path`） | 是 | 會 |
| 改 kb（`kb`） | 是 | 會 |
| 手動重新載入（`LogsPage.tsx:103` 呼叫 `log.reload()` → `useLogFollow.ts:63-65` `setEpoch(e=>e+1)`） | 是（`epoch`） | 會 |
| 切換跟隨開關（`follow`） | 是，且 106 行註解明講是刻意加入：「對應舊版 `$('#lg-follow').onchange = loadLog`，切換即時跟隨要重新整個流程」 | 會 |

**階段 2（跟隨 timer 純追加，`useLogFollow.ts:109-132`）**：`onData` callback（120-127 行）只呼叫 `setText(prev)`／`offsetRef.current = res.offset`／`setOffset`，**完全沒有呼叫 `setLoadId`**。截斷清空分支（123 行 `if (res.offset < offsetRef.current) setText('')`）也一樣不動 `loadId`——與 index.html:751 語意一致（截斷清空仍走追加迴圈，不是整批替換）。

結論：訊號在「整批載入」四種情境（切檔/改kb/重新載入/切follow）皆會變動，在「純追加」（含截斷清空分支）路徑保證不變。**訊號設計正確區分兩種情境**。

## 失效情境逐步推演（本次驗收核心）

第二版失效情境：跟隨關閉 → 檔案小、`kb` 視窗每次從頭讀起 → 檔案在兩次載入之間長大 → 使用者捲到一半按重新載入 → 新讀回的 tail 文字字面上等於「舊文字 + 新位元組」→ 舊版用 `text.startsWith(prev)` 誤判為「純追加」而套用 40px 閘門，該情境下使用者不在底部，於是不捲動（FAIL）。

逐步走過第三版程式碼：

1. **初始狀態**：`follow=false`（跟隨關閉）。因為 `useLogFollow.ts:110` `if (!path || !follow || missing) return`，階段 2 useEffect 直接 return，不建立任何訂閱——沒有 1500ms timer 在跑，符合「跟隨關閉」情境設定。
2. **使用者往上捲動**：`LogViewer.tsx:38-42` 的 `handleScroll` 把 `atBottomRef.current` 設為 `false`（因為 `scrollHeight-scrollTop-clientHeight >= 40`）。
3. **檔案在背景長大**（out of band，跟前端無關）。
4. **使用者按「重新載入」**：`LogsPage.tsx:103-105` 的 `onClick={() => log.reload()}` → `useLogFollow.ts:63-65` `reload = useCallback(() => setEpoch(e => e+1))` → `epoch` state +1。
5. `epoch` 是階段 1 useEffect 的依賴（`useLogFollow.ts:106`），效果重跑：`fetchLogTail(path, kb, ...)` 重新打 `/api/log/tail`。因為檔案變大、`kb` 視窗仍從檔尾往回讀固定 KB 數，若檔案仍小於視窗（沿用第二版失效情境的前提：檔案小到每次都從第 0 byte 讀起），回傳的 `res.text` 字面上確實是「舊文字 + 新增位元組」——**這步驟本身沒有改變，新版一樣會拿到「看起來像追加」的文字**。
6. 但緊接著 `useLogFollow.ts:87` `setText(res.text)`（整批替換 state）之後，`useLogFollow.ts:94` `setLoadId(id => id + 1)` 執行——**這是新版的關鍵差異**：不管 `res.text` 內容長什麼樣子，只要走到這個成功分支，`loadId` 一定遞增。
7. `LogsPage.tsx:117` 把 `log.loadId` 原封不動傳給 `LogViewer` 的 `reloadToken` prop。`LogViewer` 重新渲染，`text` prop 變了（變成新的 tail 內容），`reloadToken` 也變了（從舊 loadId 變成新 loadId）。
8. `LogViewer.tsx:44-59` 的 useEffect 觸發：`isReplace = reloadToken !== prevReloadTokenRef.current` → `true`（因為 loadId 剛遞增）。
9. `LogViewer.tsx:56` `if (isReplace || atBottomRef.current) el.scrollTop = el.scrollHeight`——`isReplace` 為 `true`，短路成立，**不看 `atBottomRef.current`（此時是 `false`，使用者還在上面）**，直接無條件捲到底。

**結論：新邏輯會無條件捲到底。** 差異的關鍵在於：第二版判斷「是不是整批替換」問的是「新文字看起來像不像舊文字的延伸」（內容問題，本質上有歧義、可被檔案剛好長成這樣的位元組騙過）；第三版問的是「這次 setText 是不是從 phase-1 tail 成功分支呼叫的」（呼叫端結構問題，不看內容，不會被檔案增長的巧合位元組混淆）。第二版失效的根因（heuristic 對「使用者重新載入、文字剛好長成 舊+新位元組」這個情境的內容判斷是本質上有歧義的）在第三版被移除了猜測本身，而不是修補猜測規則，所以此路徑無法再重現失效。

## 其他漏洞探查

嘗試找「訊號該變而不變、或不該變而變」的情境：

1. **快速連續操作（如連按兩次重新載入）**：`epoch` 是單調遞增計數，每次呼叫 `reload()` 都 +1，`useEffect` 依賴陣列偵測到值變化就會重跑（React 用 `Object.is` 比較，每次都是不同的整數，不會漏判）。沒有找到會被去重/合併掉的路徑。
2. **`follow` 開關與階段 2 訂閱的重建時序**：`epoch` 同時也是階段 2 useEffect 的依賴（`useLogFollow.ts:132` `[path, follow, missing, epoch]`）。當 `reload()` 觸發 `epoch` 變化時，React 会同一次 commit 內先跑完所有 cleanup（階段 1 舊 fetch 的 abort + 階段 2 舊訂閱的 `unsubscribe()`），再跑所有 setup（階段 1 新 fetch，非同步；階段 2 新 `subscribe()`，其內部 `transport.ts` 的 `run(false)` 是「首次載入立即打一次，不等第一個間隔」——即同步呼叫，但底層 fetch 非同步）。也就是說，若 `follow=true`，重新載入當下，階段 2 的新訂閱會立刻用**尚未被階段 1 更新的舊 `offsetRef.current`** 打一次 `/api/log/since`，理論上可能在階段 1 tail 完成前先 `setText(prev => prev + res.text)` 一次，產生短暫的中間態文字。但這個中間態不影響最終結果：階段 1 完成後一定會 `setText(res.text)`（整批覆蓋）並遞增 `loadId`，`LogViewer` 一定會因為 `loadId` 變動而無條件捲到底，最終狀態與捲動行為都正確收斂。**這不是能繞過 `loadId` 訊號的漏洞**，只是一個與本次 BLOCKER（捲動行為）無關的非阻斷性競態瑕疵（可能造成短暫畫面內容閃爍），舊版 vanilla 不會有這個瑕疵（因為 `loadLog()` 是先 `clearInterval` 再 `await` tail、完成後才重開 timer，順序化避免了這個交錯）。列在這裡供參考，不影響 VERIFY_RESULT 判定，因為題目關注的是捲動行為而非文字內容的暫態正確性，且未在規格描述的失效情境範圍內。
3. **`loadId` 只在成功分支遞增，失敗（`.catch`）不遞增**（`useLogFollow.ts:96-101`）：若 tail 請求失敗，`text` 不會被覆寫、`loadId` 也不變——不會有「訊號變了但 text 沒真的整批替換」的不一致。
4. **`path=null`（未選檔案）的 early return 分支**（`useLogFollow.ts:71-80`）：不會呼叫 `setLoadId`，`loadId` 維持不變；此分支下 `text` 被清空，但 `LogsPage` 裡 `path` 為 `null` 時 `<select>` 仍會渲染、`LogViewer` 仍會收到空字串，不構成訊號誤用。
5. 沒有找到訊號「不該變而變」的情境——遍歷了 `setLoadId` 的唯一呼叫點（`useLogFollow.ts:94`），確認別無他處會呼叫它。

## 迴歸檢查

- **`LogViewer` 全專案呼叫點**（grep `<LogViewer`）：共 4 處。
  - `frontend/src/pages/LogsPage.tsx:114`（本次改動對象，傳 `autoScroll` + `reloadToken`）
  - `frontend/src/pages/workers/WorkerDetail.tsx:22`（`<LogViewer text={text} height="auto" maxHeight="30vh" />`，未傳 `autoScroll`/`reloadToken`）
  - `frontend/src/pages/pipelines/AgentConversationCard.tsx:69`（Prompt 區塊，未傳 `autoScroll`/`reloadToken`）
  - `frontend/src/pages/pipelines/AgentConversationCard.tsx:89`（rawStdout 區塊，未傳 `autoScroll`/`reloadToken`）
  
  這三個未傳 `reloadToken` 的呼叫端都保持 `autoScroll` 預設 `false`，`LogViewer.tsx:44-59` 的整段 effect 邏輯被 `if (autoScroll && el)` 短路跳過（`autoScroll` 為 `false` 時整個 if block 不執行；`prevReloadTokenRef.current = reloadToken` 那行在 if block 外會照樣執行，但因為 `autoScroll=false` 這個 ref 完全不影響任何捲動行為）。**行為完全不變，無迴歸**。
- **`sleep`/`setTimeout` 延遲檢查**：`grep -rn "setTimeout\|sleep(" frontend/src` 零命中。唯一計時器是 `setInterval`（`LOG_FOLLOW_INTERVAL_MS`／`POLL_INTERVAL_MS`，皆為既有週期排程器，硬規則允許）。**沒有引入禁用的等待模式**。
- **`useLogFollow` 既有行為（截斷清空、切換跟隨重拉 tail）**：
  - 截斷/輪替清空：`useLogFollow.ts:121-123` 保留，邏輯與 index.html:751 一致（見上方訊號設計驗證表格）。
  - 切換跟隨開關重新拉 tail（index.html:823 `$('#lg-follow').onchange = loadLog`）：`follow` 在階段 1 useEffect 依賴陣列內（`useLogFollow.ts:106`），確認切換會觸發重新 `fetchLogTail`。**兩者皆保留，無迴歸**。
- **`bunx tsc --noEmit -p tsconfig.app.json`**：零錯誤（`TSC_OK`）。

## 總結

三個判準全數通過：(1) 內容形狀猜測（`text.startsWith(prev)` 及同類寫法）已完全移除，全專案 grep 確認 `useLogFollow.ts`/`LogViewer.tsx` 內零殘留；(2) 新訊號 `loadId`/`reloadToken` 的變動時機精確對應「整批載入」四種情境（切檔/改kb/重新載入/切follow），且在「純追加」路徑（含截斷清空分支）保證不變；(3) 針對第二版明確失效的具體情境（跟隨關閉、檔案小到每次從頭讀、檔案在兩次載入間長大、使用者捲到一半按重新載入）逐行推演，確認新版靠 `loadId` 遞增這個呼叫端結構訊號（而非內容比對）判定為整批替換，因此無條件捲到底，不會被巧合位元組騙過。額外找到一個非阻斷性競態瑕疵（`follow=true` 時 reload 瞬間，階段 2 新訂閱可能用尚未更新的舊 offset 打一次 since，造成短暫文字閃爍），但不影響捲動行為的最終正確性，且不在本次 BLOCKER 的規格範圍內。迴歸檢查（呼叫點、`sleep`/`setTimeout`、既有截斷與切換跟隨行為、tsc）全部乾淨。

判定：**PASSED**。
