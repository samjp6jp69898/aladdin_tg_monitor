# Pipelines 分頁 parity 對照表

實作檔案：
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/PipelinesPage.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/pipelines/PipelinesListView.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/pipelines/PipelineDetailView.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/pipelines/AgentConversationCard.tsx`
- `/Users/user/aladdin/tg-monitor/frontend/src/pages/pipelines/types.ts`

規格依據：`/Users/user/aladdin/tg-monitor/migration/tabs/pipelines.md`（下稱「規格」）、
`/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md`（下稱「契約」）。

---

## 1. 互動功能對照（規格 §4，共 11 項）

| 規格項次 | 內容 | 實作位置 |
|---|---|---|
| §4.1 `#pl-reload` 重新整理 | `onclick=loadPipelines`，無 confirm | `PipelinesListView.tsx:233`（`<Button onClick={() => resource.reload()}>`） |
| §4.2 `#pl-outcome-toggle` 隱藏結果欄 | 純前端 class toggle，不打 API；按鈕文字「隱藏結果欄」/「顯示結果欄」切換；狀態存模組級變數，重整頁面會重置 | `PipelinesListView.tsx:16`（`useState(false)`，component 卸載/頁面重整即重置，等同舊版模組變數行為）、`234-238`（按鈕與文字切換）、`256`（`wrapperClassName={hideOutcomeCol?'hide-outcome':undefined}` 傳給 `DataTable`，對應舊版 `#pl-list.hide-outcome`） |
| §4.3 票號連結進 run 詳情 | `curRunKey=key`、`curAgentPath=null`、切到 `#pl-detail`、關掉殘留對話卡片、`loadRunDetail()`，無 confirm | `PipelinesListView.tsx:66-77`（`navigate(pipelinesPath(r.key))`，改網址 query）；`PipelineDetailView.tsx:18-30`（`PipelineDetailView` 由 `PipelinesPage.tsx:22` 以 `key={key}` mount，key 變動時整個子樹重新 mount，`agentPath` state 自然歸零，等同 `curAgentPath=null` + 關掉對話卡片；`useResource` mount 即自動 `loadRunDetail()`） |
| §4.4 「← 返回列表」 | `curRunKey=null;curAgentPath=null`，切回 `#pl-list`，`loadPipelines()` | `PipelineDetailView.tsx:50,160`（`navigate(pipelinesPath())` 回列表，`PipelineDetailView` 卸載使 `agentPath` 消失；`PipelinesPage.tsx` 切回 mount `PipelinesListPage`，`useResource` 重新訂閱等同重新 `loadPipelines()`） |
| §4.5 stdout / stderr / 進度 log 連結 | `openLog(path)`：切到 Logs 分頁並把該路徑設為當前查看的 log 檔 | `PipelinesListView.tsx:176-201`（`navigate(logsPath(path))`，對應契約 §6.2 `logsPath()`） |
| §4.6 ⚠️ 取消按鈕「取消」 | 只在本機歷史列且 `running===true` 出現；confirm 文案原文；`POST /api/pipelines/cancel` body `{kind,ticket}`；成功/失敗 alert 文案原文（讀 `killed`/`wrapperPid`）；之後一律 `refresh(true)` | 按鈕渲染：`PipelinesListView.tsx:210-215`（`r.running` 才顯示，`<Button variant="danger">`）。行為：`PipelinesListView.tsx:29-41`（`handleCancel`，confirm 文案逐字照抄；`useAction.run()` 呼叫 `postPipelineCancel(kind,ticket)`——`postResult` 語意，業務失敗也回傳 body 不拋例外；成功分支從 `result.raw`（`CancelPipelineResponse`）取 `killed.length`/`killed.join(', ')`/`wrapperPid` 組訊息，因為 `useAction` 的 `message` 欄位在成功時是空字串（後端成功回應沒有 `result`/`reason` 欄位）；失敗分支用 `raw.reason`；`await resource.reload()` 對應「一律 refresh(true)」） |
| §4.7 ⚠️ 重試按鈕「重試」 | 只在本機歷史列且 `retryable===true` 出現；confirm 文案原文（**續跑語意，非整張重跑**，依契約 §9-2 以 spec/confirm 文案為準）；`POST /api/pipelines/retry` body `{ticket}`；成功/失敗 alert 文案原文；之後一律 `refresh(true)` | 按鈕渲染：`PipelinesListView.tsx:217-222`（`r.retryable` 才顯示，`<Button variant="warn">`）。行為：`PipelinesListView.tsx:44-56`（`handleRetry`，confirm 文案逐字照抄「從上一輪最後完成的階段接續」，未採用 index.html 過時的程式碼註解「整張從 Step 1 重跑」；成功分支讀 `raw.pid`；失敗分支讀 `raw.reason`；`await resource.reload()`） |
| §4.8 遠端列 Worker 名稱連結 | `openWorkerTicket(worker,ticket)`：跳到 Workers 分頁、開該 worker 詳情、代填並查詢票號 | `PipelinesListView.tsx:88-102`（`navigate(workersPath(r.worker, r.ticket))`，對應契約 §6.2 `workersPath(name,ticket)`——目標頁 `WorkersPage` 需自行用 `useSearchParams` 讀 `name`/`ticket` 完成代填查詢，屬 Workers 分頁職責，不在本頁範圍） |
| §4.9 Agent 流程表每列（點列開對話） | `onclick="openAgent(a.path)"`；無 confirm；每次點擊都重打 API（不快取） | `PipelineDetailView.tsx:196-209`（`DataTable onRowClick={a => handleOpenAgent(a.path)}`）、`32-40`（`handleOpenAgent`：path 不同則 `setAgentPath` 觸發 `useResource` 因 params 變動自動重新訂閱抓取；**path 相同時額外呼叫 `agentTrace.reload()` 強制重打**，因為 `useResource` 只在 params 變動時才重新訂閱，若不這樣處理，連續點同一列不會重打 API，會偏離「不快取」規格） |
| §4.10 對話卡片 `<details>` 折疊區塊 | thinking / tool_use / tool_result / Prompt，純瀏覽器原生 `<details>/<summary>`，無 JS handler、不打 API | `AgentConversationCard.tsx:67-73`（Prompt）、`118-146`（thinking / tool_use / tool_result，皆為原生 `<details>`，無 onClick handler） |
| §4.11 `cancelBtn`/`retryBtn` 生成函式 | 規格明文「非獨立互動點，已併入第 6/7 點，不重複計數」 | 對應本表 §4.6/§4.7 的按鈕渲染部分（`PipelinesListView.tsx:210-224`），不另計 |

---

## 2. 渲染欄位對照表

### 2.1 列表頁 `#pl-body`（規格 §3「列表頁」，`PipelinesListView.tsx`）

| 欄位 | 排隊列（queued） | 遠端列（remote） | 本機歷史列（history） |
|---|---|---|---|
| 票號 | `q.ticket`（純文字）— `columns[0]:79` | `r.ticket`（純文字）— `columns[0]:79` | `<a>{r.ticket}</a>` 連 `openRun` — `columns[0]:66-77` |
| Worker | 固定「本機」— `columns[1]:87` | 有 `r.worker` 則連結 Workers，否則「(交涉中)」— `columns[1]:88-103` | 固定「本機」— `columns[1]:104` |
| 發起人 | `q.triggeredBy` — `columns[2]:111` | `r.triggeredBy?.name` — `columns[2]:112` | `r.assignee` — `columns[2]:113` |
| 開始 | `fmt(q.enqueuedAt)`，title「排入佇列時間」— `columns[3]:120,122` | `fmt(r.dispatchedAt)` — `columns[3]:123` | `fmt(r.started_at)` — `columns[3]:124` |
| 結束 | `-` — `columns[4]:131` | `-` — `columns[4]:131` | `fmt(r.finished_at)` — `columns[4]:131` |
| 耗時 | `dur(enqueuedAt,null)`，title「已等待」— `columns[5]:137,139` | `dur(dispatchedAt,null)` — `columns[5]:140` | `dur(started_at,finished_at)` — `columns[5]:141` |
| tokens in/out | 空 | 空 | `r.agent_count` 有值才顯示 `fmtTok(total_input)+' / '+fmtTok(total_output)` — `columns[6]:148-152` |
| 結果（`col-outcome`） | 空 | 空 | `cancelled`→`<Badge variant="warn">`；有 outcome→`<ResultBadge>`；否則空 — `columns[7]:159-165` |
| log | 空 | `在 worker 本機`（mute）— `columns[8]:170,173` | demand→「進度 log」固定連結；否則 stdout · stderr 兩連結 — `columns[8]:180-201` |
| 操作 | 空 | 空 | `running`→取消；`retryable`→重試；否則空 — `columns[9]:207-225` |

### 2.2 Run 詳情頁

#### 頂部 bar（規格 §3「Run 詳情頁」，`PipelineDetailView.tsx:156-167`）
| 欄位 | 規格 | 實作位置 |
|---|---|---|
| `#pd-title` | `${ticket}（${kind}）` | `:161` |
| `#pd-sub` | `${fmt(started)} → ${finished?fmt(finished):'進行中'} · ${dur} · ${running?'running':(outcome||'')}` | `:162-166` |

#### `#pd-stages` 階段檢核表（規格 §3「⚠️ 階段檢核表」，`:170-194`）
| 欄位 | 規格 | 實作位置 |
|---|---|---|
| 卡片顯示條件 | `stages.length>0` | `:170` |
| 標籤欄 | `label` + 有 `detail` 才附加 `<span class="mute">(${detail})</span>` | `:66-76`（`stageColumns[0]`） |
| 狀態欄 | `done`→`pill ok done`；`running`→`pill warn running`；`reused`→帶 title 的「沿用上輪」；其餘→`pill pending` | `:81-91` |
| 開始/結束/耗時 | 依 `fmt`/`dur` 規則，`outOfOrder` 時開始顯示 `-` | `:94-114`（`started_at` 沿用「上一階段 finished_at」與亂序防呆完全由後端 `computeBugStages()` 算好，前端只依 `status`/`started_at`/`finished_at` 原樣渲染，不重算） |
| row class | `status==='running'` → `stage-running` | `:176` |
| `#pd-stages-note` | 僅 `stages.length>0 && run.running` 顯示，固定文案 | `:179-186` |
| 固定說明文字（token 用量/開始時間推算） | 卡片內固定顯示 | `:187-192` |

#### `#pd-agents` Agent 流程表（規格 §3，`:196-216`）
| 欄位 | 規格 | 實作位置 |
|---|---|---|
| # | 序號 | `agentColumns[0]:118` |
| stage | 粗體 | `agentColumns[1]:119` |
| 開始 | `fmt().slice(-8)` | `agentColumns[2]:120`（用 `lib/format.ts` 的 `hms()`，就是同一個 slice(-8) 實作） |
| 耗時 | 有 `ended_at`→`dur()`；否則 `<span class="warn">進行中</span>` | `agentColumns[3]:121-126` |
| model | 小字（14px） | `agentColumns[4]:127-132` |
| turns/tools | 原樣 | `agentColumns[5-6]:133-134` |
| in (fresh/cache) | `fmtTok(input)+' / '+fmtTok(cache_read+cache_create)` | `agentColumns[7]:135-140` |
| out | `fmtTok(output)` | `agentColumns[8]:141` |
| 狀態 | `is_error`→bad；`ended_at`→ok；否則 warn running | `agentColumns[9]:142-153` |
| row class / click | `agent-row ${on?'on':''}`，整列可點 | `:201-202` |
| 空狀態 | demand/bug 兩種文案 | `:203-207` |
| `#pd-total` | `合計 N 個 agent · input xM（含 cache）· output xM`，無 agent 則不顯示 | `:210-215` |

#### `#pd-progress` 進度 log（規格 §3，`:218-237`）
| 情況 | 規格 | 實作位置 |
|---|---|---|
| demand 有資料 | 表格：`fmt(ts).slice(-8)` + 訊息 | `:220-230`（`hms(p.ts)`） |
| demand 無資料 | 「此區間 demand-pipeline.log 沒有紀錄」 | `:231-232` |
| bug（一律無 progress） | 「（Bug pipeline 的進度請看 stdout log）」 | `:233-234` |

#### Agent 對話檢視器（規格 §3「Agent 對話檢視器」，`AgentConversationCard.tsx`）
| 欄位 | 規格 | 實作位置 |
|---|---|---|
| `#pd-conv-title` | `${stage}${ticket?' · '+ticket:''}` | `:38-39` |
| `#pd-conv-meta` pills | 時間區間/model/turns/tool calls/in+cache/out/cwd/error | `:47-66` |
| `#pd-prompt` | `d.prompt` 或未另存提示文字 | `:67-73` |
| `#pd-turns` | 逐輪 `.turn.{role}` 區塊，依序渲染 block | `:74-92`、`BlockView`（`:113-148`） |
| `text`/`thinking`/`tool_use`/`tool_result`/其他 block | 見規格 §3 條列 | `BlockView` 對應四個 `if` 分支 + `default`（`:114-147`） |
| 無 turns 退回 rawStdout / 都沒有則「沒有對話事件」 | | `:87-91` |
| `#pd-result` | `is_error`→❌ 最終結果（錯誤）；否則✅ 最終產出；`subtype`+耗時秒數；`result.text` | `:93-101` |
| 渲染完 `scrollIntoView` | 僅成功時 | `:20-27`（`useEffect` 依 `resource.data` 變動觸發，`resource.error` 存在時不觸發） |

---

## 3. 「第 N 輪」顯示條件實作說明

規格 §3「⚠️ 審查輪次顯示」明確要求：**這不是前端固定文案**，`第 N 輪` 完全由後端
`lib/ingest.ts` 的 `computeBugStages()`/`inferCurrentBugStage()` 算好、塞進 `BugStage.detail`
字串（形如 `{agent}・第 {N} 輪`），只在「run 執行中」且「目前正在跑 Step 6 三重審查」時才會
非空；非 running 的歷史 run 一律沒有 `detail`。前端**唯一該做的事**就是「有 `detail` 就原樣附加
在括號裡，沒有就不附加」，不得自己判斷/重算「是不是在跑第幾輪」。

實作（`PipelineDetailView.tsx:64-76`，`stageColumns[0].render`）：

```tsx
render: s => (
  <>
    {s.label}
    {s.detail && (
      <>
        {' '}
        <span className="mute">({s.detail})</span>
      </>
    )}
  </>
),
```

- 顯示條件完全由 `s.detail` 是否為 truthy 決定——不做「running && stage===review」之類的前端條件判斷，因為那個判斷已經由後端做完並反映在 `detail` 是否存在，前端重做等於在猜測後端邏輯，會跟後端脫節。
- 資料流：`GET /api/pipelines/run` → `stages: BugStage[]`（`src/api/types.ts` 已宣告 `detail?: string | null`）→ 本頁直接消費，未對 `detail` 做任何字串解析或格式判斷。
- 唯一的風險點是 SHARED_LAYER_GAP：若共用層 `BugStage.detail` 型別未來被誤改掉，本頁會自動反映（TS 會報錯），目前型別完整涵蓋此欄位，無需 workaround。

---

## 4. 狀態與邊界對照（規格 §5）

| 規格 | 實作位置 |
|---|---|
| 載入中：無 loading 骨架，await 期間畫面維持上次內容不變 | 列表頁：`DataTable` 只依賴 `resource.data`，`useResource` 在背景輪詢時不清空舊 `data`，天然維持上次內容（`PipelinesListView.tsx:20-26`）。詳情頁同理：`PipelineDetailView.tsx:42,57-60` 用 `data?.run` 等 optional chaining，尚未載入時退回空陣列/空字串而非清空畫面框架 |
| 空資料（列表頁）：queued/remote/rows 全空 → `colspan=10` 「無資料」 | `PipelinesListView.tsx:254`（`emptyText="無資料"`，10 欄 columns 陣列自動撐出正確 colSpan） |
| 空資料（詳情頁 agents）：demand/bug 兩種文案 | `PipelineDetailView.tsx:203-207` |
| 空資料（詳情頁 progress）：demand 有/無資料、bug 三種文案 | `PipelineDetailView.tsx:220-235` |
| run 找不到（404）：`pd-title`=「找不到紀錄」，其餘不繼續渲染 | `PipelineDetailView.tsx:42-55`（`notFound = Boolean(detail.error) && !data`，只有從未成功載入過才進最小畫面；若曾經成功載入過（`data` 非 null）則沿用舊資料，等同原版「不繼續渲染」＝保留舊內容） |
| agent-trace 找不到：`pd-conv-title`=`d.error`，其餘不繼續渲染 | `AgentConversationCard.tsx:36-40`（`title` 優先取 `err` 訊息；`data &&` 區塊只在 `data` 存在時渲染，錯誤時 `data` 維持上一次成功值，等同「其餘欄位不繼續渲染」＝顯示舊內容，見 §5 節 traceErrorMessage `:158-165`） |
| 審查輪次資訊缺失：非 running 歷史 run 不附加括號 | 見上方第 3 節 |
| 重做迴圈負耗時防呆 | 完全交給後端 `stages[].started_at` 算好的 `-`，前端不重算（見 §2.2「開始/結束/耗時」列說明） |
| 取消/重試錯誤呈現：一律 `alert()`，無 inline 錯誤區塊 | `PipelinesListView.tsx:35-39,50-54`（`window.alert(...)`，未渲染任何 inline 錯誤 UI） |

---

## 5. 未達成項目 / 刻意折衷

1. **`LogViewer` 無法重現 Prompt／rawStdout 區塊的 `height:auto;max-height:40vh` 雙重限制**：
   共用元件 `LogViewer` 只有單一 `height` 覆寫 prop（`src/components/shared/LogViewer.tsx`），
   沒有獨立的 `maxHeight`。本頁傳 `height="auto"` 讓框隨內容高度伸縮（貼近原版短 prompt 時的
   視覺），但**沒有** 40vh 上限，極端長的 prompt/rawStdout 理論上可以撐得比原版更高。
   已列入 SHARED_LAYER_GAPS，不影響 11 個互動點功能，純視覺邊界差異。
2. **`<span class="warn">進行中</span>`（Agent 流程表「耗時」欄）沒有視覺效果**：這不是本頁疏漏——
   舊版 `global.css`/`index.html` 內嵌樣式本身就只定義了 `.pill.warn`/`button.btn.warn`，
   從未定義過裸的 `.warn{color:...}`，所以原版這個 span 本來就是純文字色，本頁原樣沿用
   `className="warn"`（`PipelineDetailView.tsx:125`），刻意保留這個「看起來像但其實不是」的視覺表現，不算未達成。
3. 其餘 11 個互動點與規格 §2-§5 條列的欄位/邊界皆已對應實作，無遺漏。

---

## 6. SHARED_LAYER_GAPS 詳細說明（摘要，完整見回報訊息）

1. **`PipelineRunDetailResponse['run']` 型別缺 `agents`/`agent_count`/`total_input`/`total_output`/`total_cost`**
   （`src/api/types.ts:350-356`）。實測 `server.ts:340-368`（`GET /api/pipelines/run`）呼叫
   `attachAgentRuns(siblings)` 後直接把整包 `me` 塞進回傳的 `run`，該函式（`server.ts:219-236`）
   會替每列掛上這 5 個欄位；只有 `GET /api/pipelines` 列表端點（`server.ts:250-251`）才會
   `delete r.agents`。`00-api-inventory.md` 對 `/api/pipelines/run` 的型別敘述與 `src/api/types.ts`
   一致地漏了這點，但與 server.ts 原始碼實測不符。Agent 流程表與「合計」列**必需**這些欄位才能渲染，
   已在 `src/pages/pipelines/types.ts` 用局部型別 `PipelineRunWithAgents`/`PipelineRunDetail` +
   執行期 `?? []`/`?? 0` 防呆 workaround，並在該檔加了完整註解，未動 `src/api/types.ts`。
2. **`LogViewer` 缺 `maxHeight` prop**：見上方「未達成項目」第 1 點。
