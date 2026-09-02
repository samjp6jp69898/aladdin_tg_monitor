> ⚠️ 行號基準：本文件的 server.ts 行號是 2026-09-02 新增 `/next/*` 靜態路由**之前**的版本。
> 該次改動在第 44 行後插入了 15 行，因此第 44 行之後的所有行號請 **+15** 才是現行 server.ts 的實際位置。
> API 路徑、參數與回傳結構不受影響。

# tg-monitor API 契約盤點

來源：`/Users/user/aladdin/tg-monitor/server.ts`（809 行，讀於 2026-09-02）。
輔助讀取（僅為確認回傳欄位）：`lib/services.ts`、`lib/db.ts`、`lib/ingest.ts`、`lib/tg-users.ts`、`lib/webhook-status.ts`、`lib/pipeline-queue-state.ts`、`lib/cluster-state.ts`、`lib/toolsmith.ts`；前端 tab 名稱對照讀 `public/index.html`。

**端點總數：32**（`grep -cE "app\.(get|post)\(" server.ts` = 32，與下列小節數一致，含 `GET /` 靜態首頁與 3 個 `handleWorkerAction` 共用 handler 的獨立路由）。

**SSE：無**。`/api/events` 只是普通 GET + `c.json()`，一次性回傳陣列，不是串流。專案本身刻意不用 SSE——`server.ts:787-788` 明確寫「輪詢，不用 SSE——Bun 1.2.9 的 ReadableStream 在客戶端中斷連線時會 segfault，實測踩到」，即時跟隨改用 `/api/log/since` 的 offset 輪詢模式（見該端點小節）。

---

## 靜態檔案服務方式

`server.ts:44`：

```ts
app.get('/', c => c.html(Bun.file(new URL('./public/index.html', import.meta.url).pathname).text()))
```

- 只掛了 `/` 這一條路由，直接讀 `public/index.html` 全文當 HTML 回傳，**沒有** `app.use('/static/*', serveStatic(...))` 這類萬用靜態檔中介層。
- 確認 `public/` 目錄下只有 `index.html` 一個檔案（`ls public/` 只回這一個），且該檔內沒有 `<script src="...">` / `<link rel="stylesheet" href="...">` 之類外部資源引用（grep 掃無結果）——CSS 與 JS 都內嵌在同一份 HTML 裡，845 行單檔 SPA。這解釋了為何現況不需要額外的靜態檔路由：整個前端就是這一次 GET 的回應本體。
- **對 Vite build 產物的意義**：新前端 build 出來會是多檔（`index.html` + `assets/*.js` + `assets/*.css` 等），現有這條路由的做法（讀單一檔案字串塞進 `c.html()`）不能直接套用到多檔案輸出。要另掛一條路徑（例如 `/app/*` 或整個接手 `/`）時，需要引入 Hono 的 `serveStatic`（`hono/bun` 提供）或等效邏輯來服務整個目錄，而不是照抄第 44 行這種單檔讀法。目前這條路由本身不會與新路徑打架，只要新路徑不是 `/`（或決定好由誰接管 `/`）即可共存。

## Middleware / CORS / 認證

- 全檔搜尋 `app.use(`、`cors`、`Authorization`、`Bearer` 均無命中——**沒有任何 Hono middleware，沒有 CORS 設定，沒有任何形式的請求層認證/授權檢查**。
- 唯一的存取邊界是最後一行（`server.ts:809`）：`hostname: '127.0.0.1'`，Bun server 只綁本機 loopback，不對外監聽，不經任何 tunnel。多處端點註解（如 `server.ts:106-108`、`307-311`、`422`、`433`）明確以「只接受本機請求；server 本來就只綁 127.0.0.1」作為省略認證檢查的理由——這是刻意的設計假設，不是遺漏。
- 對前端改造的含意：新 API client 不需要處理 CORS 或帶認證 header；但如果 Vite dev server 跑在不同 port（例如 5173）透過 proxy 打這支 8799 API，仍要留意 dev 環境下的 origin 差異（Vite 本身的 `server.proxy` 設定可解決，不需要 server.ts 加 CORS）。

---

## 端點清單

### GET / — server.ts:44

- Query：無
- Body：無（GET）
- 回傳：`text/html`，`public/index.html` 全文（非 JSON）
- 特殊行為：無快取、無 ETag，每次請求都重新讀檔（`Bun.file().text()`）
- 服務分頁：（推測）整個 SPA 的入口，非特定分頁

### GET /api/overview — server.ts:60

- Query：無
- Body：無
- 回傳（`server.ts:89-103`）：
  ```
  {
    now: string,                    // ISO
    activeWindowMin: number,        // 常數 5
    services: [{
      id: string, name: string, port: number,
      proxyPrefix: string | null, launchdLabel: string | null,
      hasAudit: boolean,
      probe: ProbeResult | null,     // 見下方 ProbeResult
      lastStatusChange: { id, service, ts, status, pid, detail } | null,  // status_log 一列
      activeUsers: [{ identity, n, last_ts, first_ts, last_tool, source_ip }],  // 無 auditLog 時為 []
      req1h: number | null, req24h: number | null, err24h: number | null,
      lastEvent: { ts, identity, tool, path, result } | null,
      rosterSize: number,
    }],
    webhook: WebhookStatus,          // 見下方
    tgUsers: { connectedCount: number, pendingCount: number },
    pipelines: {
      running: RunningProc[],        // { pid, etime, kind:'bug'|'demand', ticket, extra }
      queued: QueuedTicket[],        // { kind, ticket, position, enqueuedAt, triggeredBy }
      limitsSource: 'code' | 'fallback',
      bugSlots: { used: number, limit: number, queued: number },
      demandSlots: { used: number, limit: number, queued: number },
      locks: [{ ticket: string, info: string }],
    },
  }
  ```
  `ProbeResult`（`lib/ingest.ts:854-862`）：`{ id, status: 'up'|'down', pid: number|null, latencyMs: number|null, uptimeSeconds: number|null, detail: string|null, checkedAt: string }`。
  `WebhookStatus`（`lib/webhook-status.ts:14-24`）：`{ ok, url: string|null, pendingUpdateCount: number|null, lastErrorDate: string|null, lastErrorMessage: string|null, ipAddress: string|null, maxConnections: number|null, error: string|null, checkedAt: string }`。
- 特殊行為：`webhook` 帶 30 秒內建快取（`lib/webhook-status.ts:12,67`）；`services[].probe` 是背景 collector 每 5 秒探測一次的快取結果，不是即時查（`server.ts:34`）。
- 錯誤格式：本端點內無顯式錯誤分支，任何拋出例外會落到 Hono 預設處理（未自訂 `app.onError`）。
- 服務分頁：總覽（overview）

### POST /api/services/restart — server.ts:109

- Body：`{ id?: string }`
- 回傳（成功）：`restartService()` 結果 `{ ok: boolean, result: string }`，`ok` 時 HTTP 200，否則 409（`server.ts:114`）
- 錯誤：`id` 為空/缺 → 400 `{ ok: false, result: 'RESTART_ERR_ARGS: missing id' }`（`server.ts:112`）；`restartService()`（`lib/services.ts:240-251`）內部錯誤字串前綴：`RESTART_ERR_UNKNOWN_ID`、`RESTART_ERR_NO_LAUNCHD_LABEL`、`RESTART_ERR_EXEC`；成功前綴 `RESTART_OK`
- 服務分頁：總覽（每個 service 卡片的重啟按鈕，推測）

### GET /api/events — server.ts:118

- Query（皆選填，`server.ts:119-142`）：
  - `service`: string
  - `identity`: string
  - `from`: string（ISO，`ts >= from`）
  - `to`: string（ISO，`ts <= to`）
  - `event`: string
  - `errors`: `'1'` → 只留 `event='auth_failure'` 或 `result LIKE 'error:%'`
  - `toolOnly`: `'1'` → 只留 `tool IS NOT NULL`
  - `q`: string → 對 `tool`/`path`/`result`/`source_ip`/`agrabah_identifier` 做 `LIKE %q%`
  - `before_id`: number → 分頁游標，`id < before_id`
  - `limit`: number，預設 200，`Math.min(limit, 1000)` 上限 1000
- 回傳：`{ rows: EventRow[], limit: number }`
  `EventRow`（`lib/db.ts:94-108`，SELECT 欄位見 `server.ts:140`）：`{ id, service, ts, event, identity, source_ip, method, path, tool, result, agrabah_identifier, duration_ms, reason }`
- 特殊行為：**非 SSE**，一次性回傳最多 `limit` 筆、依 `id DESC` 排序。前端要做「即時」效果需自行輪詢並用 `before_id`/`limit`分頁。
- 服務分頁：即時序列（events）

### GET /api/sessions — server.ts:149

- Query：`days`（預設 7）、`service`（選填）、`identity`（選填）
- 回傳：`{ sessions: Session[], gapMin: number, days: number }`（`gapMin` 常數 10 分鐘）
  `Session`（組裝於 `server.ts:161-178`）：`{ service, identity, start: string, end: string, count: number, errors: number, tools: string[], logins: string[], ips: string[], firstId: number, lastId: number }`（依 `end` 由新到舊排序）
- 服務分頁：使用 Session（sessions）

### GET /api/stats — server.ts:182

- Query：`days`（預設 7）
- 回傳（`server.ts:191`）：
  ```
  {
    days: number,
    perDay: [{ day: string, service: string, n: number }],
    perHour: [{ hour: string, n: number }],       // 固定近 24 小時，不受 days 影響
    topIdentities: [{ identity, service, n, last_ts }],   // 依 last_ts DESC，上限 50
    topTools: [{ tool, service, n, errors, avg_ms }],      // 依 n DESC，上限 50
    authFailures: [{ service, source_ip, reason, n, last_ts }],  // 依 n DESC，上限 50
    totalEvents: number,   // 全表總數，不受 days 篩選
  }
  ```
- 服務分頁：歷史統計（stats）

### GET /api/status-log — server.ts:194

- Query：`service`（選填；不帶則回全部 service 混合）
- 回傳：`{ rows: StatusLogRow[] }`，上限 200 筆，依 `id DESC`
  `StatusLogRow`（`lib/db.ts:38-46`）：`{ id, service, ts, status: 'up'|'down', pid: number|null, detail: string|null }`
- 服務分頁：（推測）總覽的服務狀態變化歷史／服務詳情面板

### GET /api/pipelines — server.ts:225

- Query：無
- 回傳（`server.ts:263`）：
  ```
  {
    rows: PipelineRunRow[],     // 上限 300，依 started_at DESC
    queued: QueuedTicket[],
    remote: DispatchEntry[],
  }
  ```
  `PipelineRunRow`：`pipeline_runs` 表全部欄位（`lib/db.ts:54-63,85,92`：`key, kind, ticket, started_at, stdout_path, stderr_path, finished_at, outcome, cancelled_at, triggered_by`）＋ `attachAgentRuns()` 附加的彙總欄位（`server.ts:217-222`，但 `agents` 陣列本身在回傳前被 `delete`，`server.ts:236`）：`agent_count: number, total_input: number, total_output: number, total_cost: number` ＋ 本端點另加（`server.ts:247-261`）：`running: boolean, assignee: string | null, retryable: boolean`
  `QueuedTicket`（`lib/pipeline-queue-state.ts:43-49`）：`{ kind: 'bug'|'demand', ticket, position: number, enqueuedAt: string, triggeredBy: string | null }`
  `DispatchEntry`（`lib/cluster-state.ts:60-68`）：`{ ticket, kind: 'bug'|'demand', status: 'dispatching'|'confirmed', worker, workerUrl, dispatchedAt, triggeredBy: {name,email} | null }`
- 服務分頁：Pipelines（列表）

### GET /api/toolsmith — server.ts:271

- Query：無
- 回傳：`{ rows: ToolsmithRunRow[] }`（上限 200，依 `updatedAt DESC`，`lib/toolsmith.ts:72-121`）
  `ToolsmithRunRow`（`lib/toolsmith.ts:52-70`）：
  ```
  {
    requestId: string, target: 'admin'|'platform', requestedBy: string, request: string,
    notes: string | null,
    status: 'queued'|'researching'|'needs_clarification'|'deploying'|'done'|'failed',
    completed: boolean, roundsCount: number,
    pendingQuestions: string[] | null,   // 僅 status='needs_clarification' 時有值
    createdAt: string, updatedAt: string,
    finalResult: { success, errorKind?, stage?, message, warnings? } | null,
    agentLogPath: string, agentLogExists: boolean,
    deployLogPath: string, deployLogExists: boolean,
    gates: [{ key, label, status: 'pass'|'fail'|'pending' }] | null,   // 僅 deployLogExists 時有值，6 個固定關卡
  }
  ```
- 服務分頁：Toolsmith

### GET /api/cluster/workers — server.ts:276

- Query：無
- 回傳（`server.ts:287`）：
  ```
  {
    secretConfigured: boolean,
    workers: [{
      ...WorkerInfo,              // { name, url, registeredAt, disabled?: boolean }
      online: boolean,
      health: WorkerHealth | null,      // { status: string, uptime_seconds: number }
      capacity: CapacityReport | null,  // 見下
      tickets: DispatchEntry[],
    }],
  }
  ```
  `CapacityReport`（`lib/cluster-state.ts:84`）：`{ worker: string, bug: QueueStats, demand: QueueStats, ticket?: { ticket, active: boolean } }`；`QueueStats`：`{ limit, running, queued }`
- 特殊行為：`capacity` 只在 `CLUSTER_SHARED_SECRET` 有設定時才會查（否則為 `null`），對每個 worker 平行 `fetch`（2.5s/3s timeout），worker 連不上時 `health`/`capacity` 為 `null`、`online: false`
- 服務分頁：Workers

### GET /api/cluster/worker — server.ts:293

- Query：`name`（必填，找不到對應 worker → 見錯誤）、`ticket`（選填，須符合 `/^(FAQ|ALDREQ)-\d+$/` 才會生效）
- 錯誤：`name` 對不到已註冊 worker → 404 `{ error: 'worker 未註冊（可能已退役或名稱打錯）' }`
- 回傳（`server.ts:304`）：
  ```
  {
    worker: WorkerInfo,
    online: boolean,
    health: WorkerHealth | null,
    capacity: CapacityReport | null,
    tickets: DispatchEntry[],
    ticketStatus: { ticket: string, status: JobStatus | null } | null,  // 只在帶合法 ticket 且 secret 已設定時非 null
  }
  ```
  `JobStatus`（`lib/cluster-state.ts:87`）：`{ locked: boolean, queueState: 'running'|'queued'|null, progress: string|null, stages?: ProgressStage[] }`；`ProgressStage`：`{ key, label, done: boolean, current: boolean, at: string|null }`
- 服務分頁：Workers（單一 worker 詳情面板）／Pipelines（「查看 worker」連結，推測）

### POST /api/cluster/worker/disable — server.ts:322
### POST /api/cluster/worker/enable — server.ts:323
### POST /api/cluster/worker/remove — server.ts:324

三者共用同一個 handler `handleWorkerAction`（`server.ts:312-321`），差別只在呼叫 `disableWorker`/`enableWorker`/`removeWorker`（`lib/cluster-state.ts:141-143`，皆為 POST 到 head 8787 的 `/cluster/worker/:name/{action}`）。

- Body：`{ name?: string }`
- 錯誤：
  - `name` 缺 → 400 `{ ok: false, reason: 'missing name' }`
  - `CLUSTER_SHARED_SECRET` 未設定 → 409 `{ ok: false, reason: 'CLUSTER_SHARED_SECRET 未設定，cluster 機制停用' }`
  - head 回 404 → 409 `{ ok: false, reason: 'head 名冊裡找不到 worker「${name}」' }`
  - head 回其他非 2xx 或連不上 → 409 `{ ok: false, reason: 'head 回應 ${status || '（連不上）'}' }`
- 成功：200 `{ ok: true }`
- 服務分頁：Workers（中斷/恢復/移除按鈕）

### GET /api/pipelines/run — server.ts:327

> **2026-09-02 修正**：原文誤植「`run` 不含 agent_count 等彙總欄」。實際上 handler 呼叫
> `attachAgentRuns(siblings)`（server.ts:332，對應本檔案「插入 15 行前」編號；含 `+15` offset
> 即現版 server.ts:347）後，直接把該筆 `me` 整包塞進回應，並未像 `/api/pipelines`
> （server.ts:236 之後 `delete r.agents`）那樣刪掉——所以 `run` 不只有 `agent_count` /
> `total_input` / `total_output` / `total_cost` 四個彙總欄，還多了 `agents[]` 本體（下方已更正）。

- Query：`key`（必填，`pipeline_runs.key`）
- 錯誤：查無此 key → 404 `{ error: 'not found' }`
- 回傳（`server.ts:368`）：
  ```
  {
    run: PipelineRunRow & {
      running: boolean,
      agents: AgentRunRow[],       // agent_runs 表列，見 GET /api/agent-trace 附近 AgentSummary 同源欄位
      agent_count: number,
      total_input: number,
      total_output: number,
      total_cost: number,
    },
    progress: [{ ts: string, msg: string }],     // 僅 kind='demand' 時有內容，否則 []
    stages: BugStage[],                          // 僅 kind='bug' 且（此 run 正在跑 或 是同票最新一次且無其他跑著的）時計算，否則 []
  }
  ```
  `BugStage`（`lib/ingest.ts:447-461`）：`{ key: string, label: string, status: 'done'|'reused'|'pending'|'running', started_at: string|null, finished_at: string|null, detail?: string|null }`
- 服務分頁：Pipelines（單張票的詳情/進度頁，前端定期輪詢，`server.ts:362-363` 註解）

### GET /api/agent-trace — server.ts:372

- Query：`path`（必填，須通過 `isAllowedTracePath()` 白名單：`lib/services.ts:224-228`，僅允許 `AGENT_TRACE_DIR/*.json` 或 `DISPATCHER_LOG_DIR/*.stdout.log`）
- 錯誤：
  - path 不在白名單 → 403 純文字 `'path not allowed'`
  - 檔案不存在 → 404 `{ error: 'missing' }`
  - 內容整檔 JSON 與逐行 JSONL 都解析失敗 → 500 `{ error: 'parse failed: ${err}' }`
- 回傳（`server.ts:412-419`）：
  ```
  {
    meta: isTrace
      ? { ticket, stage, startedAt, endedAt, cwd, args, error: any | null }
      : { stage: 'create-mr' },     // isTrace=false 時代表讀的是 bug pipeline 的 stdout.log（非結構化 trace JSON）
    prompt: string | null,          // 僅 isTrace 時可能非 null
    summary: AgentSummary,          // 見下
    result: {
      text: string | null, is_error: boolean, subtype, usage, modelUsage,
      total_cost_usd, num_turns, duration_ms,
    } | null,
    turns: [{
      role: 'assistant' | 'user', ts: string | null,
      blocks: [
        // assistant: {type:'text',text} | {type:'thinking',text} | {type:'tool_use',id,name,input} | {type:string}
        // user:      {type:'tool_result',tool_use_id,is_error,content(截斷至 20000 字)} | {type:'text',text} | {type:string}
      ],
    }],
    rawStdout: string | null,       // 僅 isTrace 且原始資料含 rawStdout 欄位時有值，截斷至 20000 字
  }
  ```
  `AgentSummary`（`lib/ingest.ts:746-757`）：`{ model: string|null, input_tokens: number|null, output_tokens: number|null, cache_read_tokens: number|null, cache_create_tokens: number|null, cost_usd: number|null, num_turns: number|null, tool_calls: number, is_error: number, result_preview: string|null }`
- 服務分頁：Pipelines（單一 agent 對話 drill-down，推測）

### POST /api/pipelines/cancel — server.ts:423

- Body：`{ kind?: 'bug'|'demand', ticket?: string }`
- 驗證：`kind` 必須是 `'bug'` 或 `'demand'` 且 `ticket` 須符合 `/^[A-Z]+-\d+$/`，否則 400 `{ ok: false, reason: 'bad params' }`
- 回傳：`cancelPipeline()` 結果（`lib/ingest.ts:155-193`）`{ ok: boolean, killed: number[], wrapperPid?: number, reason?: string }`，`ok` 為 200 否則 409。`reason` 常見值如 `'not running（可能剛結束，或 ps 快照尚未更新，3 秒後再試）'`
- 服務分頁：Pipelines（取消按鈕）

### POST /api/pipelines/retry — server.ts:471

- Body：`{ ticket?: string }`
- 驗證與錯誤（依序，`server.ts:472-512`）：
  - `ticket` 不符 `/^FAQ-\d+$/` → 400 `{ ok: false, reason: 'ticket 格式錯誤（僅支援 FAQ-數字，需求單 ALDREQ 目前不提供這個按鈕）' }`
  - 該票已在跑 → 409 `{ ok: false, reason: '這張票目前還在跑，不能重複觸發' }`
  - bug pipeline 併發已達上限（`RETRY_CONCURRENCY_LIMIT` = 啟動時讀到的 `PIPELINE_LIMITS.bug`）→ 429 `{ ok: false, reason: '背景 pipeline 併發已達上限（${limit}），稍後再試' }`
  - tracker 查無此票 → 404 `{ ok: false, reason: 'tracker 查無這張票' }`
  - tracker 狀態不是 `failed`/`in_progress`/`rerun` → 409 `{ ok: false, reason: '目前 tracker 狀態是「${status}」，只有 failed / in_progress（卡住）/ rerun 才能用這個按鈕重試' }`
  - `tracker.sh set` 執行失敗 → 500 `{ ok: false, reason: 'tracker.sh set 失敗：${err}' }`
  - spawn 邏輯失敗（回傳 `{ok:false}`）→ 500 `{ ok: false, reason: 'spawn 失敗：${spawned.reason}' }`
  - spawn 呼叫本身丟例外 → 500 `{ ok: false, reason: 'spawn 呼叫失敗（票已設回 rerun，可再按一次重試）：${err}' }`
- 成功：200 `{ ok: true, pid: number | undefined }`
- 服務分頁：Pipelines（重試按鈕）

### GET /api/tg-users — server.ts:516

- Query：無
- 回傳：`{ connected: ConnectedUser[], pending: PendingSender[], techUsers: TechUser[] }`
  - `ConnectedUser`（`lib/tg-users.ts:15`）：`{ name, email, chat_id }`
  - `PendingSender`（`lib/tg-users.ts:16`）：`{ chat_id, first_name, last_name, username, last_ts }`（依 `last_ts` DESC）
  - `TechUser`（`lib/tg-users.ts:17`）：`{ name, email, chat_id }`（含未連接者，`chat_id` 可能為空字串）
- 服務分頁：連接（tokens tab group）／TG 已連接／TG 待處理 三個子分頁共用同一個資料源

### POST /api/tg-users/assign — server.ts:522

- Body：`{ chat_id?: string, email?: string, force?: boolean }`
- 驗證：`chat_id`、`email` 皆必填（trim 後非空），否則 400 `{ ok: false, result: 'SET_ERR_ARGS: missing chat_id/email' }`
- 回傳：`assignChatId()` 結果（`lib/tg-users.ts:73-95`）`{ ok: boolean, result: string }`，成功字串前綴 `SET_OK`，200/409。`force` 對應 `tg-map-chatids.sh --set ... --force`
- 服務分頁：TG 待處理（手動指定技術人員）

### POST /api/tg-users/unset — server.ts:532

- Body：`{ email?: string }`
- 驗證：`email` 必填，否則 400 `{ ok: false, result: 'UNSET_ERR_ARGS: missing email' }`
- 回傳：`unsetChatId()` 結果（`lib/tg-users.ts:98-106`）`{ ok, result }`，成功前綴 `UNSET_OK` 或 `UNSET_NOOP`，200/409
- 服務分頁：TG 已連接（取消連接按鈕）

### POST /api/tg-users/test — server.ts:541

- Body：`{ email?: string, text?: string }`（`text` 空白時預設 `'這是一則來自 tg-monitor 的測試訊息'`）
- 驗證：`email` 必填，否則 400 `{ ok: false, result: 'TG_ERR_ARGS: missing email' }`
- 回傳：`sendTestMessage()` 結果（`lib/tg-users.ts:109-117`）`{ ok, result }`，成功前綴 `TG_SENT`，200/409
- 服務分頁：TG 已連接（測試發送按鈕）

### GET /api/rosters — server.ts:550

- Query：無
- 回傳：**頂層是陣列**（非物件）：`[{ service: string, roster: [{ id, display_name, issued_at }] }]`，只列有 `tokensPath` 的 service（`lib/ingest.ts:932-941`）
- 服務分頁：（推測）連接／Token 權限相關頁面，用途可能與 `/api/token-grants` 重疊或供其他呈現方式；下游 API client 需注意這是陣列頂層，跟其他端點多為物件頂層不同

### GET /api/token-grants — server.ts:557

- Query：無
- 回傳（`server.ts:576`）：
  ```
  {
    services: [{ id: string, name: string }],
    people: [{
      id: string, display_name: string,
      grants: { [serviceId: string]: { issued_at: string, last_ts: string | null, n: number } },
    }],  // 依 id 字典序排序
  }
  ```
- 特殊行為：已知侷限（`server.ts:565-568` 註解）：同一 `display_name` 被兩個不同 id 共用時，依 `display_name` 比對到的用量會重複計入兩人
- 服務分頁：連接／Token 權限子分頁

### POST /api/token-grants/revoke — server.ts:659

- Body：`{ id?: string, services?: string[] }`
- 驗證：`id` 須符合 `KIT_ID_PATTERN`（`/^[a-z][a-z0-9_-]{1,31}$/`）否則 400 `{ ok: false, result: 'REVOKE_ERR_ARGS: id 格式不合法' }`；`services` 非空且每個值需在允許清單（`admin-dev / admin-pre / admin-evi / platform / platform-6t / platform-pre-pk / platform-pre-6t / platform-evi-6t / toolsmith`）否則 400 `{ ok: false, result: 'REVOKE_ERR_ARGS: services 只能是 ...' }`
- 回傳：`combine()` 彙整結果 `{ ok: boolean, result: string }`（多個底層腳本輸出以 `\n\n` 串接），200/409
- 服務分頁：Token 權限（撤銷）

### POST /api/token-grants/add — server.ts:674

- Body：`{ id?: string, service?: string }`（單一 service，非陣列）
- 驗證與錯誤：
  - `id` 格式錯 → 400 `ADD_ERR_ARGS: id 格式不合法`
  - `service` 不合法（非 `toolsmith` 且不在 `KIT_GRANT_BY_SERVICE`）→ 400 `ADD_ERR_ARGS: service 只能是 ...`
  - 該環境已有此 id → 409 `ADD_ERR_EXISTS: 此環境已有這個 id 的 token（要換新 token 請用「重發 token」）`
  - 名冊裡找不到這個 id（無法帶出 display_name）→ 404 `ADD_ERR_NOT_FOUND: 名冊裡找不到這個 id（全新的人請用「新增 token」表單）`
- 回傳：`runToolsmithTokens`/`runMakeKit` 結果 `{ ok, result }`，200/409
- 服務分頁：Token 權限（補簽某一環境）

### POST /api/token-grants/rename — server.ts:695

- Body：`{ id?: string, name?: string }`
- 驗證：`id` 格式錯 → 400 `RENAME_ERR_ARGS: id 格式不合法`；`name` 空或超過 64 字 → 400 `RENAME_ERR_ARGS: display_name 不能為空且不超過 64 字`；名冊都找不到此 id → 404 `RENAME_ERR_NOT_FOUND: 名冊裡找不到這個 id`
- 回傳：`combine()` 結果 `{ ok, result }`，200/409
- 服務分頁：Token 權限（改顯示名）

### POST /api/token-grants/create — server.ts:714

- Body：`{ id?: string, name?: string, services?: string[] }`
- 驗證：`id` 不符 `KIT_ID_PATTERN` → 400 `CREATE_ERR_ARGS: id 格式不合法（小寫英數/連字號/底線，2-32 字，小寫字母開頭）`；`name` 空或 >64 字 → 400 `CREATE_ERR_ARGS: display_name 不能為空且不超過 64 字`；`services` 空或含不合法值 → 400 `CREATE_ERR_ARGS: services 至少一個，且只能是 ...`
- 回傳：`reconcileGrants()` 結果 `{ ok, result }`，200/409
- 服務分頁：Token 權限（新增 token 表單）

### POST /api/token-grants/resend — server.ts:730

- Body：`{ id?: string, services?: string[] }`（`services` 選填——不帶時 fallback 成此人名冊裡現有的全部環境）
- 驗證：`id` 格式錯 → 400 `RESEND_ERR_ARGS: id 格式不合法`；此 id 任何環境都沒有 token → 404 `RESEND_ERR_NOT_FOUND: 此 id 沒有任何環境的 token`；`services` 空或含不合法值 → 400 `RESEND_ERR_ARGS: services 至少勾選一個，且只能是 ...`
- 回傳：`reconcileGrants()` 結果 `{ ok, result }`，200/409
- 服務分頁：Token 權限（重發 token；含列表頁快速按鈕與可勾選環境的表單兩種用法）

### GET /api/logs — server.ts:748

- Query：無
- 回傳（`server.ts:761`）：
  ```
  {
    registered: [{ service, label, path, exists: boolean, size: number }],   // 來自 SERVICES 登錄表各自的 logs[]
    pipelineLogs: [{ service: 'dispatcher', label: string, path, exists: true, size: number, mtime: string }],
    // pipelineLogs 只收 DISPATCHER_LOG_DIR 下檔名符合 /^[A-Z]+-\d+\./ 且以 .log 結尾者，依 mtime DESC
  }
  ```
- 服務分頁：Logs（清單）

### GET /api/log/tail — server.ts:779

- Query：`path`（必填，須通過 `isAllowedLogPath()` 白名單：`lib/services.ts:209-217`）、`kb`（預設 64，`Math.min(kb, 2048)` 上限 2048）
- 錯誤：path 不在白名單 → 403 純文字 `'path not allowed'`
- 缺檔：200 `{ text: '', size: 0, missing: true }`（非 404）
- 回傳：`tailFile()` 結果（`server.ts:764-777`）`{ text: string, size: number }`——讀檔尾 `kb*1024` bytes，若非從檔頭開始讀則捨棄第一個不完整行
- 服務分頁：Logs（開啟某檔內容）

### GET /api/log/since — server.ts:789

- Query：`path`（必填，同上白名單）、`offset`（預設 0）
- 錯誤：path 不在白名單 → 403 純文字 `'path not allowed'`
- 缺檔：200 `{ text: '', offset: 0, missing: true }`
- 回傳：`{ text: string, offset: number }`——回傳從 `offset` 到目前檔尾的新增內容（單次最多讀 2MB）；若 `size < offset`（檔案被截斷/輪替）則視為從頭重讀（`offset` 重置為 0）；若 `size === offset` 回傳 `{ text: '', offset }`（無新內容）
- 特殊行為：這是 `/api/events` 之外**唯一的「即時跟隨」機制**，明確設計為輪詢＋offset 游標，而非 SSE／WebSocket（見檔案 `server.ts:787-788` 註解，原因是 Bun 1.2.9 的 ReadableStream 在客戶端中斷時會 segfault，經實測踩過）。前端 API client 若要做「tail -f」效果，應：初次帶 `offset=0`（或不帶）拿到目前內容與新 `offset`，之後定期輪詢並帶回上次拿到的 `offset`。
- 服務分頁：Logs（即時跟隨檢視）

---

## 給下游 agent 的重點提醒

1. **沒有 SSE、沒有 WebSocket**：全部 32 個端點都是普通請求-回應，前端所有「即時」效果現況都是輪詢（`/api/overview`、`/api/events`、`/api/pipelines`、`/api/log/since` 等各自被前端以不同頻率定期呼叫）。新 React 前端若想做輪詢，直接照抄現有頻率假設（總覽/log 5 秒級、pipeline 詳情頁另有專屬輪詢，見 `server.ts:362-363` 註解）即可，不需要引入串流基礎設施。
2. **兩種錯誤慣例並存**：多數 mutating（POST）端點回傳 `{ ok: boolean, result?: string, reason?: string }` 且用 200/400/404/409/429/500 表達語意，錯誤訊息在 body 裡（字串前綴如 `RESTART_ERR_*`、`SET_ERR_*` 可用於前端判斷錯誤類型）；少數唯讀端點的路徑白名單失敗直接回 403 **純文字**（非 JSON）——`/api/log/tail`、`/api/log/since`、`/api/agent-trace` 三處，API client 對這三個端點要特別處理非 JSON 的 403 回應。
3. **`GET /api/rosters` 頂層是陣列**，不同於其他端點多為物件頂層，寫 API client 時型別要區分。
4. **`GET /api/pipelines` 回傳的 `rows[]` 與 `GET /api/pipelines/run` 回傳的 `run` 欄位不完全相同，但方向與原文相反**：兩者都有 `agent_count/total_input/total_output/total_cost`（彙總自同票全部歷史 run 的 agent），差別是後者（`run`）額外多了 `agents[]` 彙總來源本體，前者的 `rows[]` 在回傳前會 `delete r.agents` 只留彙總欄（`server.ts:251`）。（2026-09-02 修正：原文寫反，誤植成後者沒有彙總欄。）
5. 目前完全沒有認證機制，是建立在「只綁 127.0.0.1」這個假設上；若日後前端改造讓這支 server 可能被非本機存取（例如透過反向 proxy），需要重新評估這個假設是否還成立——這不在本次盤點範圍內，僅提醒風險。
