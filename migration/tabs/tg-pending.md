> ⚠️ 行號基準：本文件引用的 **server.ts 行號**是 2026-09-02 新增 `/next/*` 靜態路由**之前**的版本，
> 該次改動在第 44 行後插入 15 行，因此第 44 行之後的 server.ts 行號請 **+15**。
> **index.html 的行號正確無須調整**（該檔未被修改）。

# TG 待處理（`#tab-tg-pending`）

「連接」大分頁下第三個 subtab。顯示 DM 過 bot 但還沒回填 `tg_chat_id` 的人，每列有一個「搜尋輸入框 + 指定按鈕」讓維運者手動指定技術人員。含輪詢期間保護使用者正在操作下拉的邏輯。

## 1. 畫面結構

```
section#tab-tg-pending (hidden 由 showTab 控制)      (L248-256)
├── div.subnav                                       (L249-253，與 tokens.md/tg-connected.md 完全重複的一份，非共用 DOM)
│   ├── button.subtab[data-tab=tokens] onclick=showTab('tokens')          "Token 權限"
│   ├── button.subtab[data-tab=tg-connected] onclick=showTab('tg-connected') "TG 已連接"
│   └── button.subtab[data-tab=tg-pending] onclick=showTab('tg-pending')   "TG 待處理"
├── div.bar                                          (L254)
│   ├── button#tup-reload.btn "重新整理"
│   └── span.mute "DM 過 bot 但還沒對映回 CSV 的 chat_id。有人 DM 時會自動觸發 tg-auto-sync：高信心直接寫入，否則會通知維運者；這裡也可以直接手動指定。"
└── div.card                                          (L255)
    ├── h3 "待處理（<span#tup-n>0</span>）"
    └── div.scroll#tup-list  （表格 + `<datalist>` 由 JS 填入，見 §3）
```

每列「指定技術人員」欄的結構（JS 動態產生，`techUserSelectHtml()` L785-787）：
```
<input list="tup-techusers" id="tup-sel-{chat_id}" placeholder="輸入姓名或 email 搜尋" autocomplete="off">
<button class="btn" onclick="assignTgUser('{chat_id}')">指定</button>
```
表格外附加一個所有列共用的 `<datalist id="tup-techusers">`（`techUserDatalistHtml()` L788-790），選項為 `techUserLabel(u)` = `"${name} <${email}>"`（若該人已有 chat_id 則加註 `（現有 chat_id：${chat_id}）`）。

## 2. 資料來源

- `GET /api/tg-users`（`loadTgPending()` L804-812）
  - 回傳 `{ connected, pending, techUsers }`；本頁用 `d.pending`（待處理 DM 列表，每筆含 `chat_id`、`first_name`、`last_name`、`username`、`last_ts`）與 `d.techUsers`（全體技術人員清單，供 datalist 搜尋，每筆含 `name`、`email`、`chat_id?`）。
  - server 端：`pending: loadPendingSenders()`、`techUsers: loadAllTechUsers()`（server.ts L516-518）。
- 呼叫時機：
  - 切到本 subtab 時（`showTab('tg-pending')` → `refresh(true)`）。
  - 5 秒輪詢：`refresh()` 在 `tab==='tg-pending'` 時，若 `force`（來自「立即刷新」或切分頁）或 `!isPickingTechUser()` 才呼叫 `loadTgPending()`（L837）——**若使用者正 focus 在任一列的 `tup-sel-*` 搜尋輸入框，輪詢會跳過本次刷新**，避免打斷正在輸入/選擇的操作。
  - `#tup-reload` 按鈕。
  - 「指定」成功後重載（見 §4）。
- **重繪時保留使用者已輸入但未送出的搜尋框內容**：`loadTgPending()` 在重繪前先掃描所有 `[id^="tup-sel-"]` 元素、把非空值存進 `prevSel`（L808-809），`innerHTML` 覆蓋後再把值寫回同 id 的新元素（L811）——因為輪詢會整個重建 `#tup-list` 的 DOM，若不這樣做，使用者打到一半的搜尋字串會被沖掉。

## 3. 渲染邏輯

`#tup-list`（L810）表格欄位：`chat_id`、`first_name`、`username`、`最後訊息`、`指定技術人員`。
- `chat_id`：等寬字體。
- `first_name`：`first_name`（+ 有 `last_name` 才接一個空白再接 `last_name`）。
- `username`：有值才顯示 `@${username}`，等寬字體。
- `最後訊息`：`fmt(p.last_ts)` + `ago(p.last_ts)`（灰字小字附註相對時間），皆為 mute 樣式。
- `指定技術人員`：即 §1 所述 input+button。
- `#tup-n`：`d.pending.length`。
- 空資料：`<div class="mute">目前沒有待處理的新 DM</div>`（取代整個 table，此時也不渲染 datalist）。
- 無自訂排序，依 API 回傳順序。

**搜尋/比對邏輯（`resolveTechUserEmail()` L792-800）**：輸入框內容 → email 的解析順序：
1. 完整比對 `techUserLabel(u)`（`"姓名 <email>"`）或 `u.email` 全等 → 直接採用。
2. 否則轉小寫，比對 `name` 或 `email` 是否包含輸入字串（子字串），若**恰好命中 1 位**才採用。
3. 命中 0 位或多位 → 回傳空 email + `reason`（多位時 `「${t}」符合 ${hits.length} 位技術人員，請從下拉清單選一位`；0 位時 `找不到符合「${t}」的技術人員`）。

## 4. 互動功能（5 個，⚠️ 含 SET_CONFLICT 覆蓋確認的兩段式對話框）

1. **subnav「Token 權限」/「TG 已連接」/「TG 待處理」**（L250-252）：同前兩份文件所述機制。

2. **重新整理 `#tup-reload`**（L254，JS L813）：`onclick = loadTgPending`。無 confirm，且**會**強制刷新（此按鈕觸發的呼叫本身就是使用者主動動作，不受 `isPickingTechUser()` 保護邏輯影響——保護只作用在自動輪詢）。

3. **每列輸入框 `input[list=tup-techusers]`**：純文字輸入 + 瀏覽器原生 `<datalist>` 建議清單過濾，無 onchange/oninput handler；值在按下「指定」時才被讀取（`sel.value`）。

4. **每列「指定」按鈕**（`onclick="assignTgUser('${p.chat_id}')"`，JS L814-822 `assignTgUser(chatId, force)`）：
   - 讀對應輸入框的值，跑 `resolveTechUserEmail()`。
   - 解析不出 email（0 位或多位命中，或輸入為空）→ `alert(reason || '請先選一位技術人員')`，中止，**不打 API**。
   - `POST /api/tg-users/assign` body `{chat_id, email, force: !!force}`（首次呼叫 `force` 為 `undefined`）。
   - 成功：`alert("指定成功：${r.result}")`，`loadTgPending()`，`return`。
   - **失敗且訊息以 `SET_CONFLICT` 開頭**（代表這位技術人員已綁定不同 chat_id）：`confirm("${r.result}\n\n這位技術已經有不同的 chat_id，要覆蓋嗎？")`，若確認 → **遞迴呼叫 `assignTgUser(chatId, true)`**（帶 `force:true` 重打一次 `/api/tg-users/assign`，走同一個函式）；若取消則不再動作，也不 alert。
     > ⚠️ **2026-09-02 修正**：上一句「若取消則不再動作，也不 alert」與 `index.html:817-818` 的原始碼不符，本文件寫錯。原始碼是
     > `if (String(r.result).startsWith('SET_CONFLICT') && confirm(...)) { await assignTgUser(chatId, true); return }` 後緊接
     > `alert(\`指定失敗：${r.result}\`)`——`confirm` 取消（回傳 `false`）時整個 `if` 為假、不會 `return`，會直接落到下一行的
     > `alert('指定失敗：...')`。也就是說**取消時舊版其實還是會跳「指定失敗」的 alert**，不是「不再動作，也不 alert」。
     > 依 `02-frontend-contract.md` 硬邊界規則，`index.html` 為唯一事實來源；`frontend/src/pages/TgPendingPage.tsx` 的實作忠實複刻了原始碼的真實行為（取消後仍會跳「指定失敗」alert），維持現狀不用改，本頁只是文件描述有誤。
   - 其他失敗：`alert("指定失敗：${r.result}")`。

5. **`isPickingTechUser()` 輪詢保護**（L803）：非按鈕互動，但影響本頁自動刷新行為——判斷 `document.activeElement` 的 id 是否以 `tup-sel-` 開頭，是則本次 5 秒輪詢跳過 `loadTgPending()`。列入本節因其直接決定「使用者操作中是否被打斷」這個互動細節，重寫時容易遺漏。

## 5. 狀態與邊界

- **載入中**：無 loading 骨架。
- **空資料**：`<div class="mute">目前沒有待處理的新 DM</div>`。
- **錯誤**：`assignTgUser` 的 fetch 失敗走 `.catch(e=>({ok:false,result:String(e)}))`，落入「其他失敗」分支 `alert("指定失敗：${r.result}")`。
- **SET_CONFLICT 特殊分支**：見 §4 第 4 點，是本頁唯一的「失敗後二次 confirm 觸發同一動作帶不同參數重試」流程，其他 tab 沒有此模式。
- **併發編輯风险（已知限制，非 bug）**：多分頁/多人同時操作時，`prevSel` 只保留當前分頁自己打的字，另一分頁把某人指定掉後，本分頁下次刷新該列會直接消失（该 chat_id 不再是 pending）。

## 6. 原始碼行號對照

| 區塊 | HTML | JS render | JS event handler |
|---|---|---|---|
| section 容器 / subnav | L248-253 | `showTab()` L284 | 三個 subtab 各自 inline onclick |
| bar / reload | L254 | — | `$('#tup-reload').onclick = loadTgPending` L813 |
| 待處理表格 + datalist | L255 | `loadTgPending()` L804-812，`techUserSelectHtml()` L785-787，`techUserDatalistHtml()` L788-790，`techUserLabel()` L784 | `assignTgUser()` L814-822 |
| 搜尋比對邏輯 | — | `resolveTechUserEmail()` L792-800 | — |
| 輪詢保護 | — | — | `isPickingTechUser()` L803，於 `refresh()` L837 使用 |

---

**本頁互動點：5 個，grep onclick 命中 5**（HTML 靜態區段 `sed -n '248,256p'` 命中 `onclick=` 3 次：3 個 subtab；JS 區段 `sed -n '780,822p'` 命中 `onclick=`/`.onclick =` 2 次：「指定」按鈕模板字串 1 次 + `#tup-reload` 賦值 1 次）。
