> ⚠️ 行號基準：本文件引用的 **server.ts 行號是舊快照，已不可直接使用**——後續多次改動讓漂移
> 變成非均勻的 53~91 行，先前「一律 +15」的指示已作廢。要查 server.ts 現行位置請以
> `migration/00-api-inventory.md`（行號已依現行檔案重新生成）為準。
> **index.html 的行號則是準確的歷史記錄**；該檔已於 2026-09-02 經使用者核准刪除，
> 需要對照原檔時：`git show 624ae25:public/index.html`。

# Pipelines（`#tab-pipelines`）

背景 pipeline（bug `/create-mr` 與需求單 demand）的執行列表 + 單次執行詳情頁（含階段檢核表、Agent 流程表、逐 agent 完整對話檢視器）。是全站互動最深的一頁：三層畫面（列表 → run 詳情 → agent 對話），列表頁本身還疊了「排隊中」「遠端 worker」兩種非 DB 來源的虛擬列。

## 1. 畫面結構

```
section#tab-pipelines (hidden 由 showTab 控制)        (L183-208)
├── div.bar                                            (L184)
│   ├── button#pl-reload.btn "重新整理"
│   ├── button#pl-outcome-toggle.btn onclick=toggleOutcomeCol() "隱藏結果欄"（文字會切換為「顯示結果欄」）
│   └── span.mute "資料來源：telegram-dispatcher/logs 逐票 log 檔名 + ps 行程表。需求單（demand）的進度在共用的 demand-pipeline.log，逐票 stdout 為空是正常的。"
├── div#pl-list                                         (L185-187，列表視圖，預設顯示)
│   └── div.scroll > table
│       ├── thead: 票號｜Worker｜發起人｜開始｜結束｜耗時｜tokens in / out｜結果(class=col-outcome)｜log｜（空表頭，操作欄）
│       └── tbody#pl-body  （三段拼接：排隊列 + 遠端列 + 本機歷史列，見 §3）
└── div#pl-detail[hidden]                                (L188-207，run 詳情視圖)
    ├── div.bar                                          (L189)
    │   ├── button.btn onclick=closeRun() "← 返回列表"
    │   ├── span#pd-title  （"票號（kind）"）
    │   └── span#pd-sub.mute （開始→結束 · 耗時 · running/outcome）
    ├── div.stack                                        (L190-199)
    │   ├── div.card#pd-stages-card[hidden]               (L191-196，⚠️ 階段檢核表，見 §3/§4)
    │   │   ├── h3 "Pipeline 階段檢核表"
    │   │   ├── table: 階段｜狀態｜開始｜結束｜耗時，tbody#pd-stages
    │   │   ├── div#pd-stages-note.mute[hidden]           （run 執行中的補充說明，見 §5）
    │   │   └── div.mute（固定說明文字，見下方「固定文案」）
    │   ├── div.card "Agent 流程（依開始時間）"           (L197)
    │   │   ├── table: #｜stage｜開始｜耗時｜model｜turns｜tools｜in (fresh/cache)｜out｜狀態，tbody#pd-agents
    │   │   └── div#pd-total.mute
    │   └── div.card "進度 log"                           (L198)
    │       └── div.scroll#pd-progress
    └── div.card#pd-conv-card[hidden]                     (L200-206，點某個 agent 列後才出現，對話檢視器)
        ├── h3#pd-conv-title
        ├── div.bar#pd-conv-meta  （一串 pill：時間區間/model/turns/tool calls/token/cwd/error）
        ├── details "Prompt（輸入給 agent 的完整提示）" > pre.log#pd-prompt
        ├── div#pd-turns  （逐輪對話，見 §3）
        └── div#pd-result  （最終產出/錯誤，見 §3）
```

**固定文案**（`#pd-stages-card` 內固定說明，L195）：「單一 claude -p session 內部各階段用 Task 呼叫子 agent，非獨立 process，拿不到每階段各自的 token 用量——input/output token 只有整次執行的合計，見下方「Agent 流程」表。開始/結束時間根據 Debug 產物檔案存在與 mtime 推算，「開始」= 前一個已完成階段的結束時間，非精確量測。」

## 2. 資料來源

### 列表頁
- `GET /api/pipelines`（`loadPipelines()` L602-614）→ `{ rows, queued, remote }`
  - `rows`：`pipeline_runs` 表最近 300 筆（DESC by started_at），附加解析出的 `agents`（彙總後刪除，只留 `agent_count`/`total_input`/`total_output`）、`running`（依 stdout 路徑 or ticket 對照 ps 行程表判斷）、`assignee`（`triggered_by` sidecar）、`retryable`（`isBugOutcomeRetryable(outcome)` 且非 running 且 kind=bug）。
  - `queued`：還沒 spawn、沒有 DB 紀錄的排隊單（讀 `logs/pipeline-queue.*.json` 佇列快照）。
  - `remote`：派到遠端 worker、本機沒有 `pipeline_runs` 紀錄的執行中單（讀 `dispatch-registry`）。
- 呼叫時機：切到本分頁（`showTab('pipelines')`）、5 秒輪詢（`tab==='pipelines'` 時若 `curRunKey` 有值改呼叫 `loadRunDetail()`，否則 `loadPipelines()`，L833）、`#pl-reload` 按鈕、`取消`/`重試`操作後（`refresh(true)`）、`closeRun()`。

### Run 詳情頁
- `GET /api/pipelines/run?key=<key>`（`loadRunDetail()` L549-571）→ `{ run, progress, stages }`
  - `run`：該 key 的 `pipeline_runs` 列 + 同票所有歷史執行的 `agents[]`（`attachAgentRuns`）+ `running`。
  - `progress`：僅 demand pipeline 有值，抓 `demand-pipeline.log` 中該 run 時間區間內、`ticket` 相符的行。
  - `stages`：僅 bug pipeline 有值（`computeBugStages()`，⚠️ 見 §3「階段檢核表」與 §4）。
- 呼叫時機：`openRun(key)` 首次開啟、5 秒輪詢（`curRunKey` 有值時）、`closeRun()` 之前不會再打（回列表改打 `/api/pipelines`）。

### Agent 對話檢視器
- `GET /api/agent-trace?path=<path>`（`openAgent(path)` L579-599）→ `{ meta, summary, prompt, turns, result, rawStdout?, error? }`
  - 每次點擊表格列都重新呼叫（不快取），**不隨 5 秒輪詢自動更新**（`refresh()` 的 pipelines 分支只重打 `loadRunDetail`/`loadPipelines`，不會重打 `openAgent`；若使用者停在對話檢視器上，5 秒後 `#pd-agents` 表格內容可能被重繪但已開啟的對話框內容不會自動跟著更新，除非重新點擊該列）。

### 取消 / 重試
- `POST /api/pipelines/cancel` body `{kind, ticket}`
- `POST /api/pipelines/retry` body `{ticket}`（僅 bug/`FAQ-*`）

## 3. 渲染邏輯

### 列表頁 `#pl-body`（`loadPipelines()` L608-613）
三段字串拼接，依序：
1. **排隊列**（`queuedRows`，L608）：票號｜"本機"（固定文字，佇列一定在本機）｜發起人｜排入佇列時間（`fmt`）｜"-"｜已等待（`dur(enqueuedAt,null)`）｜其餘欄位空白。
2. **遠端列**（`remoteRows`，L612）：票號｜Worker 名稱（有 `r.worker` 時是連到 Workers 分頁的連結 `<a onclick="openWorkerTicket(worker,ticket)">`，否則顯示"(交涉中)"）｜發起人（`triggeredBy?.name`）｜派工時間｜"-"｜已耗時（`dur(dispatchedAt,null)`）｜log 欄顯示 mute 文字"在 worker 本機"｜其餘空白。
3. **本機歷史列**（`d.rows.map(...)`，L613）：
   - 票號：連結 `<a onclick="openRun(r.key)">`，點擊進 run 詳情。
   - Worker：固定"本機"。
   - 發起人：`r.assignee`。
   - 開始/結束：`fmt()`。
   - 耗時：`dur(started_at, finished_at)`。
   - tokens in/out：`r.agent_count` 有值才顯示 `fmtTok(total_input) + ' / ' + fmtTok(total_output)`（`fmtTok`：≥1e6 顯示 `xM`、≥1e3 顯示 `xk`，否則原數字）。
   - 結果（`col-outcome`，可被「隱藏結果欄」toggle 隱藏）：`outcome==='cancelled'` → `<span class="pill warn">cancelled</span>`；有 outcome → `resPill(outcome==='success'?'success':outcome.split(' ')[0])`（`resPill`：`success`/`recovered` 綠色 `pill ok`，其餘紅色 `pill bad`，空值灰色 `pill`）；無 outcome → 空白。
   - log：`kind==='demand'` → 固定連到共用 `demand-pipeline.log` 的「進度 log」連結（title 提示逐票 stdout 固定是空的）；否則「stdout」連結 + " · " + "stderr" 連結，皆 `onclick="openLog(path);跳到 logs 分頁"`。
   - 操作欄：`r.running` → 取消按鈕；否則 `r.retryable` → 重試按鈕；否則空白。
   - 全空（無 queued/remote/rows）→ `<tr><td colspan="10" class="mute">無資料</td></tr>`。

### Run 詳情頁

**`#pd-agents`**（L556-562）：每 agent 一列，`class="agent-row ${a.path===curAgentPath?'on':''}"`、整列 `onclick="openAgent(a.path)"`（點列即開對話，非按鈕）。欄位：#（序號）｜stage（粗體）｜開始（`fmt().slice(-8)` 只取時分秒）｜耗時（`ended_at` 有值 `dur()`，否則 `<span class="warn">進行中</span>`）｜model（小字）｜turns｜tool 呼叫數｜in（fresh/cache，`fmtTok(input)+' / '+fmtTok(cache_read+cache_create)`）｜out｜狀態（`is_error`→`pill bad error`；`ended_at`→`pill ok ok`；否則`pill warn running`）。
無 agent 時：demand → "尚無 agent trace（只有 2026-08-21 12:30 之後觸發的需求單才有；更早的執行 dispatcher 沒有保存 agent 輸出）"；bug → "Bug pipeline 結束後才會解析 stdout 的用量"。
`#pd-total`：有 agent 才顯示 `合計 N 個 agent · input xM（含 cache）· output xM`。

**`#pd-progress`**（L563）：demand 有進度行 → 表格（時分秒 + 訊息）；demand 無資料 → "此區間 demand-pipeline.log 沒有紀錄"；bug（一律無 progress）→ "（Bug pipeline 的進度請看 stdout log）"。

**`#pd-stages`（⚠️ 階段檢核表，重寫時的重點區塊，L564-570）**：
- `#pd-stages-card` 只在 `stages.length>0` 才顯示（即只有 bug pipeline 有）。
- 每列：`class="stage-running"`（若 `status==='running'`，CSS 讓整列變警示色）；標籤欄 = `label` + （有 `detail` 才附加 `<span class="mute">(${detail})</span>`，⚠️ **這就是「第 N 輪」文字出現的位置**，見下方「審查輪次顯示」）；狀態欄：`done`→`pill ok done`，`running`→`pill warn running`，`reused`→`pill` 帶 title「產物檔存在但非本輪產出：resume 續跑沿用上一輪，或全跑尚未重做到這步」文字「沿用上輪」，其餘→`pill pending`；開始/結束/耗時欄同 `fmt`/`dur` 規則。
- 固定 9 個階段定義（`lib/ingest.ts computeBugStages()`，L612-673），依序：`Step 0.1 認領工單`、`Step 1 Bug 分析`、`Step 1 企劃規格比對`、`Step 2a CQA 實證 Grounding`、`Step 2b 根因分析（Tracer）`、`Step 4 隔離環境（worktree + bootstrap）`、`Step 6 三重平行審查`、`Solution 彙整`、`Step 7/8 開 MR + Notion 回寫 + tracker 終態`。Step 5（fixer TDD 修復）**故意不列**，因它不產出獨立文件、沒有安全的完成判定訊號，只在「執行中」時動態插入一列（見下方）。
- 各階段 `finished_at` 依對應 Debug 產物檔 mtime 判定（例如 `analytics.md`、`spec.md`、`grounding.md`、`analysis-notes.md`、`solution.md`；`review` 階段要三份報告 `reviewer-report.md`/`adversarial-review.md`/`tdd-fidelity-review.md` 都存在才算 done，取最晚 mtime）；`worktree` 階段讀 worktree 目錄下的 `bootstrap.log` mtime；`exit` 階段讀 tracker 狀態（非 pending/rerun/in_progress 才算完成）。
- `started_at` 沿用「上一個已完成階段的 finished_at」；若某階段完成時間早於前一階段（重做迴圈導致順序錯亂），該列 `started_at` 顯示 `-`（避免出現負耗時）。

**⚠️ 審查輪次顯示「第 N 輪」（2026-09-01 新增，資料流向）**：
1. `computeBugStages()` 若 `running===true`，會呼叫 `inferCurrentBugStage(ticket, runStartedAt)`（`lib/ingest.ts` L588-598）掃描該次執行的 session transcript（現讀 `.jsonl`，非收集器快取），找「還沒收到 tool_result 的最深一個 Agent/Task 派工」當作目前正在跑的 stage；同時累計每個 review 系 subagent（`solution-reviewer`/`adversarial-solution-reviewer`/`tdd-fidelity-reviewer`，`REVIEW_AGENTS` 集合）被 Task 派工的次數到 `state.reviewCounts`。
2. 若判定目前在跑的 stage 是 `review`，取「目前正在跑的這位 reviewer 被派工的次數」當作 `reviewRound`；若拿不到該 agent 自己的計數，退而取三者計數的最大值（`Math.max(0, ...state.reviewCounts.values())`）——這是因為三位 reviewer 理應同一輪一起被重新派工，計數會同步前進。
3. 回到 `computeBugStages()`：若目前在跑的 stage 是 `fixer`，動態插入一列「Step 5 TDD 修復（Fixer）」（`status:'running'`，`detail:cur.agent`，插在 `review` 列之前）；否則找到對應的 `stages` 列，把 `status` 覆蓋成 `running`（蓋掉原本可能是 `done`/`reused` 的狀態——例如審查被否決後重跑 review，舊報告仍在但這輪正在重跑），並設 `s.detail = cur.reviewRound ? \`${cur.agent}・第 ${cur.reviewRound} 輪\` : cur.agent`。
4. 前端只是原樣把 `s.detail` 塞進 `<span class="mute">(${esc(s.detail)})</span>`（`index.html` L569）——**「第 N 輪」字樣只在「run 執行中」且「目前正在跑三重審查（Step 6）」時出現在「Step 6 三重平行審查」那一列的標籤欄括號裡**，格式為 `{agent 名稱}・第 {N} 輪`（例如 `solution-reviewer・第 2 輪`）；不在跑 review 時（pending/done/reused）不顯示輪次，也沒有獨立欄位，只附著在 `detail` 字串裡。
5. 重寫時務必保留「只在 running && 目前 stage 是 review 時才算 reviewRound，非 running 時完全沒有輪次資訊」這個條件——歷史（已結束）的 run 無法回溯知道當時是第幾輪重審。

**`#pd-stages-note`**（L567，僅在 `stages.length>0 && d.run.running` 時顯示）：「run 執行中：本表只反映各階段產物「檔案落地」的狀態，標不出此刻正在跑哪一步——Step 5（fixer TDD 修復）不產出獨立文件所以沒有列；審查被否決後重做時，Step 6 在新報告落地前仍顯示「沿用上輪」；Step 2b 的 done 也可能是 fixer 往 analysis-notes 追加 TDD 紀錄（同一份文件）。」

### Agent 對話檢視器（`openAgent()` L579-599）
- `#pd-conv-title`：`${stage}${ticket?' · '+ticket:''}`。
- `#pd-conv-meta`：多個 `<span class="pill">`：時間區間（`fmt(startedAt) → fmt(endedAt).slice(-8)（dur）`）、model、`turns N`、`tool calls N`、`in xM + cache xM`、`out xM`、cwd（title 屬性）、`error`（紅色 pill，若有）。
- `#pd-prompt`：`d.prompt`，無值時顯示 `（bug pipeline：prompt 為 /create-mr 指令，未另存）`。
- `#pd-turns`（`blockHtml()` L572-578）：每輪一個 `.turn.{role}` 區塊（`assistant` 藍色左框 + "🤖 assistant"、其餘灰色左框 + "👤 tool results"），內含依序渲染的 block：
  - `text` → `<pre>`
  - `thinking` → `<details><summary>thinking</summary><pre class="thinking">`（灰斜體）
  - `tool_use` → `<details><summary>🔧 {name}</summary><pre>{JSON.stringify(input,null,2)}</pre></details>`
  - `tool_result` → `<details class="result {err?'err':''}"><summary>{❌或↩} tool_result{（錯誤）} · {字數} 字</summary><pre>{content}</pre></details>`
  - 其他 type → `<div class="mute">[{type}]</div>`
  - 無 turns 且有 `rawStdout` → 退回顯示原始 stdout；都沒有 → "沒有對話事件"。
- `#pd-result`：有 `d.result` 才顯示，`.final` 綠框卡片：`is_error` → "❌ 最終結果（錯誤）"，否則 "✅ 最終產出"，附 `subtype` 與耗時秒數，內文 `pre` 顯示 `result.text`（無文字時顯示"（無文字）"）。
- 渲染完會 `scrollIntoView({behavior:'smooth',block:'start'})` 捲到對話卡片。

## 4. 互動功能（⚠️ 本頁重點：11 個互動點，含 retry/cancel 的完整行為）

1. **重新整理 `#pl-reload`**（L184，JS L615）：`onclick = loadPipelines`。無 confirm。

2. **隱藏結果欄 `#pl-outcome-toggle`**（L184 `onclick="toggleOutcomeCol()"`，JS L537-542）：純前端 class toggle，不打 API。`$('#pl-list').classList.toggle('hide-outcome')`（CSS `#pl-list.hide-outcome .col-outcome{display:none}` 隱藏「結果」欄），按鈕文字在「隱藏結果欄」/「顯示結果欄」間切換。狀態存在模組級變數 `hideOutcomeCol`，重新整理頁面會重置。

3. **票號連結（進入 run 詳情）**（`onclick="openRun(r.key)"`，JS L547）：`curRunKey=key`，`curAgentPath=null`（清掉上次選的 agent），切到 `#pl-detail`，`$('#pd-conv-card').hidden=true`（關掉可能殘留的對話卡片），呼叫 `loadRunDetail()`。無 confirm。

4. **「← 返回列表」**（L189 `onclick="closeRun()"`，JS L548）：`curRunKey=null; curAgentPath=null`，切回 `#pl-list`，`loadPipelines()`。

5. **stdout / stderr / 進度 log 連結**（`onclick="openLog(path)"`）：切到 Logs 分頁並把該路徑設為當前查看的 log 檔（`openLog()` L758：`loadLogList()` → `$('#lg-file').value=p` → `showTab('logs')`）。

6. **⚠️ 取消按鈕「取消」**（`cancelBtn()` L515，`onclick="cancelPipeline(kind,ticket)"`，JS L516-521）：
   - 只在 `r.running===true` 的列（本機歷史列）出現，`kind` 為 `bug` 或 `demand`。
   - `confirm("確定要取消 ${kind} pipeline ${ticket}？\n\n會送 SIGTERM 給整棵行程樹；wrapper 的收尾會照常執行（釋放 bug-lock、發 TG「異常終止」通知給認領人、釋放併發名額）。")`
   - `POST /api/pipelines/cancel` body `{kind,ticket}`。
   - 成功：`alert("已送出取消：對 ${killed.length} 個子行程送出 SIGTERM（${killed.join(', ')}），wrapper ${wrapperPid} 會自行收尾。幾秒後列表會更新。")`。
   - 失敗：`alert("取消失敗：${reason||'unknown'}")`。
   - 之後**一律** `refresh(true)`（不論成功失敗都強制重新整理）。

7. **⚠️ 重試按鈕「重試」**（`retryBtn()` L528，`onclick="retryPipeline(ticket)"`，JS L529-534）：
   - 只在 `r.retryable===true` 的列出現（`kind==='bug'` 且非 running 且 `isBugOutcomeRetryable(outcome)`；⚠️ 前端顯示條件只是粗略提示，真正權限判斷在後端 `/api/pipelines/retry` 即時查 tracker 狀態）。
   - `confirm("確定要重試 ${ticket}？\n\n會從上一輪最後完成的階段接續（沿用既有分析產物與 mr/ 分支的 commit；審查有 FAILED 時從 fixer 重做、三審皆過時直接 Solution 彙整起）。盤點失敗會自動退回整張全跑。")`
   - `POST /api/pipelines/retry` body `{ticket}`（僅支援 `FAQ-*`，demand 不提供此按鈕）。
   - 後端即時檢查（送出當下才判斷，不信任前端 `retryable`）：這張票是否已在跑（409）、併發是否達上限（429，上限即 `PIPELINE_LIMITS.bug`）、tracker 狀態是否為 `failed`/`in_progress`/`rerun` 三者之一（否則 409，訊息含目前實際狀態）。通過後 `tracker.sh set <ticket> rerun`，再以 `bun spawn-create-mr.ts <ticket> --resume [--triggered-by-email <上次發起人>]` 重新 spawn（**帶 `--resume`，是續跑語意，不是整張重跑**——沿用既有 Debug 產物、review 結論與 mr/ 分支 commit，盤點失敗才自動退回全跑）。
   - 成功：`alert("已觸發續跑（pid ${pid}），列表會在下個 tick 顯示新的一次執行。")`。
   - 失敗：`alert("重試失敗：${reason||'unknown'}")`。
   - 之後**一律** `refresh(true)`。

8. **遠端列 Worker 名稱連結**（`onclick="openWorkerTicket(worker,ticket)"`，JS L729，定義於 Workers 區塊但由本頁呼叫）：跳到 Workers 分頁、開啟該 worker 詳情、自動代填並查詢該票號（見 workers.md §4）。

9. **Agent 流程表每列（點列開對話）**（`onclick="openAgent(a.path)"`）：見 §3。無 confirm，每次點擊都重打 API（不快取）。

10. **對話卡片 `<details>` 折疊區塊**（thinking / tool_use / tool_result / Prompt）：純瀏覽器原生 `<details>/<summary>` 展開收合，無 JS handler、不打 API。

11. **`toggleOutcomeCol` 之外的取消/重試共用按鈕生成函式** `cancelBtn`/`retryBtn`（L515/528）本身不是獨立互動點，已併入第 6/7 點，此處不重複計數。

## 5. 狀態與邊界

- **載入中**：無 loading 骨架，`await` 期間畫面維持上次內容不變。
- **空資料（列表頁）**：queued/remote/rows 全空 → `<tr><td colspan="10" class="mute">無資料</td></tr>`。
- **空資料（詳情頁 agents）**：見 §3「無 agent 時」的 demand/bug 兩種文案。
- **空資料（詳情頁 progress）**：見 §3「進度 log」的三種文案（demand 有資料 / demand 無資料 / bug）。
- **run 找不到**（`GET /api/pipelines/run` 404）：`d.error` 有值時 `$('#pd-title').textContent='找不到紀錄'`，其餘欄位不再繼續渲染（`return` 提前結束，`#pd-sub`、`#pd-agents` 等維持上次或空白內容）。
- **agent-trace 找不到**（`GET /api/agent-trace` 錯誤）：`$('#pd-conv-title').textContent = d.error`，其餘欄位不繼續渲染。
- **審查輪次資訊缺失**：非 running 的歷史 run 一律沒有 `detail`/`reviewRound`，`#pd-stages` 該列標籤欄不附加括號說明（見 §3 第 5 點）。
- **重做迴圈導致負耗時的防呆**：見 §3「`started_at` 沿用...」段，`outOfOrder` 時開始時間顯示 `-`。
- **取消/重試操作的錯誤呈現**：一律 `alert()`，無 inline 錯誤區塊；`fetch` 例外走 `.catch(e=>({ok:false, reason/reason... :String(e)}))` 統一格式。

## 6. 原始碼行號對照

| 區塊 | HTML | JS render | JS event handler |
|---|---|---|---|
| section 容器 / bar | L183-184 | — | `#pl-reload` L615，`toggleOutcomeCol()` L538-542 |
| 列表 table | L185-187 | `loadPipelines()` L602-614 | `openRun()` L547，`cancelPipeline()` L516-521，`retryPipeline()` L529-534，`openLog()` L758，`openWorkerTicket()` L729 |
| 詳情頁 bar | L188-189 | `loadRunDetail()` L554-555（title/sub） | `closeRun()` L548 |
| 階段檢核表 `pd-stages` | L191-196 | `loadRunDetail()` L564-570 | — |
| 審查輪次「第 N 輪」邏輯 | — | `computeBugStages()` + `inferCurrentBugStage()`（`lib/ingest.ts` L588-673） | — |
| Agent 流程表 `pd-agents` | L197 | `loadRunDetail()` L556-562 | `openAgent()` L579-599（行 onclick） |
| 進度 log `pd-progress` | L198 | `loadRunDetail()` L563 | — |
| 對話檢視器 `pd-conv-card` | L200-206 | `openAgent()` L579-599，`blockHtml()` L572-578 | — |
| refresh 輪詢整合 | — | — | `refresh()` L833：`tab==='pipelines'` 分支 |

---

**本頁互動點：11 個，grep onclick 命中 11**（HTML 靜態區段 `sed -n '183,208p'` 命中 `onclick=` 2 次：`#pl-outcome-toggle`、`closeRun()`；JS 區段 `sed -n '514,615p'` 命中 `onclick=`/`.onclick =` 9 次：`cancelBtn` 模板、`retryBtn` 模板、`pd-agents` 列 `openAgent`、遠端列 `openWorkerTicket`、本機列裡 `openRun` + 2 個 `openLog`（demand 分支/stdout 分支互斥但原始碼各存在 1 次）+ 1 個 `openLog`（stderr，恆存在）、`#pl-reload` 賦值）。
