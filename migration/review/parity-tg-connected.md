# TG 已連接分頁 — Parity 對照表

實作範圍：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/TgConnectedPage.tsx`

規格依據：`migration/tabs/tg-connected.md`（6 個互動點，§4）、`migration/02-frontend-contract.md` §8 第 5 條。

沒有新增 `src/pages/tg-connected/` 子元件——單一表格頁、6 個互動點全部落在一個檔案內，
拆檔反而違反 Rule 2（不做無謂抽象）。

---

## 1. 互動功能對照表（tg-connected.md §4，6 項，含 3 個 subnav + reload + 測試發送 + 取消連接）

| # | 規格項目 | 實作位置 |
|---|---|---|
| 1 | subnav「Token 權限」/「TG 已連接」/「TG 待處理」（HTML L240-242） | 由共用層 `src/components/shell/ConnectLayout.tsx` 統一渲染（`App.tsx` 用 `<Route element={<ConnectLayout />}>` 包住 tokens/tg-connected/tg-pending 三條路由）。本頁不重畫，依契約 §0「不得複製共用 DOM」與規格檔開頭「subnav 由殼層統一渲染」的指示。 |
| 2 | 重新整理 `#tuc-reload`（L244，JS L766：`onclick = loadTgConnected`） | `TgConnectedPage.tsx` Toolbar 內 `<Button onClick={() => reload()}>重新整理</Button>`，無 confirm，直接呼叫 `useResource` 的 `reload()` 重打 `GET /api/tg-users`。 |
| 3 | 每列「測試發送」按鈕（JS L767-772 `testSendTgUser()`） | `TgConnectedPage.tsx` 的 `handleTestSend(email)`：`window.prompt('要發送的測試訊息：', '這是一則來自 tg-monitor 的測試訊息')`，`text === null`（取消）中止；否則 `testAction.run(() => postTgUserTest(email, text))`，成功 `window.alert(\`已送出：${r.message}\`)`、失敗 `window.alert(\`送出失敗：${r.message}\`)`；**不呼叫 `reload()`**（此操作不改變連接狀態，與規格「不重新整理列表」一致）。 |
| 4 | 每列「取消連接」按鈕（JS L773-778 `unsetTgUser()`） | `TgConnectedPage.tsx` 的 `handleUnset(email, name)`：`unsetAction.run(() => postTgUserUnset(email), { confirm: ... })`，confirm 文案與舊版逐字相同；`useAction` 內建 `window.confirm`，取消回傳 `null` 即中止。結果分支手動處理（**不用 `onSettled`**，因為舊版成功/失敗的後續動作不對稱）：成功（`r.ok`）呼叫 `reload()`、**不 alert**；失敗 `window.alert(\`取消失敗：${r.message}\`)`、**不 reload**。 |
| 5 | `#tuc-n`（已連接人數） | `Card title={\`已連接（${connected.length}）\`}`，`connected = data?.connected ?? []`，逐輪詢更新，等同舊版 `d.connected.length`。 |
| 6 | 已連接表格本體（JS L763-764 `loadTgConnected()`，5 秒輪詢 `refresh()` L836 無條件呼叫） | `useResource(topics.tgUsers, undefined)`（預設 `autoRefresh: true` → 5000ms 輪詢，對應契約 §7 表格「tg-connected：無條件重查」一列），用共用 `DataTable` 渲染 `connected` 陣列。 |

**6/6 對應完成。**

---

## 2. 渲染欄位對照表

| 舊版欄位（`loadTgConnected()` 模板字串） | 實作（`DataTable` columns） |
|---|---|
| 姓名：`<b style="color:var(--acc)">${esc(u.name)}</b>` | `render: u => <b style={{ color: 'var(--acc)' }}>{u.name}</b>`（React 自動跳脫文字節點，等效 `esc()`） |
| email：`<td class="mono">${esc(u.email)}</td>` | `{ key: 'email', className: 'mono', render: u => u.email }` |
| chat_id：`<td class="mono">${esc(u.chat_id)}</td>` | `{ key: 'chat_id', className: 'mono', render: u => u.chat_id }` |
| 操作欄（無表頭文字）：測試發送 + 取消連接兩個按鈕 | `{ key: 'actions', render: ... }`（`header` 省略，`Column.header` 為 optional，未渲染 `<th>` 文字，等效舊版空表頭 `<th></th>`）；兩顆 `Button`（`variant="default"` / `variant="danger"`）之間以 `{' '}` 分隔，對應舊版模板字串按鈕間的原生空格。 |
| 表頭列：姓名 / email / chat_id / (空) | `DataTable` 預設 `showHeader=true`，四欄 `header` 依序為 `'姓名'` / `'email'` / `'chat_id'` / 省略。 |
| `rowKey` | `u => u.email`（`connected` 每列的 `ConnectedUser` 無獨立 id 欄位，`email` 在已連接名單中天然唯一，同 `lib/tg-users.ts` 的 CSV 語意）。 |

---

## 3. 狀態與邊界對照

| 規格 §5 項目 | 實作 |
|---|---|
| 載入中：無 loading 骨架，await 期間畫面維持上次內容 | `TgConnectedPage` 不使用 `useResource` 回傳的 `loading`，不畫任何 loading 分支；`connected` 直接由 `data?.connected ?? []` 算出，首次掛載到資料回來前渲染空陣列（`DataTable` 顯示 `emptyText`），資料回來後自動改渲染實際列，行為與舊版「`#tuc-list` 初始為空、`loadTgConnected()` resolve 後才填內容」等效收斂。 |
| 空資料：`<div class="mute">尚無已連接的同事</div>` | `DataTable` 的 `emptyText="尚無已連接的同事"`（`emptyMode` 預設 `'row'`，contract 的 `EmptyState`/`DataTable` 空狀態呈現皆為 `mute` 語氣，與舊版 class 一致）。 |
| 錯誤：`GET /api/tg-users` 失敗時舊版無任何 UI 提示（例外被 `refresh()` 外層 catch 吞掉，只留 console，畫面停留舊資料） | `TgConnectedPage` 刻意不讀取 `useResource` 回傳的 `error`、不畫錯誤區塊；`data` 在失敗時維持前一次成功值（`useResource` 內部行為），等效「畫面停留舊資料、無提示」。 |
| 錯誤：「測試發送」「取消連接」失敗一律 `alert()`，無 inline 錯誤區塊 | 兩者的失敗分支都用 `window.alert(...)`，未使用任何 inline 錯誤 UI（不畫 `action.result` 的 `err` div），與規格一致。 |
| 5 秒輪詢：無 focus 保護（不像 tg-pending 有 `isPickingTechUser()`） | `useResource(topics.tgUsers, undefined)` 未傳 `shouldPoll`，維持預設無條件輪詢，對應契約 §7「tg-connected：無條件重查」。 |
| 契約 §8-5：tg-connected / tg-pending 各自打一次 `/api/tg-users`，不共用 cache | 本頁獨立呼叫 `useResource(topics.tgUsers, undefined)`，未與 `TgPendingPage` 共享任何 hook 實例或模組層級快取。 |

---

## 4. 未達成項目

無。規格 6 個互動點、渲染欄位、狀態邊界均已對照實作完成；未依指示測試呼叫真實
`/api/tg-users/test`（會真的發訊息）或 `/api/tg-users/unset`（會真的解除他人綁定），
僅靜態核對程式碼與規格逐條對應，未做 Playwright 截圖比對（依指揮官分工，該步驟由
另一支 review agent 負責）。
