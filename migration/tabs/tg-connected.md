> ⚠️ 行號基準：本文件引用的 **server.ts 行號**是 2026-09-02 新增 `/next/*` 靜態路由**之前**的版本，
> 該次改動在第 44 行後插入 15 行，因此第 44 行之後的 server.ts 行號請 **+15**。
> **index.html 的行號正確無須調整**（該檔未被修改）。

# TG 已連接（`#tab-tg-connected`）

「連接」大分頁下第二個 subtab。單一表格頁，每列 2 個操作按鈕（測試發送 / 取消連接）。

## 1. 畫面結構

```
section#tab-tg-connected (hidden 由 showTab 控制)   (L238-246)
├── div.subnav                                       (L239-243，與 tokens.md/tg-pending.md 完全重複的一份，非共用 DOM)
│   ├── button.subtab[data-tab=tokens] onclick=showTab('tokens')          "Token 權限"
│   ├── button.subtab[data-tab=tg-connected] onclick=showTab('tg-connected') "TG 已連接"
│   └── button.subtab[data-tab=tg-pending] onclick=showTab('tg-pending')   "TG 待處理"
├── div.bar                                          (L244)
│   ├── button#tuc-reload.btn "重新整理"
│   └── span.mute "tech-users.csv 已回填 tg_chat_id 的人。"
└── div.card                                          (L245)
    ├── h3 "已連接（<span#tuc-n>0</span>）"
    └── div.scroll#tuc-list  （表格由 JS 填入，見 §3）
```

## 2. 資料來源

- `GET /api/tg-users`（`loadTgConnected()` L761-765）
  - 回傳 `{ connected, pending, techUsers }`；本頁只用 `d.connected`（陣列，每筆含 `name`、`email`、`chat_id`）。
  - server 端（server.ts `/api/tg-users` L516-518）：`connected: loadConnectedUsers()` — 讀 `tech-users.csv` 裡已回填 `tg_chat_id` 的列。
- 呼叫時機：
  - 切到「連接」分頁的 TG 已連接 subtab 時（`showTab('tg-connected')` → `refresh(true)`）。
  - 5 秒輪詢：`refresh()` 在 `tab==='tg-connected'` 時無條件呼叫 `loadTgConnected()`（L836，不像 tg-pending 有 focus 保護）。
  - `#tuc-reload` 按鈕點擊。
  - 每次「測試發送」不重載列表（該操作不改變資料）；「取消連接」成功後重載（見 §4）。
- 「總覽」分頁的 `#tg-summary` 卡片有一個連到本頁的連結（"已連接 N `<a href="#tg-connected" onclick="showTab('tg-connected')">查看</a>`"，L316），但那個連結屬於 overview 分頁範疇，不計入本頁互動點。

## 3. 渲染邏輯

`#tuc-list`（`loadTgConnected()` L763-764）表格欄位：`姓名`、`email`、`chat_id`、操作（無表頭文字）。
- `姓名`：`<b style="color:var(--acc)">${esc(u.name)}</b>`（強調色）。
- `email`：等寬字體（`class="mono"`），原文。
- `chat_id`：等寬字體，原文。
- 操作欄：固定 2 個按鈕（測試發送 / 取消連接），見 §4。
- `#tuc-n`：`d.connected.length`。
- 空資料：`<div class="mute">尚無已連接的同事</div>`（取代整個 table）。
- 無排序邏輯——直接依 API 回傳順序渲染（後端未特別排序，即 CSV 原始順序）。

## 4. 互動功能（3 個）

1. **subnav「Token 權限」/「TG 已連接」/「TG 待處理」**（L240-242）：`onclick="showTab('tokens'|'tg-connected'|'tg-pending')"`，同 tokens.md 所述機制，三份 subnav 各自獨立存在於三個 section 內。

2. **重新整理 `#tuc-reload`**（L244，JS L766）：`onclick = loadTgConnected`。無 confirm，立即重打 `/api/tg-users`。

3. **每列「測試發送」按鈕**（L764 `onclick="testSendTgUser('${u.email}')"`，JS L767-772 `testSendTgUser()`）：
   - `prompt("要發送的測試訊息：", "這是一則來自 tg-monitor 的測試訊息")`（有預設值）；取消（`null`）則中止，不送出。
   - `POST /api/tg-users/test` body `{email, text}`。
   - 成功：`alert("已送出：${r.result}")`。
   - 失敗：`alert("送出失敗：${r.result}")`。
   - **不重新整理列表**（此操作不改變連接狀態）。

4. **每列「取消連接」按鈕**（L764 `onclick="unsetTgUser('${u.email}','${u.name}')"`，JS L773-778 `unsetTgUser()`）：
   - `confirm("確定要取消 ${name}（${email}）的 Telegram 連接嗎？取消後這個人不會再收到 pipeline 通知，需要重新 DM bot 才能再連上。")`
   - `POST /api/tg-users/unset` body `{email}`。
   - 成功（`r.ok`）：**不彈 alert**，直接 `loadTgConnected()` 重新整理列表，`return`。
   - 失敗：`alert("取消失敗：${r.result}")`（不重載）。

> 註：第 3、4 點按鈕在同一列，實際上是 3 個互動點（測試發送、取消連接）+ reload + 3 個 subnav = 5 個 DOM 位置，但「測試發送」「取消連接」是每列重複渲染的模板，grep 命中的是模板原始碼裡各 1 次 `onclick=`（見文末統計），非「每列各算一次」。

## 5. 狀態與邊界

- **載入中**：無 loading 骨架，`await` 期間畫面維持上次內容。
- **空資料**：`<div class="mute">尚無已連接的同事</div>`。
- **錯誤**：`fetch` 失敗走 `.catch(e=>({ok:false,result:String(e)}))`，於「測試發送」「取消連接」的失敗分支統一用 `alert()` 呈現，無 inline 錯誤區塊。
- `GET /api/tg-users` 本身若失敗，`api()` helper（`fetch(p).then(r=>r.json())`）沒有 try/catch，例外會被 `refresh()` 的外層 `try{...}catch(e){console.error(e)}`（L839）吞掉，畫面停留在舊資料，僅 console 有紀錄，UI 無任何提示。

## 6. 原始碼行號對照

| 區塊 | HTML | JS render | JS event handler |
|---|---|---|---|
| section 容器 / subnav | L238-243 | `showTab()` L284 | 三個 subtab 各自 inline onclick |
| bar / reload | L244 | — | `$('#tuc-reload').onclick = loadTgConnected` L766 |
| 已連接表格 | L245 | `loadTgConnected()` L761-765 | `testSendTgUser()` L767-772，`unsetTgUser()` L773-778 |
| refresh 輪詢整合 | — | — | `refresh()` L836：`tab==='tg-connected'` 分支 |

---

**本頁互動點：6 個，grep onclick 命中 6**（HTML 靜態區段 `sed -n '238,246p'` 命中 `onclick=` 3 次：3 個 subtab；JS 區段 `sed -n '760,778p'` 命中 `onclick=`/`.onclick =` 3 次：「測試發送」「取消連接」模板字串各 1 次 + `#tuc-reload` 賦值 1 次）。
