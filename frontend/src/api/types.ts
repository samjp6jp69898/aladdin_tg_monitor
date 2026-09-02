/**
 * tg-monitor API 回傳型別。
 *
 * 唯一依據：migration/00-api-inventory.md（32 個端點的完整契約）。
 * **欄位以 inventory 為準**，沒有自行增補或改名。若下游分頁發現實際回傳與此處不符，
 * 請回報指揮官修正本檔，不要在分頁裡自己 cast 掉。
 *
 * 命名慣例：
 * - `XxxResponse`：某個 GET 端點的完整回傳物件。
 * - 其餘為可重複使用的資料列 / 子結構。
 */

/* ────────────────────────────── 共用：mutating 端點的回傳形狀 ────────────────────────────── */

/**
 * 多數 POST 端點的回傳形狀：`{ ok, result }`（result 為訊息字串，含 `XXX_OK` / `XXX_ERR_*` 前綴）。
 * HTTP 狀態碼 200 = ok，400/404/409 = 失敗（body 仍是這個形狀）。
 */
export interface OkResult {
  ok: boolean
  result: string
}

/** worker 操作端點（disable/enable/remove）的回傳形狀：失敗訊息放在 `reason`，不是 `result`。 */
export interface OkReason {
  ok: boolean
  reason?: string
}

/* ────────────────────────────── GET /api/overview ────────────────────────────── */

/** lib/ingest.ts:854-862 */
export interface ProbeResult {
  id: string
  status: 'up' | 'down'
  pid: number | null
  latencyMs: number | null
  uptimeSeconds: number | null
  detail: string | null
  checkedAt: string
}

/** status_log 的一列（lib/db.ts:38-46）。 */
export interface StatusLogRow {
  id: number
  service: string
  ts: string
  status: 'up' | 'down'
  pid: number | null
  detail: string | null
}

/** overview 服務卡片內的「目前使用中」清單元素。 */
export interface ActiveUser {
  identity: string
  n: number
  last_ts: string
  first_ts: string
  last_tool: string | null
  source_ip: string | null
}

/** overview 服務卡片的「最後一筆事件」。 */
export interface OverviewLastEvent {
  ts: string
  identity: string | null
  tool: string | null
  path: string | null
  result: string | null
}

export interface OverviewService {
  id: string
  name: string
  port: number
  proxyPrefix: string | null
  launchdLabel: string | null
  hasAudit: boolean
  probe: ProbeResult | null
  /** status_log 最新一列；無紀錄時 null。 */
  lastStatusChange: StatusLogRow | null
  /** 無 auditLog 的服務為空陣列。 */
  activeUsers: ActiveUser[]
  req1h: number | null
  req24h: number | null
  err24h: number | null
  lastEvent: OverviewLastEvent | null
  rosterSize: number
}

/** lib/webhook-status.ts:14-24；帶 30 秒內建快取。 */
export interface WebhookStatus {
  ok: boolean
  url: string | null
  pendingUpdateCount: number | null
  lastErrorDate: string | null
  lastErrorMessage: string | null
  ipAddress: string | null
  maxConnections: number | null
  error: string | null
  checkedAt: string
}

/** 正在跑的 pipeline 行程（overview 的 pipelines.running）。 */
export interface RunningProc {
  pid: number
  etime: string
  kind: 'bug' | 'demand'
  ticket: string
  extra: string | null
}

/** lib/pipeline-queue-state.ts:43-49 */
export interface QueuedTicket {
  kind: 'bug' | 'demand'
  ticket: string
  position: number
  enqueuedAt: string
  triggeredBy: string | null
}

export interface PipelineSlots {
  used: number
  limit: number
  queued: number
}

export interface PipelineLock {
  ticket: string
  info: string
}

export interface OverviewPipelines {
  running: RunningProc[]
  queued: QueuedTicket[]
  limitsSource: 'code' | 'fallback'
  bugSlots: PipelineSlots
  demandSlots: PipelineSlots
  locks: PipelineLock[]
}

export interface OverviewResponse {
  /** ISO 時間字串。 */
  now: string
  /** 常數 5（分鐘）。 */
  activeWindowMin: number
  services: OverviewService[]
  webhook: WebhookStatus
  tgUsers: { connectedCount: number; pendingCount: number }
  pipelines: OverviewPipelines
}

/* ────────────────────────────── GET /api/events ────────────────────────────── */

/** lib/db.ts:94-108 */
export interface EventRow {
  id: number
  service: string
  ts: string
  event: string | null
  identity: string | null
  source_ip: string | null
  method: string | null
  path: string | null
  tool: string | null
  result: string | null
  agrabah_identifier: string | null
  duration_ms: number | null
  reason: string | null
}

export interface EventsParams {
  service?: string
  identity?: string
  /** ISO，`ts >= from` */
  from?: string
  /** ISO，`ts <= to` */
  to?: string
  event?: string
  /** '1' → 只留 auth_failure 或 result LIKE 'error:%' */
  errors?: '1'
  /** '1' → 只留 tool IS NOT NULL */
  toolOnly?: '1'
  /** 對 tool/path/result/source_ip/agrabah_identifier 做 LIKE %q% */
  q?: string
  /** 分頁游標，`id < before_id` */
  before_id?: number
  /** 預設 200，後端上限 1000 */
  limit?: number
}

export interface EventsResponse {
  rows: EventRow[]
  limit: number
}

/* ────────────────────────────── GET /api/sessions ────────────────────────────── */

export interface SessionRow {
  service: string
  identity: string
  start: string
  end: string
  count: number
  errors: number
  tools: string[]
  logins: string[]
  ips: string[]
  firstId: number
  lastId: number
}

export interface SessionsParams {
  /** 預設 7 */
  days?: number
  service?: string
  identity?: string
}

export interface SessionsResponse {
  sessions: SessionRow[]
  /** 常數 10（分鐘）。 */
  gapMin: number
  days: number
}

/* ────────────────────────────── GET /api/stats ────────────────────────────── */

export interface StatsPerDay {
  day: string
  service: string
  n: number
}

export interface StatsPerHour {
  hour: string
  n: number
}

export interface StatsTopIdentity {
  identity: string
  service: string
  n: number
  last_ts: string
}

export interface StatsTopTool {
  tool: string
  service: string
  n: number
  errors: number
  avg_ms: number | null
}

export interface StatsAuthFailure {
  service: string
  source_ip: string | null
  reason: string | null
  n: number
  last_ts: string
}

export interface StatsResponse {
  days: number
  perDay: StatsPerDay[]
  /** 固定近 24 小時，不受 days 影響。 */
  perHour: StatsPerHour[]
  /** 依 last_ts DESC，上限 50。 */
  topIdentities: StatsTopIdentity[]
  /** 依 n DESC，上限 50。 */
  topTools: StatsTopTool[]
  /** 依 n DESC，上限 50。 */
  authFailures: StatsAuthFailure[]
  /** 全表總數，不受 days 篩選。 */
  totalEvents: number
}

/* ────────────────────────────── GET /api/status-log ────────────────────────────── */

export interface StatusLogResponse {
  /** 上限 200 筆，依 id DESC。 */
  rows: StatusLogRow[]
}

/* ────────────────────────────── GET /api/pipelines ────────────────────────────── */

/** lib/cluster-state.ts:60-68 */
export interface DispatchEntry {
  ticket: string
  kind: 'bug' | 'demand'
  status: 'dispatching' | 'confirmed'
  worker: string
  workerUrl: string
  dispatchedAt: string
  triggeredBy: { name: string; email: string } | null
}

/** pipeline_runs 表欄位（lib/db.ts:54-63,85,92）。 */
export interface PipelineRunBase {
  key: string
  kind: 'bug' | 'demand'
  ticket: string
  started_at: string
  stdout_path: string | null
  stderr_path: string | null
  finished_at: string | null
  outcome: string | null
  cancelled_at: string | null
  triggered_by: string | null
}

/**
 * GET /api/pipelines 的 rows 元素：base 欄位 + attachAgentRuns() 彙總欄位 + 本端點另加的三個旗標。
 * ⚠️ 與 GET /api/pipelines/run 的 `run` 不同：後者的 attachAgentRuns() 呼叫（server.ts:347）
 * 沒有像本端點一樣 `delete r.agents`（server.ts:251 只在這裡刪），所以後者不只同樣有這四個
 * 彙總欄，還多了 `agents[]` 本體（見下方 PipelineRunDetailResponse）。
 */
export interface PipelineRun extends PipelineRunBase {
  agent_count: number
  total_input: number
  total_output: number
  total_cost: number
  running: boolean
  assignee: string | null
  retryable: boolean
}

export interface PipelinesResponse {
  /** 上限 300，依 started_at DESC。 */
  rows: PipelineRun[]
  queued: QueuedTicket[]
  remote: DispatchEntry[]
}

/* ────────────────────────────── GET /api/pipelines/run ────────────────────────────── */

/** lib/ingest.ts:447-461 */
export interface BugStage {
  key: string
  label: string
  status: 'done' | 'reused' | 'pending' | 'running'
  started_at: string | null
  finished_at: string | null
  detail?: string | null
}

export interface DemandProgressEntry {
  ts: string
  msg: string
}

/** agent_runs 表一列（lib/db.ts:66-82）。GET /api/pipelines/run 的 run.agents 元素。 */
export interface AgentRunRow {
  path: string
  ticket: string
  kind: 'bug' | 'demand'
  stage: string
  started_at: string
  ended_at: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_create_tokens: number | null
  cost_usd: number | null
  num_turns: number | null
  tool_calls: number
  is_error: number
  result_preview: string | null
}

export interface PipelineRunDetailResponse {
  /**
   * 2026-09-02 修正：原本誤植為「不含 agent_count / total_* 彙總欄」。
   * 實際上 server.ts 的 `GET /api/pipelines/run` handler（server.ts:342-377）呼叫
   * `attachAgentRuns(siblings)`（server.ts:347）後，直接把該筆 `me` 整包塞進
   * `c.json({ run: me, ... })`，並未像 `GET /api/pipelines`（server.ts:251）一樣
   * `delete r.agents`——所以 `run` 上同時有 `agents[]` 本體與四個彙總欄，且一定存在
   * （`attachAgentRuns()` 對每列都無條件賦值，即使是空陣列/0）。
   */
  run: PipelineRunBase & {
    running: boolean
    agents: AgentRunRow[]
    agent_count: number
    total_input: number
    total_output: number
    total_cost: number
  }
  /** 僅 kind='demand' 時有內容，否則 []。 */
  progress: DemandProgressEntry[]
  /** 僅 kind='bug' 且此 run 為當前/最新一次時才計算，否則 []。 */
  stages: BugStage[]
}

/* ────────────────────────────── GET /api/agent-trace ────────────────────────────── */

/** lib/ingest.ts:746-757 */
export interface AgentSummary {
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_create_tokens: number | null
  cost_usd: number | null
  num_turns: number | null
  tool_calls: number
  is_error: number
  result_preview: string | null
}

export interface AgentTraceMeta {
  ticket?: string
  stage?: string
  startedAt?: string
  endedAt?: string
  cwd?: string
  args?: unknown
  error?: unknown
}

export interface AgentTraceResult {
  text: string | null
  is_error: boolean
  subtype: string | null
  usage: unknown
  modelUsage: unknown
  total_cost_usd: number | null
  num_turns: number | null
  duration_ms: number | null
}

export type AgentTraceBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; is_error: boolean; content: string }
  | { type: string; [k: string]: unknown }

export interface AgentTraceTurn {
  role: 'assistant' | 'user'
  ts: string | null
  blocks: AgentTraceBlock[]
}

export interface AgentTraceResponse {
  /** isTrace 時是結構化 meta；讀 bug pipeline stdout.log 時固定為 `{ stage: 'create-mr' }`。 */
  meta: AgentTraceMeta
  /** 僅 isTrace 時可能非 null。 */
  prompt: string | null
  summary: AgentSummary
  result: AgentTraceResult | null
  turns: AgentTraceTurn[]
  /** 僅 isTrace 且原始資料含此欄位時有值，截斷至 20000 字。 */
  rawStdout: string | null
}

/* ────────────────────────────── pipeline 操作端點 ────────────────────────────── */

export interface CancelPipelineResponse {
  ok: boolean
  killed: number[]
  wrapperPid?: number
  reason?: string
}

export interface RetryPipelineResponse {
  ok: boolean
  pid?: number
  reason?: string
}

/* ────────────────────────────── GET /api/toolsmith ────────────────────────────── */

export type ToolsmithStatus =
  | 'queued'
  | 'researching'
  | 'needs_clarification'
  | 'deploying'
  | 'done'
  | 'failed'

export interface ToolsmithFinalResult {
  success: boolean
  errorKind?: string
  stage?: string
  message: string
  warnings?: string[]
}

export interface ToolsmithGate {
  key: string
  label: string
  status: 'pass' | 'fail' | 'pending'
}

/** lib/toolsmith.ts:52-70 */
export interface ToolsmithRun {
  requestId: string
  target: 'admin' | 'platform'
  requestedBy: string
  request: string
  notes: string | null
  status: ToolsmithStatus
  completed: boolean
  roundsCount: number
  /** 僅 status='needs_clarification' 時有值。 */
  pendingQuestions: string[] | null
  createdAt: string
  updatedAt: string
  finalResult: ToolsmithFinalResult | null
  agentLogPath: string
  agentLogExists: boolean
  deployLogPath: string
  deployLogExists: boolean
  /** 僅 deployLogExists 時有值，6 個固定關卡。 */
  gates: ToolsmithGate[] | null
}

export interface ToolsmithResponse {
  /** 上限 200，依 updatedAt DESC。 */
  rows: ToolsmithRun[]
}

/* ────────────────────────────── cluster / workers ────────────────────────────── */

export interface WorkerInfo {
  name: string
  url: string
  registeredAt: string
  disabled?: boolean
}

export interface WorkerHealth {
  status: string
  uptime_seconds: number
}

export interface QueueStats {
  limit: number
  running: number
  queued: number
}

/** lib/cluster-state.ts:84 */
export interface CapacityReport {
  worker: string
  bug: QueueStats
  demand: QueueStats
  ticket?: { ticket: string; active: boolean }
}

/** lib/cluster-state.ts:87 */
export interface ProgressStage {
  key: string
  label: string
  done: boolean
  current: boolean
  at: string | null
}

export interface JobStatus {
  locked: boolean
  queueState: 'running' | 'queued' | null
  progress: string | null
  stages?: ProgressStage[]
}

/** GET /api/cluster/workers 的 workers 元素：WorkerInfo 攤平 + 線上狀態。 */
export interface WorkerEntry extends WorkerInfo {
  online: boolean
  health: WorkerHealth | null
  /** 只在 CLUSTER_SHARED_SECRET 有設定時才會查，否則 null。 */
  capacity: CapacityReport | null
  tickets: DispatchEntry[]
}

export interface WorkersResponse {
  secretConfigured: boolean
  workers: WorkerEntry[]
}

export interface WorkerDetailResponse {
  worker: WorkerInfo
  online: boolean
  health: WorkerHealth | null
  capacity: CapacityReport | null
  tickets: DispatchEntry[]
  /** 只在帶合法 ticket（/^(FAQ|ALDREQ)-\d+$/）且 secret 已設定時非 null。 */
  ticketStatus: { ticket: string; status: JobStatus | null } | null
}

/* ────────────────────────────── GET /api/tg-users ────────────────────────────── */

/** lib/tg-users.ts:15 */
export interface ConnectedUser {
  name: string
  email: string
  chat_id: string
}

/** lib/tg-users.ts:16 */
export interface PendingSender {
  chat_id: string
  first_name: string | null
  last_name: string | null
  username: string | null
  last_ts: string
}

/** lib/tg-users.ts:17；含未連接者，chat_id 可能為空字串。 */
export interface TechUser {
  name: string
  email: string
  chat_id: string
}

export interface TgUsersResponse {
  connected: ConnectedUser[]
  /** 依 last_ts DESC。 */
  pending: PendingSender[]
  techUsers: TechUser[]
}

/* ────────────────────────────── GET /api/rosters ────────────────────────────── */

export interface RosterMember {
  id: string
  display_name: string
  issued_at: string
}

/** ⚠️ 本端點頂層是**陣列**，不是物件。只列有 tokensPath 的 service。 */
export interface RosterEntry {
  service: string
  roster: RosterMember[]
}

export type RostersResponse = RosterEntry[]

/* ────────────────────────────── GET /api/token-grants ────────────────────────────── */

export interface TokenGrantDetail {
  issued_at: string
  last_ts: string | null
  n: number
}

export interface TokenPerson {
  id: string
  display_name: string
  /** key 為 serviceId。 */
  grants: Record<string, TokenGrantDetail>
}

export interface TokenGrantsResponse {
  services: { id: string; name: string }[]
  /** 依 id 字典序排序。 */
  people: TokenPerson[]
}

/**
 * token-grants 端點允許的 service 值（server.ts 驗證清單）。
 * 傳其他值後端會回 400 `*_ERR_ARGS: services 只能是 ...`。
 */
export type TokenService =
  | 'admin-dev'
  | 'admin-pre'
  | 'admin-evi'
  | 'platform'
  | 'platform-6t'
  | 'platform-pre-pk'
  | 'platform-pre-6t'
  | 'platform-evi-6t'
  | 'toolsmith'

/* ────────────────────────────── logs ────────────────────────────── */

export interface RegisteredLog {
  service: string
  label: string
  path: string
  exists: boolean
  size: number
}

export interface PipelineLog {
  service: 'dispatcher'
  label: string
  path: string
  exists: true
  size: number
  mtime: string
}

export interface LogsResponse {
  registered: RegisteredLog[]
  /** 只收 DISPATCHER_LOG_DIR 下檔名符合 /^[A-Z]+-\d+\./ 且以 .log 結尾者，依 mtime DESC。 */
  pipelineLogs: PipelineLog[]
}

/** 檔案不存在時回 200 `{ text: '', size: 0, missing: true }`（非 404）。 */
export interface LogTailResponse {
  text: string
  size: number
  missing?: boolean
}

/** 檔案不存在時回 200 `{ text: '', offset: 0, missing: true }`（非 404）。 */
export interface LogSinceResponse {
  text: string
  offset: number
  missing?: boolean
}
