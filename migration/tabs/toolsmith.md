> ⚠️ 行號基準：本文件引用的 **server.ts 行號是舊快照，已不可直接使用**——後續多次改動讓漂移
> 變成非均勻的 53~91 行，先前「一律 +15」的指示已作廢。要查 server.ts 現行位置請以
> `migration/00-api-inventory.md`（行號已依現行檔案重新生成）為準。
> **index.html 的行號則是準確的歷史記錄**；該檔已於 2026-09-02 經使用者核准刪除，
> 需要對照原檔時：`git show 624ae25:public/index.html`。

# Toolsmith（`#tab-toolsmith`）

顯示企劃呼叫 `aladdin_toolsmith_generate_tool` 後，aladdin-toolsmith 背景任務的即時進度。單一表格頁，每列可展開一段詳情（notes / 完整需求 / 待回答問題 / 部署關卡 / 終局結果）。無任何寫入型操作按鈕——本頁純唯讀監控。

## 1. 畫面結構

```
section#tab-toolsmith (hidden 由 showTab 控制)         (L210-213)
├── div.bar                                              (L211)
│   ├── button#ts-reload.btn "重新整理"
│   └── span.mute "資料來源：aladdin-toolsmith 的 scratch/<requestId>/conversation.json（即時現讀，非收集器）。企劃呼叫 aladdin_toolsmith_generate_tool 後，這裡會出現一筆請求，狀態隨背景處理即時更新。"
└── div.scroll                                            (L212)
    └── table
        ├── thead: requestId｜target｜發起人｜狀態｜輪次｜建立｜更新｜摘要｜log｜（空表頭，展開欄）
        └── tbody#ts-body  （見 §3）
```

每列展開後的詳情列（同一 `<tr id="ts-d-{requestId}">`，`hidden` 由展開按鈕切換）：`kv` grid，含 `notes`、`完整需求`、`待回答問題`（有值才顯示，`<ul>` 列表）、`部署關卡`（pill 群）、`終局結果`（有值才顯示）。

## 2. 資料來源

- `GET /api/toolsmith`（`loadToolsmith()` L630-651）→ `{ rows: ToolsmithRunRow[] }`
  - server 端 `listToolsmithRuns()`（`lib/toolsmith.ts` L72 起）**不落地成 SQLite / 沒有收集器**，每次請求即時 `readdirSync` scratch 目錄下每個 `requestId` 子目錄，讀 `conversation.json` 現解析——這是刻意設計（目錄數量小，直接現讀比維護一份收集器簡單，天生沒有「收集器還沒掃到」的落後問題）。
  - 每筆欄位：`requestId`、`target`（`admin`|`platform`）、`requestedBy`、`request`（完整需求文字）、`notes`、`status`（`queued`|`researching`|`needs_clarification`|`deploying`|`done`|`failed`）、`roundsCount`（澄清輪次數）、`pendingQuestions`、`createdAt`、`updatedAt`、`finalResult`（`{success,errorKind?,stage?,message,warnings?}`）、`agentLogPath`/`agentLogExists`、`deployLogPath`/`deployLogExists`、`gates`（部署關卡陣列，僅部署階段才有）。
  - **⚠️ 部署關卡（`gates`）是靠文字比對 `deploy.log` 反推的，非結構化欄位**：`parseGates()`（`lib/toolsmith.ts`）用固定關鍵字正則掃 `deploy.log` 文字，依序判斷 6 個關卡（`precondition`、`Gate A（tsc）`、`Gate B（對抗性覆核）`、`commit`、`reload`、`push`）各自 `pass`/`fail`/`pending`——這些正則字面文字直接耦合 `aladdin_mcps/aladdin-toolsmith/src/agent/deploy-pipeline.ts` 的 log 訊息，deploy-pipeline.ts 改了訊息文字要同步改這裡；重寫時若打算改用結構化 API，需注意目前沒有結構化來源可用，只能沿用文字比對或推動後端補結構化欄位。
- 呼叫時機：切到本分頁（`showTab('toolsmith')`）、5 秒輪詢（`tab==='toolsmith'` 時無條件 `loadToolsmith()`，L834，無 focus 保護）、`#ts-reload` 按鈕。**⚠️ 這就是「即時進度更新機制」：純輪詢（5 秒一次的全站 `setInterval`），沒有 WebSocket/SSE；每次輪詢都整個重打 `/api/toolsmith` 並重繪整張表**（若使用者展開了某列詳情，重繪後展開狀態會遺失，因為 `hidden` 是每次 `innerHTML` 重建時重新算的初始值 `hidden`，除非該列 id 沒變且使用者沒有互動——實際上 `toggleTsDetail` 只是切換 `hidden` 屬性，但重繪整個 `innerHTML` 會把已展開的列重置回 `hidden`，即輪詢會讓展開的詳情自動收合）。

## 3. 渲染邏輯

`#ts-body`（`loadToolsmith()` L632-650）每個請求輸出 2 個 `<tr>`（主列 + 隱藏詳情列）：

**主列**（`id="ts-r-{requestId}"`）欄位：
- `requestId`：只顯示前 8 碼（`slice(0,8)`），完整值放 `title` 屬性、等寬字體。
- `target`：原文（`admin`/`platform`），等寬字體。
- `發起人`：`requestedBy` 原文。
- `狀態`：`tsStatusPill()`（L619-625）依 `status` 對照中文標籤（`TS_STATUS_LABEL`：`queued`→"排隊中"、`researching`→"研究/寫代碼中"、`needs_clarification`→"待澄清"、`deploying`→"部署中"、`done`→"完成"、`failed`→"失敗"）與顏色：`done`→綠色 `pill ok`；`failed`→紅色 `pill bad`；`needs_clarification`→橘色 `pill warn`；其餘（`queued`/`researching`/`deploying`，仍在跑）→橘色 `pill warn`。
- `輪次`：`roundsCount`，等寬字體。
- `建立`：`fmt(createdAt)`。
- `更新`：`fmt(updatedAt)`，`title` 屬性附 `ago(updatedAt)`（相對時間）。
- `摘要`：`request` 超過 60 字截斷 + `…`，否則原文。
- `log`：兩個連結以 " · " 分隔——`agentLogExists` 為真才是可點連結（`onclick="openLog(agentLogPath)"`，文字「研究log」），否則灰字不可點；`deployLogExists` 同理（文字「部署log」）。
- 展開按鈕（`id="ts-t-{requestId}"`）：文字 `▸`（收合）/`▾`（展開）。

**詳情列**（`id="ts-d-{requestId}"`，預設 `hidden`）：
- `notes`：有值顯示原文，無值顯示 `<span class="mute">（無）</span>`。
- `完整需求`：`request` 全文，`white-space:pre-wrap` 保留換行。
- `待回答問題`：僅 `pendingQuestions` 有值才顯示整列（含表頭 `<span>待回答問題</span>`），內容為 `<ul>` 逐條列出。
- `部署關卡`：`tsGatePills()`（L626-629）——`gates` 為 `null`（部署尚未開始）→ `<span class="mute">（部署尚未開始）</span>`；否則每個 gate 一個 pill，`title` 屬性放 `label`，內容為 `{key}{符號}`（`pass`→`✓`、`fail`→`✗`、`pending`→`…`），`pass`綠色、`fail`紅色、`pending`無色。
- `終局結果`：僅 `finalResult` 有值才顯示，`success` → 綠色 `pill ok` "success"，否則紅色 `pill bad` "failed"；後接 `stage`（或 `errorKind`）與 `message`。

空資料：`<tr><td colspan="10" class="mute">無資料</td></tr>`。
排序：無自訂排序，依 API 回傳（目錄 `readdirSync`）順序，未特別依時間排序。

## 4. 互動功能（4 個）

1. **重新整理 `#ts-reload`**（L211，JS L653）：`onclick = loadToolsmith`。無 confirm。

2. **每列「研究log」連結**（`onclick="openLog(agentLogPath);return false"`，僅 `agentLogExists===true` 時可點）：切到 Logs 分頁並載入該路徑（`openLog()` L758）。`return false` 阻止 `<a>` 預設跳轉行為（連結本身 `href="#logs"`）。

3. **每列「部署log」連結**（同上，`deployLogPath`，僅 `deployLogExists===true` 時可點）。

4. **每列展開/收合按鈕 `#ts-t-{requestId}`**（`onclick="toggleTsDetail(requestId)"`，JS L652 `toggleTsDetail()`）：切換對應 `#ts-d-{requestId}` 的 `hidden`，同步切換按鈕文字 `▸`/`▾`。純前端狀態切換，不打 API；如 §2 所述，5 秒輪詢重繪整表後此狀態會被重置回收合。

## 5. 狀態與邊界

- **載入中**：無 loading 骨架。
- **空資料**：`<tr><td colspan="10" class="mute">無資料</td></tr>`。
- **部署尚未開始**（`gates===null`）：詳情列顯示「（部署尚未開始）」而非空白或錯誤。
- **log 檔不存在**：對應連結降級為灰字純文字（不可點），不是隱藏整個儲存格。
- **錯誤**：`GET /api/toolsmith` 例外由 `refresh()` 外層 `try/catch` 吞掉（console 記錄），畫面停留舊資料，無 UI 提示。
- **輪詢與展開狀態衝突**：見 §2/§4 第 4 點，展開的詳情列會在下一次 5 秒輪詢後自動收合（非 bug，是 `innerHTML` 整表重建的副作用，重寫為 React 元件時若用 key 穩定的受控展開狀態可以直接修掉這個行為差異，需與使用者確認是否要保留舊行為以求 parity）。

## 6. 原始碼行號對照

| 區塊 | HTML | JS render | JS event handler |
|---|---|---|---|
| section 容器 / bar | L210-211 | — | `#ts-reload` L653 |
| 表格 | L212 | `loadToolsmith()` L630-651，`tsStatusPill()` L619-625，`tsGatePills()` L626-629 | `toggleTsDetail()` L652，`openLog()` L758 |
| 狀態常數 | — | `TS_STATUS_LABEL` L618 | — |
| server 端資料來源 | — | `lib/toolsmith.ts` `listToolsmithRuns()` L72 起、`parseGates()`/`GATE_DEFS` | `server.ts` `GET /api/toolsmith` |
| refresh 輪詢整合 | — | — | `refresh()` L834：`tab==='toolsmith'` 分支（無 focus 保護，見 §2） |

---

**本頁互動點：4 個，grep onclick 命中 4**（HTML 靜態區段 `sed -n '210,213p'` 命中 `onclick=` 0 次；JS 區段 `sed -n '617,653p'` 命中 `onclick=`/`.onclick =` 4 次：「研究log」連結、「部署log」連結、展開按鈕、`#ts-reload` 賦值）。
