> ⚠️ 行號基準：本文件引用的 **server.ts 行號**是 2026-09-02 新增 `/next/*` 靜態路由**之前**的版本，
> 該次改動在第 44 行後插入 15 行，因此第 44 行之後的 server.ts 行號請 **+15**。
> **index.html 的行號正確無須調整**（該檔未被修改）。

# Token 權限（`#tab-tokens`）

「連接」大分頁下的第一個 subtab。是連接分頁裡互動最複雜的一頁：兩層視圖（列表 / 單人詳情）、一個新增表單、每列 3 個操作按鈕、詳情頁每環境 1 個操作按鈕 + 一組「依勾選重發」checkbox 群。

## 1. 畫面結構

```
section#tab-tokens (hidden 由 showTab 控制)
├── div.subnav                                   (L135-139)
│   ├── button.subtab[data-tab=tokens] onclick=showTab('tokens')          "Token 權限"
│   ├── button.subtab[data-tab=tg-connected] onclick=showTab('tg-connected') "TG 已連接"
│   └── button.subtab[data-tab=tg-pending] onclick=showTab('tg-pending')   "TG 待處理"
├── div.bar                                       (L140)
│   ├── button#tk-reload.btn                      "重新整理"
│   └── span.mute  "名冊來源：各 hosted MCP server 的 tokens*.json（只讀 id / display_name / 核發時間，絕不顯示 token 值）。"
├── div#tk-list-view                               (L141-160，列表視圖，預設顯示)
│   ├── div.card                                   (L142)
│   │   ├── h3 "Token 持有人（<span#tk-n>0</span> 人）"
│   │   └── div.scroll#tk-table                    （表格由 JS 填入，見 §3）
│   └── div.card                                   (L143-159，新增 token 表單)
│       ├── h3 "新增 token（核發新 kit）"
│       ├── div.bar                                (L144-157)
│       │   ├── input#tkc-id  placeholder="id（小寫英數/連字號/底線）"
│       │   ├── input#tkc-name placeholder="display_name（顯示名）"
│       │   ├── 9× label+input[type=checkbox].tkc-env（見下方環境清單，預設勾選標*）
│       │   └── button#tkc-create.btn "核發並發送到 Landon TG"
│       └── div.mute "依勾選環境核發：沒有的環境會新核發、已有的環境會重簽（舊 token 立即失效）。id 已存在時也能用，等同補齊/重簽這次勾選的環境，不會動到沒勾的既有環境。設定會發到 Landon 的 TG，由他轉交對方。"
└── div#tk-detail[hidden]                          (L161-180，單人詳情視圖)
    ├── div.bar                                    (L162)
    │   ├── button.btn onclick=closeTokenDetail() "← 返回列表"
    │   ├── span#tkd-title  （"id（display_name）"）
    │   ├── span#tkd-sub.mute （"N 個環境"）
    │   └── button#tkd-rename.btn "改名"
    └── div.card                                   (L163-179)
        ├── h3 "環境權限"
        ├── div.scroll#tkd-grants                  （每環境一列表格，見 §3）
        ├── div.mute （L164，見下方「文案」）
        ├── div.bar                                (L165-176，「依勾選重發」checkbox 群)
        │   ├── span.mute "依勾選重發："
        │   └── 9× label+input[type=checkbox].tkd-env（見下方環境清單，預設全不勾）
        ├── div.mute （L177，見下方「文案」）
        └── div.bar                                (L178)
            ├── button#tkd-resend.btn.warn "依勾選重發 token（新 kit 發到 Landon TG）"
            └── button#tkd-delete.btn.danger "刪除此人全部 token"
```

**環境清單（tkc-env / tkd-env 兩處共用，value 相同、新增表單有預設勾選 4 個）：**
| value | 顯示文字 | 新增表單預設勾選 |
|---|---|---|
| admin-dev | admin-dev | ✓ |
| platform | platform（dev × PK） | ✓ |
| platform-6t | platform（dev × 6T） | ✓ |
| admin-pre | admin-pre | |
| admin-evi | admin-evi | |
| platform-pre-pk | platform（pre × PK） | |
| platform-pre-6t | platform（pre × 6T） | |
| platform-evi-6t | platform（evi × 6T） | |
| toolsmith | toolsmith（工程師） | ✓ |

（`TK_MANAGED` 陣列，L412，就是這 9 個 value，決定「重發/刪除全部」動到哪些環境。）

## 2. 資料來源

- `GET /api/token-grants`（`loadTokenGrants()` L413-420，`loadTokenDetail()` L424-441）
  - 回傳 `{ services:[{id,name}], people:[{id,display_name,grants:{[serviceId]:{issued_at,last_ts,n}}}] }`
  - server 端（server.ts L570-586）把各 hosted MCP server 的 `tokens*.json` 名冊以「人」為主鍵樞紐，`last_ts`/`n` 是從 `events` 表按 `identity`（新舊兩種格式：display_name 或名冊 id）彙總的最後使用時間/次數。
- 呼叫時機：
  - 切到「連接」分頁或 tokens 分頁時（`showTab` → `refresh(true)`，L284/832）。
  - 5 秒輪詢（`setInterval(()=>refresh(false),5000)` L842）：`refresh()` 在 `tab==='tokens'` 時，若 `curTokenId` 有值（在詳情頁）呼叫 `loadTokenDetail()`，否則呼叫 `loadTokenGrants()`（L832）——即列表頁與詳情頁都會每 5 秒自動刷新。
  - 全域「↻ 刷新」按鈕、tk-reload 按鈕：都呼叫 `refresh(true)`。
  - 每個寫入操作（簽發/移除/改名/重發/刪除/新增）成功或失敗後都會 `await loadTokenDetail()` 或 `await loadTokenGrants()` 重新讀一次（見 §4 逐項）。
- 各寫入操作對應的 API：
  - `POST /api/token-grants/create` body `{id,name,services}` — 新增 token（新人）
  - `POST /api/token-grants/add` body `{id,service}` — 補簽單一環境（該環境尚無此 id 才允許，否則回 409 `ADD_ERR_EXISTS`）
  - `POST /api/token-grants/revoke` body `{id,services}` — 移除指定環境（列表頁「移除 token」帶全部 managed 環境；詳情頁「移除」單環境帶該環境）
  - `POST /api/token-grants/rename` body `{id,name}` — 改 display_name
  - `POST /api/token-grants/resend` body `{id}` 或 `{id,services}` — 重簽（不帶 services 時重簽此人現有全部 managed 環境；帶 services 時只動勾選的環境）

## 3. 渲染邏輯

### 列表頁 `#tk-table`（L416-419）
表格欄位：`id`、`display_name`、`操作`。
- `id`：等寬字體、強調色（`<b style="color:var(--acc)">`）。
- `display_name`：原文。
- 操作欄：固定 3 個按鈕（詳情 / 重發 token / 移除 token），見 §4。
- 空資料：`<div class="mute">名冊為空</div>`。
- `#tk-n`：`tkData.people.length`。

### 詳情頁 `#tkd-grants`（L431-439）
表格欄位：`環境`、`狀態`、`核發時間`、`使用`、`操作`，一列一個 service（`tkData.services`，固定 9 個環境全列出，不管此人有沒有）。
- `狀態`：`p.grants[s.id]` 存在 → `<span class="pill ok">有權限</span>`；不存在 → `<span class="mute">—</span>`。
- `核發時間`：`fmt(g.issued_at)`（`toLocaleString('zh-TW',{hour12:false})`），無權限則空白。
- `使用`：有權限時 `${g.n} 次 · ${ago(g.last_ts)}`；`n===0` 時顯示「未使用過」；`ago()` 格式化為 `Ns前`/`Nm前`/`Nh前`/`Nd前`。無權限則空白。
- `操作`：有權限 → 「移除」按鈕（danger）；無權限 → 「簽發」按鈕。
- 渲染完後同步把 `.tkd-env` 每個 checkbox 的勾選狀態設為 `!!p.grants[cb.value]`（L440，*注意*：這一行只在 `loadTokenDetail` 執行時跑一次，設定的是「此人目前有的環境」，不是使用者手動勾選的暫存值——每次輪詢重繪都會被這行覆蓋回「目前有權限的環境」，使用者若曾手動勾/取消非目前狀態的框，5 秒後會被沖掉）。
- `#tkd-title`：`${p.id}（${p.display_name}）`；`#tkd-sub`：`${Object.keys(p.grants).length} 個環境`。

## 4. 互動功能（⚠️ 本頁重點：14 個互動點）

1. **subnav「Token 權限」/「TG 已連接」/「TG 待處理」**（L136-138）：`onclick="showTab('tokens'|'tg-connected'|'tg-pending')"`。切換 `main > section` 顯示哪個、subnav/nav 按鈕的 `.on` class，並觸發一次 `refresh(true)`。三個 subtab 在三個 section（tab-tokens / tab-tg-connected / tab-tg-pending）裡各自完整重複一份（不是共用 DOM），三份按鈕、onclick、文字完全相同。

2. **重新整理 `#tk-reload`**（L140，JS L421）：`onclick = () => refresh(true)`。無 confirm，立即重打 `/api/token-grants`。

3. **新增 token 表單 → `#tkc-create`「核發並發送到 Landon TG」**（L156，JS L457-468 `createToken()`，綁定 L468）：
   - 讀 `#tkc-id`、`#tkc-name`、勾選的 `.tkc-env`。
   - 前端校驗（**無 confirm 前**，不合格直接 `alert()` 擋下、不打 API）：
     - id 不合 `^[a-z][a-z0-9_-]{1,31}$` → alert `"id 格式不合法：小寫英數/連字號/底線，2-32 字，且以小寫字母開頭。"`
     - name 空 → alert `"請填 display_name。"`
     - 未勾任何環境 → alert `"至少勾一個環境。"`
   - 通過後 `confirm("確定要核發 ${id}（${name}）的新 kit？\n\n環境：${services.join(', ')}\nkit zip + 使用說明會發到 Landon 的 TG。")`，取消則不送出。
   - 送出 `POST /api/token-grants/create` body `{id,name,services}`。
   - 成功：`alert("已核發並發送。\n\n${r.result}")`，清空 `#tkc-id`/`#tkc-name`，`await loadTokenGrants()`。
   - 失敗：`alert("核發失敗：${r.result}")`（欄位不清空、不重載）。

4. **列表頁每列「詳情」按鈕**（L418 `onclick="openTokenDetail('${p.id}')"`，JS L422）：切到詳情視圖（`#tk-list-view.hidden=true`、`#tk-detail.hidden=false`），`curTokenId=id`，呼叫 `loadTokenDetail()`。無 confirm。

5. **列表頁每列「重發 token」按鈕**（L418 `onclick="resendKit('${p.id}')"`，不帶 services 參數）：見下方第 11 點 `resendKit` 共用邏輯（此處 services 省略 → 重簽此人現有全部 managed 環境）。

6. **列表頁每列「移除 token」按鈕**（L418 `onclick="removeAllTokens('${p.id}')"`，JS L498-506）：
   - 算出 `managed = Object.keys(p.grants).filter(s=>TK_MANAGED.includes(s))`；若為空直接 return（不彈窗）。
   - `confirm("確定要刪除 ${id}（${display_name}）的全部 token？\n\n環境：${managed.join(', ')}\n立即生效、dist/${id}/ 會一併移除，此人將完全無法使用後台工具。")`
   - `POST /api/token-grants/revoke` body `{id, services: managed}`。
   - 成功 `alert("已刪除。\n\n${r.result}")`；失敗 `alert("刪除失敗：${r.result}")`。
   - 之後：若 `curTokenId===id` 則 `loadTokenDetail()`（詳情頁誤觸此路徑理論上不會，因這顆按鈕只在列表頁存在），否則 `loadTokenGrants()`。

7. **詳情頁「← 返回列表」**（L162 `onclick="closeTokenDetail()"`，JS L423）：`curTokenId=null`，切回列表視圖並 `loadTokenGrants()`。

8. **詳情頁「改名」`#tkd-rename`**（L162，JS L469-480 `renameToken()`）：
   - `prompt("${p.id} 的新 display_name：", p.display_name)`；取消（回傳 `null`）則整個中止。
   - trim 後為空 → `alert("display_name 不能為空。")`，中止。
   - 與原名相同 → 靜默 return（不打 API）。
   - `POST /api/token-grants/rename` body `{id,name}`。
   - 成功 `alert("已改名。\n\n${r.result}")`；失敗 `alert("改名失敗：${r.result}")`。
   - 之後 `await loadTokenDetail()`。

9. **詳情頁每環境列「簽發」按鈕**（L438 `onclick="addGrant('${p.id}','${s.id}')"`，JS L448-456）：
   - `note`：`service==='toolsmith'` 時為 `"設定片段（含 token）會以 TG 訊息發到 Landon，由他一對一轉交本人。"`；否則為 `"會重建 dist/${id}/（既有環境的 token 不變）。對方要拿到更新後的 kit 才用得到，可用「重發 token」或 TG /kit 重發 zip。"`
   - `confirm("確定要為 ${id} 簽發「${service}」的新 token？\n\n${note}")`
   - `POST /api/token-grants/add` body `{id,service}`。
   - 成功 `alert("已簽發。\n\n${r.result}")`；失敗 `alert("簽發失敗：${r.result}")`（例如環境已有 token 時後端回 409 `ADD_ERR_EXISTS`）。
   - 之後 `await loadTokenDetail()`。

10. **詳情頁每環境列「移除」按鈕**（L438 `onclick="revokeGrant('${p.id}','${s.id}')"`，JS L442-447）：
    - `confirm("確定要移除 ${id} 在「${service}」的 token？\n\n立即生效，對方這個環境下一個 request 起 401。")`
    - `POST /api/token-grants/revoke` body `{id, services:[service]}`。
    - 成功 `alert("已移除。\n\n${r.result}")`；失敗 `alert("移除失敗：${r.result}")`。
    - 之後 `await loadTokenDetail()`。

11. **`resendKit(id, services?)` 共用函式**（JS L485-497，被第 5 點與第 12 點呼叫）：
    - `services` 省略（列表頁按鈕）：`managed = Object.keys(p.grants).filter(...)`；若空直接 return。文案 `"會重簽全部現有環境（${managed.join(', ')}）的 token——舊 token 立即失效，對方換到新 kit 前完全無法使用。"`
    - `services` 有值（詳情頁按鈕，見下）：文案 `"依勾選的環境（${services.join(', ')}）核發/重簽——沒有的環境會新核發，已有的環境會重簽（舊 token 立即失效），沒勾的環境不動。"`
    - `confirm("確定要重發 ${id}（${display_name}）的 kit？\n\n${desc}\n新設定會發到 Landon 的 TG，由他轉交對方。")`
    - `POST /api/token-grants/resend` body `services?{id,services}:{id}`。
    - 成功 `alert("已重發。\n\n${r.result}")`；失敗 `alert("重發失敗：${r.result}")`。
    - 之後：`curTokenId===id` → `loadTokenDetail()`，否則 `loadTokenGrants()`。

12. **詳情頁「依勾選重發 token」`#tkd-resend`**（L178，JS L507-511）：先讀勾選的 `.tkd-env`；未勾任何一個 → `alert("至少勾一個環境。")`，中止（不進 `resendKit` 也不彈 confirm）。否則呼叫 `resendKit(curTokenId, services)`（走上方第 11 點的「有 services」分支）。

13. **詳情頁「刪除此人全部 token」`#tkd-delete`**（L178，JS L512）：`onclick = () => removeAllTokens(curTokenId)`，邏輯同第 6 點。

14. **詳情頁「依勾選重發」9 個 `.tkd-env` checkbox**：純狀態輸入，勾選結果由第 12 點按鈕讀取；無獨立 onclick，本身不觸發 API，也會被 §3 提到的「每次 `loadTokenDetail` 重繪都重設回目前權限狀態」影響（5 秒輪詢期間手動勾選可能被沖掉）。
    （新增表單的 9 個 `.tkc-env` checkbox 同樣是純狀態輸入，供第 3 點讀取，不獨立列點。）

## 5. 狀態與邊界

- **載入中**：無專屬 loading 狀態／骨架，`fetch` 期間畫面維持上一次渲染內容不變（`await` 期間 DOM 不清空）。
- **空資料**（列表頁名冊為空）：`<div class="mute">名冊為空</div>`（`#tk-table` 內，取代整個 table）。
- **詳情頁找不到此人**（例如另一個瀏覽器分頁把這個人的 token 全刪了，本分頁輪詢時撲空）：`loadTokenDetail()` L428 `if (!p) { closeTokenDetail(); return }`，自動切回列表頁，無提示訊息。
- **錯誤**：所有寫入操作走 `.catch(e=>({ok:false,result:String(e)}))`，網路層錯誤與後端業務錯誤（如 409）統一以 `alert("XX失敗：${r.result}")` 呈現，不特別區分。無 toast／inline error，一律用瀏覽器原生 `alert`。
- API 層的已知業務錯誤字串前綴（供錯誤訊息比對邏輯移植時參考）：`ADD_ERR_ARGS`、`ADD_ERR_EXISTS`、`ADD_ERR_NOT_FOUND`、`REVOKE_ERR_ARGS`、`RENAME_ERR_ARGS`、`RENAME_ERR_NOT_FOUND`（server.ts）。

## 6. 原始碼行號對照

| 區塊 | HTML | JS render | JS event handler |
|---|---|---|---|
| section 容器 / subnav | L134-139 | `showTab()` L284 | 三個 subtab 各自 inline onclick |
| 列表頁 bar / 表格 | L140-142 | `loadTokenGrants()` L413-420 | `#tk-reload` L421 |
| 新增表單 | L143-159 | — | `createToken()` L457-468，`$('#tkc-create').onclick` L468 |
| 詳情頁 bar | L161-162 | `loadTokenDetail()` L424-441（title/sub） | `closeTokenDetail()` L423，`renameToken()` L469-480，`$('#tkd-rename').onclick` L481 |
| 詳情頁環境權限表 | L163-164 | `loadTokenDetail()` L431-439 | `addGrant()` L448-456，`revokeGrant()` L442-447 |
| 詳情頁依勾選重發 | L165-178 | checkbox 回填 L440 | `resendKit()` L485-497，`$('#tkd-resend').onclick` L507-511，`removeAllTokens()` L498-506，`$('#tkd-delete').onclick` L512 |
| refresh 輪詢整合 | — | — | `refresh()` L832：`tab==='tokens'` 分支 |

---

**本頁互動點：14 個，grep onclick 命中 14**（HTML 靜態區段 `sed -n '134,181p'` 命中 `onclick=` 4 次：3 個 subtab + 1 個「← 返回列表」；JS 區段 `sed -n '408,513p'` 命中 `onclick=`/`.onclick =` 10 次：列表頁 3 按鈕 onclick 字串 1 行含 3 個、`#tk-reload`、環境列 2 個 onclick、`#tkc-create`、`#tkd-rename`、`#tkd-resend`、`#tkd-delete`）。9×2=18 個環境 checkbox（tkc-env + tkd-env）未計入此互動點數，因其本身無 onclick／不直接觸發 API，僅為表單狀態輸入，已在 §4 第 14 點單獨說明。
