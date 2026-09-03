// lib/read/types.ts — 讀取面共用列型別。
//
// 這些型別是「兩個資料源都必須交出同一個形狀」的契約：
//   - sqlite 來源（lib/read/sqlite.ts）＝ tg-monitor 自己的 data/monitor.sqlite，
//     欄位就是 lib/db.ts 建的那幾張表。
//   - mysql 來源（lib/read/mysql.ts）＝ 監控 DB（pipeline_monitor），欄位名不同，
//     由該檔負責在 SQL 內改名/組裝成下面這些形狀。
//
// **所有形狀以 sqlite 為準**（＝ migration/00-api-inventory.md 的驗收基準）。
// mysql 側缺欄一律回 null（形狀合格、值降級），不得改變 key 的存在與否——
// server.ts 的回應組裝邏輯是單一份，兩個來源共用，形狀因此結構上不會分岔。
//
// 例外（plan-db-as-truth-v3.md §8.1 明文允許）：`host` / `run_id` 兩個**可選**
// 欄位可以在 mysql 模式下額外出現在 pipeline run 列上（sqlite 模式永遠沒有）。

/** `/api/events` 的一列（＝ sqlite events 表的公開欄位，見 lib/db.ts:94-108）。 */
export interface EventRow {
  id: number
  service: string
  ts: string
  event: string
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

/** `/api/sessions` 逐列掃描用的精簡列（server.ts 的 session 串接只用到這幾欄）。 */
export interface SessionEventRow {
  id: number
  service: string
  ts: string
  identity: string | null
  tool: string | null
  path: string | null
  result: string | null
  source_ip: string | null
  agrabah_identifier: string | null
}

/** `/api/status-log` 的一列（＝ sqlite status_log 表全欄）。 */
export interface StatusLogRow {
  id: number
  service: string
  ts: string
  status: string
  pid: number | null
  detail: string | null
}

/** 總覽卡片的「近 N 分鐘活躍使用者」。 */
export interface ActiveUserRow {
  identity: string
  n: number
  last_ts: string
  first_ts: string
  last_tool: string | null
  source_ip: string | null
}

/** 總覽卡片的「最後一筆事件」。 */
export interface LastEventRow {
  ts: string
  identity: string | null
  tool: string | null
  path: string | null
  result: string | null
}

/** 總覽卡片的「最後一次服務狀態翻轉」（注意：只有 ts / status 兩欄，見 server.ts 的 lastStatusChangeStmt）。 */
export interface LastStatusChangeRow {
  ts: string
  status: string
}

/** 一個服務的總覽稽核統計（只有 auditLog 的服務才會被查）。 */
export interface ServiceAuditStats {
  activeUsers: ActiveUserRow[]
  req1h: number
  req24h: number
  err24h: number
  lastEvent: LastEventRow | null
}

/** `/api/pipelines`、`/api/pipelines/run` 的一列（＝ sqlite pipeline_runs 表全欄）。 */
export interface PipelineRunRow {
  key: string
  kind: string
  ticket: string
  started_at: string
  stdout_path: string | null
  stderr_path: string | null
  finished_at: string | null
  outcome: string | null
  cancelled_at: string | null
  triggered_by: string | null
  review_rounds: number | null
  final_review_rounds: number | null
  /** §8.1 可選欄位：只有 mysql 來源會帶。 */
  host?: string
  /** §8.1 可選欄位：只有 mysql 來源會帶。 */
  run_id?: string
  /** attachAgentRuns() 事後掛上，不由 reader 產生。 */
  agents?: AgentRunRow[]
  agent_count?: number
  total_input?: number
  total_output?: number
  total_cost?: number
  [k: string]: unknown
}

/** agent_runs 的一列（＝ sqlite agent_runs 表全欄）。 */
export interface AgentRunRow {
  path: string
  ticket: string
  kind: string
  stage: string | null
  started_at: string
  ended_at: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_create_tokens: number | null
  cost_usd: number | null
  num_turns: number | null
  tool_calls: number | null
  is_error: number
  result_preview: string | null
  file_mtime: string | null
  /** §8.1 可選欄位：只有 mysql 來源會帶（agent_runs 在 DB 側本來就以 run_id 為 PK 的一半）。 */
  run_id?: string
  host?: string
  [k: string]: unknown
}

/** `/api/events` 的篩選條件（原樣搬自 server.ts 既有的 query 解析）。 */
export interface EventsFilter {
  service?: string
  identity?: string
  from?: string
  to?: string
  event?: string
  errorsOnly: boolean
  toolOnly: boolean
  q?: string
  beforeId?: number
  /**
   * 游標的 `ts` 分量（a7-D46）。**只有 mysql 軌使用**，配合 `beforeId` 做
   * row-value 比較 `(ts, id) < (beforeTs, beforeId)`；sqlite 軌刻意忽略它，
   * 沿用既有的 `id < ?`，好讓 `lib/read/sqlite.ts` 的 SQL 逐位元不變
   * （那是 `MON_READ_SOURCE=sqlite` 這唯一回滾槓桿的可信度來源）。
   */
  beforeTs?: string
  limit: number
}

/** `/api/sessions` 的篩選條件。 */
export interface SessionsFilter {
  since: string
  service?: string
  identity?: string
}

/** `/api/stats` 的完整回傳（形狀＝ server.ts 既有 c.json 的六個欄位）。 */
export interface StatsResult {
  perDay: { day: string; service: string; n: number }[]
  perHour: { hour: string; n: number }[]
  topIdentities: { identity: string; service: string; n: number; last_ts: string }[]
  topTools: { tool: string; service: string; n: number; errors: number; avg_ms: number | null }[]
  authFailures: { service: string; source_ip: string | null; reason: string | null; n: number; last_ts: string }[]
  totalEvents: number
}

/**
 * 讀取面唯一的介面。sqlite 與 mysql 兩個實作都只做「資料存取」，
 * **回應組裝一律留在 server.ts**（單一來源 ⇒ 形狀結構上不可能分岔）。
 *
 * 全部非同步：sqlite 實作其實是同步的，包成 Promise 只為了讓呼叫端一份就好。
 */
export interface MonitorReader {
  readonly source: 'sqlite' | 'mysql'
  /** 逐服務的稽核統計；只會傳入有 auditLog 的服務 id。回傳 Map，缺席的 id 由呼叫端補預設值。 */
  serviceAuditStats(
    serviceIds: string[],
    windows: { activeSince: string; hourAgo: string; dayAgo: string },
  ): Promise<Map<string, ServiceAuditStats>>
  /** 逐服務的最後一次狀態翻轉；對**所有**服務（含無 auditLog 者）查。 */
  lastStatusChanges(serviceIds: string[]): Promise<Map<string, LastStatusChangeRow>>
  queryEvents(f: EventsFilter): Promise<EventRow[]>
  sessionEvents(f: SessionsFilter): Promise<SessionEventRow[]>
  stats(since: string, hourWindowSince: string): Promise<StatsResult>
  statusLog(service?: string): Promise<StatusLogRow[]>
  pipelineRuns(limit: number): Promise<PipelineRunRow[]>
  pipelineRunByKey(key: string): Promise<PipelineRunRow | null>
  pipelineRunsByTicket(kind: string, ticket: string): Promise<PipelineRunRow[]>
  allAgentRuns(): Promise<AgentRunRow[]>
  /** 這張票最近一筆 bug run 的 key（/api/pipelines/retry 用來找 triggered-by sidecar）。 */
  latestBugRunKey(ticket: string): Promise<string | null>
  /** 以 (identity, service) 為鍵的請求用量彙總（/api/token-grants 的「最後使用/累計請求」）。 */
  identityUsage(): Promise<IdentityUsageRow[]>
}

/** `/api/token-grants` 的用量彙總列。 */
export interface IdentityUsageRow {
  identity: string
  service: string
  last_ts: string
  n: number
}

/**
 * deprecated 的 `before_id` 在 mysql 軌對不到 `mcp_usage` 的任何一列。
 *
 * **為什麼要有這個錯誤而不是回空頁**：回空頁會讓 `next_cursor` 是 null，
 * 前端據此顯示「已到底」——**一個還有資料的列表被安靜地宣告結束**，
 * 而那種失敗沒有人會發現。呼叫端（server.ts）據此回 400。
 *
 * sqlite 軌**不會**丟這個錯：那一軌的 `before_id` 是原生的 `id < ?`，
 * 對不到的 id 只是回較舊的列，語意明確且無害；改成 400 會製造一個新的失敗，
 * 也會破壞「sqlite 軌逐位元不變」。
 */
export class UnresolvableBeforeIdError extends Error {
  constructor(public readonly beforeId: number) {
    super(`before_id=${beforeId} 在 mcp_usage 找不到對應列（游標無法解析）`)
    this.name = 'UnresolvableBeforeIdError'
  }
}
