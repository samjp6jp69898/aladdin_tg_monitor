# TG 待處理分頁 — Parity 對照表

實作範圍：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/TgPendingPage.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/tg-pending/techUserResolve.ts`

規格依據：`migration/tabs/tg-pending.md`（5 個互動點，§4）、`migration/02-frontend-contract.md`
§7（tg-pending 輪詢守門規則）、§8 第 5 條（tg-connected / tg-pending 各自打一次
`/api/tg-users`，不共用 cache）。

---

## 1. 互動功能對照表（tg-pending.md §4，5 項）

| # | 規格項目 | 實作位置 |
|---|---|---|
| 1 | subnav「Token 權限」/「TG 已連接」/「TG 待處理」 | 由共用層 `src/components/shell/ConnectLayout.tsx` 統一渲染（`App.tsx` 用 `<Route element={<ConnectLayout />}>` 包住 tokens/tg-connected/tg-pending 三條路由）。本頁不重畫，依契約 §4「SubNav」段落規則。 |
| 2 | 重新整理 `#tup-reload` | `TgPendingPage.tsx:111`（`<Button onClick={() => reload()}>重新整理</Button>`）。無 confirm，直接呼叫 `useResource` 的 `reload()`，本身就是使用者主動動作，不受 `shouldPoll` 守門影響（守門只作用在背景輪詢，見第 5 項）。 |
| 3 | 每列輸入框 `input[list=tup-techusers]` | `TgPendingPage.tsx:88-98`：純文字輸入，值存進 `inputs[chat_id]` state（`onChange`），無 onchange 業務邏輯——與舊版一致，值只在按「指定」時才被讀取。`list="tup-techusers"` 對應瀏覽器原生 `<datalist>`（`TgPendingPage.tsx:131-135`）。 |
| 4 | 每列「指定」按鈕 | `TgPendingPage.tsx:37-58`（`assignTgUser(chatId, force)`）：先呼叫 `resolveTechUserEmail()`（`tg-pending/techUserResolve.ts:24-40`），解析不出 email → `window.alert(reason || '請先選一位技術人員')` 中止、不打 API；否則 `useAction().run(() => postTgUserAssign({chat_id, email, force}))`；成功 → `alert('指定成功：...')` + `reload()`；失敗且訊息以 `SET_CONFLICT` 開頭 → `window.confirm(...)` 確認後遞迴呼叫 `assignTgUser(chatId, true)`（帶 `force:true`）；取消則不再動作；其他失敗 → `alert('指定失敗：...')`。按鈕在 `action.pending` 期間 disable（`TgPendingPage.tsx:100`），與 workers/tokens 頁一致的既有共用 pattern。 |
| 5 | `isPickingTechUser()` 輪詢保護 | `TgPendingPage.tsx:26-28`：`useResource(topics.tgUsers, undefined, { shouldPoll: () => !document.activeElement?.id?.startsWith('tup-sel-') })`，直接沿用契約 §3.1 範例寫法，語意與舊版 `isPickingTechUser()`（判斷 `document.activeElement.id` 是否以 `tup-sel-` 開頭）完全一致。 |

**5/5 對應完成。**

---

## 2. 渲染欄位對照表（`#tup-list` 表格，`TgPendingPage.tsx:60-106` 的 `DataTable` columns）

| 舊版欄位 | 實作 |
|---|---|
| `chat_id`（等寬） | `className:'mono'`，`render: p => p.chat_id`（`TgPendingPage.tsx:61`） |
| `first_name`（+ 有 `last_name` 才接空白再接 `last_name`） | `render: p => \`${p.first_name ?? ''}${p.last_name ? ' ' + p.last_name : ''}\`` （`TgPendingPage.tsx:63-66`），與舊版 `${esc(p.first_name)}${p.last_name?' '+esc(p.last_name):''}` 邏輯一致（React 自動跳脫，不需要 `esc`） |
| `username`（有值才顯示 `@username`，等寬） | `className:'mono'`，`render: p => p.username ? \`@${p.username}\` : ''`（`TgPendingPage.tsx:67-72`） |
| `最後訊息`（`fmt(last_ts)` + 灰字小字 `ago(last_ts)`） | `className:'mono mute'`，`render: p => <>{fmt(p.last_ts)} <span className="mute">{ago(p.last_ts)}</span></>`（`TgPendingPage.tsx:73-82`），用 `src/lib/format.ts` 的 `fmt`/`ago`，行為與舊版一致 |
| `指定技術人員`（input + button） | `render` 見互動點 #3/#4（`TgPendingPage.tsx:83-105`） |
| 標題 `待處理（N）` | `Card title` 內插 `pending.length`（`TgPendingPage.tsx:116-121`），不需要舊版 `#tup-n` span，React 隨資料重繪自動更新 |
| `<datalist id="tup-techusers">`，選項 = `techUserLabel(u)` | `TgPendingPage.tsx:131-135`，`techUserLabel()` 定義於 `tg-pending/techUserResolve.ts:11-13`：`"${name} <${email}>"` + 已連接者加註 `（現有 chat_id：${chat_id}）`，與舊版 `techUserLabel` 完全一致 |

---

## 3. 狀態與邊界對照（tg-pending.md §5）

| 規格 | 實作 |
|---|---|
| 載入中：無 loading 骨架 | `TgPendingPage.tsx` 不寫 `loading`/`error` 分支，直接把 `pending = data?.pending ?? []` 餵給 `DataTable`；首次載入完成前 `pending` 為空陣列，畫面與「目前沒有待處理的新 DM」的空狀態相同，不額外顯示「載入中…」文字。對應舊版 `refresh()`（`index.html:824-838`）整個 `try{...}catch(e){console.error(e)}` 包住、無論成功失敗都不特別渲染 loading/error 狀態的行為。 |
| 空資料 `目前沒有待處理的新 DM`，取代整個表格且不渲染 datalist | `DataTable` 的 `emptyMode="replace"` `emptyText="目前沒有待處理的新 DM"`（`TgPendingPage.tsx:123-129`）；`datalist` 額外包一層 `{pending.length > 0 && (...)}`（`TgPendingPage.tsx:130-136`），空資料時不渲染，與舊版 `d.pending.length ? ... : '<div class="mute">...</div>'`（不含 `techUserDatalistHtml()`）一致。 |
| `assignTgUser` fetch 失敗 → 落入「其他失敗」分支 `alert("指定失敗：${r.result}")` | `useAction().run()` 內部 `try/catch` 會把拋出的例外轉成 `errorToActionResult(err)`（`src/lib/mutation.ts:28-30`，`{ok:false, message:String(err)}`），行為等同舊版 `.catch(e=>({ok:false,result:String(e)}))`；`out.ok` 為 false 且訊息不以 `SET_CONFLICT` 開頭，直接落入 `TgPendingPage.tsx:57` 的「其他失敗」分支。 |
| SET_CONFLICT 兩段式 confirm 覆蓋流程 | 見互動點 #4，`TgPendingPage.tsx:50-56`。 |
| 併發編輯風險（已知限制，非 bug）：另一分頁把某人指定掉後，本分頁下次刷新該列直接消失 | 未特別處理，效果與舊版相同——`pending` 陣列直接來自輪詢後的 `data.pending`，該 chat_id 不在其中時該列自然不再渲染。`inputs` state 裡殘留的該 chat_id 輸入值不會被清除，但因為對應的 `<input>` 已不再渲染，無實際影響，與舊版「殘留在 `prevSel` 但沒有對應 DOM 元素可寫回」的無害殘留等效。 |
| 無自訂排序，依 API 回傳順序 | `rows={pending}` 直接傳入 `data.pending`（後端已依 `last_ts DESC` 排序），未加任何 `.sort()`。 |

---

## 4. 「輸入中的內容不被輪詢沖掉」如何實作

舊版靠「重繪前存值、重繪後寫回」補救（`loadTgPending()` L808-809/811）：因為它每次輪詢都用
`innerHTML` 整個重建 `#tup-list`，若不特地補救，使用者打到一半的搜尋字串會被清空的新 DOM
沖掉。React 版不需要這個補救——每列輸入框的值本來就存在**獨立於 `useResource` 資料**的
`inputs` state（key 是 `chat_id`），輪詢只換 `data`（觸發表格用新資料重新渲染），完全不會去動
`inputs`，所以文字自然留著，不需要任何額外的存值/寫回邏輯：

```tsx
const [inputs, setInputs] = useState<Record<string, string>>({})
...
<input
  ...
  value={inputs[p.chat_id] ?? ''}
  onChange={e => {
    const v = e.target.value
    setInputs(prev => ({ ...prev, [p.chat_id]: v }))
  }}
/>
```

（`TgPendingPage.tsx:31`、`94-98`）。这与契约 §8 的全站原则一致：「純 UI 状态（展开、勾选、
输入到一半的文字）存 React state，不被轮询覆盖」。

---

## 5. 未達成項目

無。5 個互動點、渲染欄位、狀態與邊界均已依規格與契約實作。

以下是實作時的**刻意技術選擇**（非缺項，記錄供 review 參考）：

1. **`assignTgUser` 共用單一 `useAction()` 實例**：與 `WorkersList.tsx` 相同的既有共用 pattern
   （單一 `action` 套用到所有列的按鈕，`action.pending` 期間全部「指定」按鈕一起 disable）。舊版
   完全沒有 pending 狀態下的按鈕 disable（`fetch` 期間可以連點），新版此處是比舊版更保守的行為
   升級，不影響功能正確性，且與其他頁一致。
2. **`Card` 標題不含 `#tup-n` id**：舊版用 `id="tup-n"` 的 `<span>` 讓 JS 手動改 `textContent`；
   React 版數字直接由 `pending.length` 內插進 JSX，隨資料重繪自動更新，不需要 id 掛勾。
3. **`techUserResolve.ts` 抽成獨立檔案**：`techUserLabel()`/`resolveTechUserEmail()` 依契約 §5
   點名「分頁專屬、不要放共用層」，故放在 `src/pages/tg-pending/` 底下而非共用層，也不直接寫死
   在 `TgPendingPage.tsx` 裡，方便日後單元測試（若需要）。

---

## 6. 驗收

```
cd /Users/user/aladdin/tg-monitor/frontend && bunx tsc --noEmit -p tsconfig.app.json
```
結果：零錯誤（PASS）。
