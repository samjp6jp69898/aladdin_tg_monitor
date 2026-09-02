// lib/read/mysql.ts — 監控 DB（pipeline_monitor）讀取面（MON_READ_SOURCE=mysql 時走這裡）。
//
// 規格來源：plan-db-as-truth-v3.md §8.1（讀取面切換）、§2.2（mon_ui 只 SELECT 九張表）、
// §11.1（表清單）、migration/00-api-inventory.md（回應形狀的驗收基準）。
//
// ## 本檔的三條紀律
// 1. **只讀，不寫。** mon_ui 對 `runs` 的欄位級 UPDATE 是 cancel 路徑的事，
//    在 lib/mon-db.ts；本檔的每一條 SQL 都是 SELECT。
// 2. **不自建 pool。** 一律用 lib/mon-db.ts 的 getMonitorPool()——【G:MN-G7】
//    「全案唯一的 createPool 呼叫點」對 tg-monitor 這一側同樣成立（§4.6 pool 歸屬表：
//    tg-monitor / mon_ui / connectionLimit 4 / 讀取面九張＋runs cancel 欄位）。
// 3. **形狀以 sqlite 為準。** 欄位改名一律在 SQL 內做完（`AS`），缺欄回 NULL，
//    呼叫端（server.ts）拿到的物件與 sqlite 模式同形。
//
// ## 已知的資料面缺口（回報指揮官，待 migration 004 additive 補；本檔先回 null）
// `runs` 表沒有 `stderr_path` / `review_rounds` / `final_review_rounds` 三欄——
// migration 003 只對齊了 `agent_runs` 的 payload 欄，`runs` 這三欄沒有被一起補
// （回填腳本 backfill-sqlite.ts:464 讀了 stderr_path 但無處可寫，可佐證）。
// 形狀仍然合格（key 在、值為 null），rounds 在前端本來就是「0/無值即隱藏」的
// graceful degrade（server.ts 的 reviewRounds 計算式），但**資料保真度確實下降**。
//
// ## 為什麼 events 要在 SQL 裡解 JSON
// sqlite 的 `events` 表是「解析過的欄位」（lib/db.ts insertAuditLine 把 raw JSON
// 拆成 event/method/path/tool/... 十來欄）；監控 DB 的 `mcp_usage` 只存
// `service / identity / source_ip / raw / ts`（§11.1），其餘欄位在 raw 裡。
// 篩選（/api/events 的 LIKE）與彙總（/api/stats 的 GROUP BY tool）都必須在 SQL
// 端做，不能整表撈回 JS，所以用 MySQL 的 JSON 函式即時解。每個取值都包在
// `IF(JSON_VALID(raw), ...)` 內：raw 若不是合法 JSON（理論上不會，寫入端與
// insertAuditLine 同樣先 JSON.parse 才寫），回 NULL 而不是讓整個端點 500。

import type { Pool, RowDataPacket } from 'mysql2/promise'
import { getMonitorPool, isoToMysqlDatetime3 } from '../mon-db.ts'
import type {
  AgentRunRow,
  EventRow,
  EventsFilter,
  IdentityUsageRow,
  LastStatusChangeRow,
  MonitorReader,
  PipelineRunRow,
  ServiceAuditStats,
  SessionEventRow,
  SessionsFilter,
  StatsResult,
  StatusLogRow,
} from './types.ts'

// ─────────────────────────────────────────────────────────────────────────
// SQL 片段產生器
//
// iso / jstr / jnum / RUNS_SELECT / AGENT_RUNS_SELECT 之所以 export，只有一個
// 理由：**給 mysql-sql.test.ts 直接斷言**（用字串比對測 SQL 片段，比對整支
// 檔案做 regex 可靠得多）。本檔以外沒有任何 production 呼叫端。
// ─────────────────────────────────────────────────────────────────────────

/**
 * DATETIME(3) → 與 sqlite 完全同形的 UTC ISO 字串（毫秒三位 + 'Z'）。
 *
 * 不能直接用 `DATE_FORMAT(x,'%Y-%m-%dT%H:%i:%s.%fZ')`——`%f` 是**六位**微秒，
 * 會產生 `.751000Z`，與 sqlite 存的 `.751Z` 不同形（前端與 /api/stats 的
 * `substr(ts,1,13)` 同型比較都吃這個字串）。NULL 進 NULL 出（CONCAT 遇 NULL 回 NULL）。
 */
export function iso(col: string): string {
  return `CONCAT(DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(${col}) / 1000), 3, '0'), 'Z')`
}

/** raw JSON 的字串欄位；缺 key、JSON null、raw 非合法 JSON 一律回 SQL NULL。 */
export function jstr(alias: string, key: string): string {
  const raw = `${alias}.\`raw\``
  const ex = `JSON_EXTRACT(${raw}, '$.${key}')`
  // 巢狀 IF：MySQL 的 AND 不保證短路，用 IF 才能確定 raw 非法時完全不去碰 JSON_EXTRACT。
  return `IF(JSON_VALID(${raw}), IF(JSON_TYPE(${ex}) IS NULL OR JSON_TYPE(${ex}) = 'NULL', NULL, JSON_UNQUOTE(${ex})), NULL)`
}

/**
 * raw JSON 的數值欄位。對齊 insertAuditLine 的
 * `typeof j.durationMs === 'number' ? j.durationMs : null`——**只有真的是 JSON 數字
 * 才取值**，字串 "123" 一律回 NULL（sqlite 那側也是 null）。
 */
export function jnum(alias: string, key: string): string {
  const raw = `${alias}.\`raw\``
  const ex = `JSON_EXTRACT(${raw}, '$.${key}')`
  return `IF(JSON_VALID(${raw}), IF(JSON_TYPE(${ex}) IN ('INTEGER', 'DOUBLE', 'DECIMAL'), CAST(JSON_UNQUOTE(${ex}) AS SIGNED), NULL), NULL)`
}

/** JSON 欄位（detail_json，型別就是 JSON，不需要 JSON_VALID 保護）的字串取值。 */
function djstr(col: string, key: string): string {
  const ex = `JSON_EXTRACT(${col}, '$.${key}')`
  return `IF(JSON_TYPE(${ex}) IS NULL OR JSON_TYPE(${ex}) = 'NULL', NULL, JSON_UNQUOTE(${ex}))`
}

/** JSON 欄位的整數取值。 */
function djnum(col: string, key: string): string {
  const ex = `JSON_EXTRACT(${col}, '$.${key}')`
  return `IF(JSON_TYPE(${ex}) IN ('INTEGER', 'DOUBLE', 'DECIMAL'), CAST(JSON_UNQUOTE(${ex}) AS SIGNED), NULL)`
}

/** `event` 欄位：對齊 insertAuditLine 的 `String(j.event ?? 'request')`。 */
function eventExpr(alias: string): string {
  return `COALESCE(${jstr(alias, 'event')}, 'request')`
}

/**
 * 使用者輸入的時間參數 → MySQL DATETIME 可比較的字串。
 *
 * sqlite 那側 `ts >= ?` 是**字串比較**、對輸入沒有任何驗證；這裡不能因為使用者
 * 打錯字就 throw（sqlite 模式只會查不到東西，mysql 模式不該變成 500）。
 * 合法 UTC ISO → 轉成 `YYYY-MM-DD HH:MM:SS.mmm`；其他一律原樣交給 MySQL
 * （`'2026-09-01'` 這種日期前綴 MySQL 自己會當午夜處理，與 sqlite 的字串前綴
 * 比較同效）。
 */
export function toDatetimeParam(v: string): string {
  try {
    return isoToMysqlDatetime3(v)
  } catch {
    return v
  }
}

/** COUNT/SUM 這類 MySQL 會回 DECIMAL 字串的欄位 → JS number。 */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

/** 可為 null 的數值欄位（cost_usd / avg_ms / duration_ms …）。 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  return typeof v === 'number' ? v : Number(v)
}

/**
 * LIMIT 一律以驗證過的整數字面值拼進 SQL，不走 placeholder（避開 mysql2 prepared
 * LIMIT 的版本相依行為）。
 *
 * **不在這裡做業務上的上限裁切**：`/api/events` 的 `Math.min(limit, 1000)` 是
 * server.ts 的既有行為，sqlite reader 也是原樣把 limit 交給 SQL——reader 這一層
 * 兩邊都必須照收，否則同一個呼叫在兩軌會拿到不同筆數（對照腳本就會誤判成資料差異）。
 * 這裡的上界純粹是防呆（NaN / 負數 / 天文數字）。
 */
const LIMIT_HARD_CAP = 1_000_000
function limitLiteral(n: number): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v <= 0) return 1
  return Math.min(v, LIMIT_HARD_CAP)
}

/** `IN (?, ?, …)` 的佔位字串；空陣列由呼叫端提前短路，不會走到這裡。 */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

// ─────────────────────────────────────────────────────────────────────────
// runs / agent_runs 的欄位對映（sqlite pipeline_runs / agent_runs 形狀）
// ─────────────────────────────────────────────────────────────────────────

// `key`：新管線寫入時就帶 legacy_key（telegram-dispatcher/lib/monitor-db/writes.ts:70），
// 回填列也是（backfill-sqlite.ts:253 `legacy_key: r.key`）。萬一為 NULL 就退回
// run_id，讓 /api/pipelines/run?key= 仍然點得開（不會出現「列表看得到、點進去 404」）。
export const RUNS_SELECT = `
  SELECT COALESCE(r.legacy_key, r.run_id)                      AS \`key\`,
         r.kind                                                AS kind,
         r.ticket                                              AS ticket,
         ${iso('r.started_at')}                                AS started_at,
         r.stdout_path                                         AS stdout_path,
         NULL                                                  AS stderr_path,
         ${iso('r.finished_at')}                               AS finished_at,
         r.outcome                                             AS outcome,
         ${iso('r.cancel_requested_at')}                       AS cancelled_at,
         COALESCE(r.triggered_by_name, r.triggered_by_email)   AS triggered_by,
         NULL                                                  AS review_rounds,
         NULL                                                  AS final_review_rounds,
         r.host                                                AS host,
         r.run_id                                              AS run_id
  FROM runs r`

// queued 列（lifecycle_rank=10）不進列表：sqlite 那側的 pipeline_runs 本來就只有
// 已 spawn 的 run，排隊中的單由 readQueuedTickets() 從佇列快照另外供給
// （server.ts 的 `queued` 欄），兩邊都算會重複計數。
const RUNS_LIST_WHERE = `r.lifecycle_rank >= 30 AND r.started_at IS NOT NULL`

// agent_runs：ticket / kind 不反正規化，走 run_id → runs 的 join 取得
// （migration-003-proposal.md §2「刻意不搬的欄位」已裁定）。
// stage ← agent_name（001 建表時就是這一欄，回填 backfill-sqlite.ts:300
// `agent_name: agent.stage` 可佐證）。file_mtime 是 collector 的私有再解析游標，
// 不進權威表（同提案），一律回 NULL。
export const AGENT_RUNS_SELECT = `
  SELECT a.path                          AS path,
         r.ticket                        AS ticket,
         r.kind                          AS kind,
         a.agent_name                    AS stage,
         ${iso('a.started_at')}          AS started_at,
         ${iso('a.finished_at')}         AS ended_at,
         a.model                         AS model,
         a.input_tokens                  AS input_tokens,
         a.output_tokens                 AS output_tokens,
         a.cache_read_tokens             AS cache_read_tokens,
         a.cache_create_tokens           AS cache_create_tokens,
         a.cost_usd                      AS cost_usd,
         a.num_turns                     AS num_turns,
         a.tool_calls                    AS tool_calls,
         COALESCE(a.is_error, 0)         AS is_error,
         a.result_preview                AS result_preview,
         NULL                            AS file_mtime,
         a.run_id                        AS run_id,
         a.host                          AS host
  FROM agent_runs a
  JOIN runs r ON r.run_id = a.run_id`

function toPipelineRunRow(r: any): PipelineRunRow {
  return {
    key: r.key,
    kind: r.kind,
    ticket: r.ticket,
    started_at: r.started_at,
    stdout_path: r.stdout_path ?? null,
    stderr_path: null,
    finished_at: r.finished_at ?? null,
    outcome: r.outcome ?? null,
    cancelled_at: r.cancelled_at ?? null,
    triggered_by: r.triggered_by ?? null,
    review_rounds: null,
    final_review_rounds: null,
    host: r.host,
    run_id: r.run_id,
  }
}

function toAgentRunRow(a: any): AgentRunRow {
  return {
    path: a.path,
    ticket: a.ticket,
    kind: a.kind,
    stage: a.stage ?? null,
    started_at: a.started_at,
    ended_at: a.ended_at ?? null,
    model: a.model ?? null,
    input_tokens: numOrNull(a.input_tokens),
    output_tokens: numOrNull(a.output_tokens),
    cache_read_tokens: numOrNull(a.cache_read_tokens),
    cache_create_tokens: numOrNull(a.cache_create_tokens),
    // DECIMAL(12,6) 經 mysql2 回來是字串，不轉會讓 total_cost 變成字串相加。
    cost_usd: numOrNull(a.cost_usd),
    num_turns: numOrNull(a.num_turns),
    tool_calls: numOrNull(a.tool_calls),
    is_error: num(a.is_error),
    result_preview: a.result_preview ?? null,
    file_mtime: null,
    run_id: a.run_id,
    host: a.host,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Reader 實作
// ─────────────────────────────────────────────────────────────────────────

// tg-monitor 的 pool 是 connectionLimit 4 且 **waitForConnections: false**
// （§4.6 pool 歸屬表 + lib/mon-db.ts）——pool 借完就直接丟錯，不排隊。讀取面
// 一旦有多個 SSE 連線同時到期輪詢，很容易把 4 條借光，連 cancel 旗標那條寫入
// 都借不到。所以讀取面自己把查詢串成一條 FIFO 鏈（同時最多一條在飛），
// 結構上保證讀取面最多只佔用 1 條連線、剩下 3 條永遠留給 cancel。
//
// 這不是「用等待解決正確性問題」：查詢彼此之間沒有順序依賴，串起來純粹是
// 連線資源的背壓；正確性由「最多 1 條」這個結構性上限保證，不由時間保證。
let readChain: Promise<unknown> = Promise.resolve()

async function q<T = RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
  // 前一條查詢失敗不該讓後面所有查詢跟著失敗——鏈只用來排序，不傳遞錯誤。
  const run = readChain.catch(() => undefined).then(async () => {
    const pool: Pool = getMonitorPool()
    const [rows] = await pool.execute(sql, params)
    return rows as T
  })
  readChain = run.catch(() => undefined)
  return run
}

/** 啟動時的連線探針（index.ts 用）：走同一條鏈、同一個 pool。 */
export async function probeMysqlReadable(): Promise<void> {
  await q('SELECT 1 AS ok')
}

export const mysqlReader: MonitorReader = {
  source: 'mysql',

  async serviceAuditStats(serviceIds, windows) {
    const out = new Map<string, ServiceAuditStats>()
    if (serviceIds.length === 0) return out
    const ph = placeholders(serviceIds.length)
    const activeSince = toDatetimeParam(windows.activeSince)
    const hourAgo = toDatetimeParam(windows.hourAgo)
    const dayAgo = toDatetimeParam(windows.dayAgo)

    // (1) 活躍使用者。last_tool / source_ip 的相關子查詢**刻意不帶 ts 下限**——
    // sqlite 原式（server.ts 的 activeUsersStmt）的 e2/e3 子查詢也沒有，
    // 語意是「這個人在這個服務上最後一次用的 tool / 來源 IP」，不限於視窗內。
    const activeRows = await q<any[]>(
      `SELECT e.service AS service,
              e.identity AS identity,
              CAST(COUNT(*) AS SIGNED) AS n,
              ${iso('MAX(e.ts)')} AS last_ts,
              ${iso('MIN(e.ts)')} AS first_ts,
              (SELECT ${jstr('e2', 'tool')} FROM mcp_usage e2
                WHERE e2.service = e.service AND e2.identity = e.identity
                  AND ${jstr('e2', 'tool')} IS NOT NULL
                ORDER BY e2.ts DESC, e2.id DESC LIMIT 1) AS last_tool,
              (SELECT e3.source_ip FROM mcp_usage e3
                WHERE e3.service = e.service AND e3.identity = e.identity
                ORDER BY e3.ts DESC, e3.id DESC LIMIT 1) AS source_ip
         FROM mcp_usage e
        WHERE e.service IN (${ph}) AND e.ts >= ? AND e.identity IS NOT NULL
        GROUP BY e.service, e.identity
        ORDER BY e.service, last_ts DESC`,
      [...serviceIds, activeSince],
    )

    // (2) 三個計數一次查完（req1h ⊂ req24h，所以只掃 dayAgo 之後）。
    const countRows = await q<any[]>(
      `SELECT e.service AS service,
              CAST(SUM(CASE WHEN e.ts >= ? THEN 1 ELSE 0 END) AS SIGNED) AS req1h,
              CAST(COUNT(*) AS SIGNED) AS req24h,
              CAST(SUM(CASE WHEN ${eventExpr('e')} = 'auth_failure'
                              OR ${jstr('e', 'result')} LIKE 'error:%'
                            THEN 1 ELSE 0 END) AS SIGNED) AS err24h
         FROM mcp_usage e
        WHERE e.service IN (${ph}) AND e.ts >= ?
        GROUP BY e.service`,
      [hourAgo, ...serviceIds, dayAgo],
    )

    // (3) 每個服務的最後一筆事件（PARTITION BY + ROW_NUMBER 一次拿完）。
    const lastRows = await q<any[]>(
      `SELECT service, ts, identity, tool, path, result FROM (
         SELECT e.service AS service,
                ${iso('e.ts')} AS ts,
                e.identity AS identity,
                ${jstr('e', 'tool')} AS tool,
                ${jstr('e', 'path')} AS path,
                ${jstr('e', 'result')} AS result,
                ROW_NUMBER() OVER (PARTITION BY e.service ORDER BY e.ts DESC, e.id DESC) AS rn
           FROM mcp_usage e
          WHERE e.service IN (${ph})
       ) t WHERE t.rn = 1`,
      [...serviceIds],
    )

    for (const id of serviceIds) {
      out.set(id, { activeUsers: [], req1h: 0, req24h: 0, err24h: 0, lastEvent: null })
    }
    for (const r of activeRows) {
      out.get(r.service)?.activeUsers.push({
        identity: r.identity,
        n: num(r.n),
        last_ts: r.last_ts,
        first_ts: r.first_ts,
        last_tool: r.last_tool ?? null,
        source_ip: r.source_ip ?? null,
      })
    }
    for (const r of countRows) {
      const s = out.get(r.service)
      if (!s) continue
      s.req1h = num(r.req1h)
      s.req24h = num(r.req24h)
      s.err24h = num(r.err24h)
    }
    for (const r of lastRows) {
      const s = out.get(r.service)
      if (!s) continue
      s.lastEvent = { ts: r.ts, identity: r.identity ?? null, tool: r.tool ?? null, path: r.path ?? null, result: r.result ?? null }
    }
    return out
  },

  async lastStatusChanges(serviceIds) {
    const out = new Map<string, LastStatusChangeRow>()
    if (serviceIds.length === 0) return out
    const rows = await q<any[]>(
      `SELECT service, ts, status FROM (
         SELECT s.service AS service, ${iso('s.ts')} AS ts, s.status AS status,
                ROW_NUMBER() OVER (PARTITION BY s.service ORDER BY s.id DESC) AS rn
           FROM service_status_log s
          WHERE s.service IN (${placeholders(serviceIds.length)})
       ) t WHERE t.rn = 1`,
      [...serviceIds],
    )
    for (const r of rows) out.set(r.service, { ts: r.ts, status: r.status })
    return out
  },

  async queryEvents(f: EventsFilter) {
    const where: string[] = []
    const params: unknown[] = []
    // 等值比較一律加 COLLATE utf8mb4_bin：schema 的 utf8mb4_0900_ai_ci 是
    // 大小寫/重音不敏感，而 sqlite 的 `=` 是逐位元組比較。使用者輸入走這條路，
    // 不釘死 collation 兩個模式的篩選結果會不一樣。
    if (f.service) { where.push('e.service = ? COLLATE utf8mb4_bin'); params.push(f.service) }
    if (f.identity) { where.push('e.identity = ? COLLATE utf8mb4_bin'); params.push(f.identity) }
    if (f.from) { where.push('e.ts >= ?'); params.push(toDatetimeParam(f.from)) }
    if (f.to) { where.push('e.ts <= ?'); params.push(toDatetimeParam(f.to)) }
    if (f.event) { where.push(`${eventExpr('e')} = ? COLLATE utf8mb4_bin`); params.push(f.event) }
    if (f.errorsOnly) where.push(`(${eventExpr('e')} = 'auth_failure' OR ${jstr('e', 'result')} LIKE 'error:%')`)
    if (f.toolOnly) where.push(`${jstr('e', 'tool')} IS NOT NULL`)
    if (f.q) {
      where.push(
        `(${jstr('e', 'tool')} LIKE ? OR ${jstr('e', 'path')} LIKE ? OR ${jstr('e', 'result')} LIKE ?` +
          ` OR e.source_ip LIKE ? OR ${jstr('e', 'agrabahIdentifier')} LIKE ?)`,
      )
      const like = `%${f.q}%`
      params.push(like, like, like, like, like)
    }
    if (f.beforeId !== undefined) { where.push('e.id < ?'); params.push(f.beforeId) }
    const rows = await q<any[]>(
      `SELECT e.id AS id, e.service AS service, ${iso('e.ts')} AS ts,
              ${eventExpr('e')} AS event, e.identity AS identity, e.source_ip AS source_ip,
              ${jstr('e', 'method')} AS method, ${jstr('e', 'path')} AS path,
              ${jstr('e', 'tool')} AS tool, ${jstr('e', 'result')} AS result,
              ${jstr('e', 'agrabahIdentifier')} AS agrabah_identifier,
              ${jnum('e', 'durationMs')} AS duration_ms, ${jstr('e', 'reason')} AS reason
         FROM mcp_usage e
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY e.id DESC LIMIT ${limitLiteral(f.limit)}`,
      params,
    )
    return rows.map(r => ({
      id: num(r.id),
      service: r.service,
      ts: r.ts,
      event: r.event,
      identity: r.identity ?? null,
      source_ip: r.source_ip ?? null,
      method: r.method ?? null,
      path: r.path ?? null,
      tool: r.tool ?? null,
      result: r.result ?? null,
      agrabah_identifier: r.agrabah_identifier ?? null,
      duration_ms: numOrNull(r.duration_ms),
      reason: r.reason ?? null,
    })) as EventRow[]
  },

  async sessionEvents(f: SessionsFilter) {
    const where = ['e.ts >= ?', 'e.identity IS NOT NULL']
    const params: unknown[] = [toDatetimeParam(f.since)]
    if (f.service) { where.push('e.service = ? COLLATE utf8mb4_bin'); params.push(f.service) }
    if (f.identity) { where.push('e.identity = ? COLLATE utf8mb4_bin'); params.push(f.identity) }
    // ORDER BY 也釘 utf8mb4_bin：session 串接靠「同 (service, identity) 的列相鄰」，
    // ai_ci 之下 'Foo' 與 'foo' 排序上相等會交錯，JS 端的 !== 比較就會把一段
    // session 切成很多段。
    const rows = await q<any[]>(
      `SELECT e.id AS id, e.service AS service, ${iso('e.ts')} AS ts, e.identity AS identity,
              ${jstr('e', 'tool')} AS tool, ${jstr('e', 'path')} AS path,
              ${jstr('e', 'result')} AS result, e.source_ip AS source_ip,
              ${jstr('e', 'agrabahIdentifier')} AS agrabah_identifier
         FROM mcp_usage e
        WHERE ${where.join(' AND ')}
        ORDER BY e.service COLLATE utf8mb4_bin, e.identity COLLATE utf8mb4_bin, e.ts`,
      params,
    )
    return rows.map(r => ({
      id: num(r.id),
      service: r.service,
      ts: r.ts,
      identity: r.identity ?? null,
      tool: r.tool ?? null,
      path: r.path ?? null,
      result: r.result ?? null,
      source_ip: r.source_ip ?? null,
      agrabah_identifier: r.agrabah_identifier ?? null,
    })) as SessionEventRow[]
  },

  async stats(since: string, hourWindowSince: string): Promise<StatsResult> {
    const s = toDatetimeParam(since)
    const h = toDatetimeParam(hourWindowSince)

    // substr(ts,1,10) / substr(ts,1,13)（sqlite 對 ISO 字串切前綴）＝
    // MySQL 的 DATE_FORMAT 到「日」與到「T時」。
    const perDay = (await q<any[]>(
      `SELECT DATE_FORMAT(e.ts, '%Y-%m-%d') AS day, e.service AS service, CAST(COUNT(*) AS SIGNED) AS n
         FROM mcp_usage e WHERE e.ts >= ? GROUP BY day, e.service ORDER BY day`,
      [s],
    )).map(r => ({ day: r.day, service: r.service, n: num(r.n) }))

    const perHour = (await q<any[]>(
      `SELECT DATE_FORMAT(e.ts, '%Y-%m-%dT%H') AS hour, CAST(COUNT(*) AS SIGNED) AS n
         FROM mcp_usage e WHERE e.ts >= ? GROUP BY hour ORDER BY hour`,
      [h],
    )).map(r => ({ hour: r.hour, n: num(r.n) }))

    const topIdentities = (await q<any[]>(
      `SELECT e.identity AS identity, e.service AS service, CAST(COUNT(*) AS SIGNED) AS n,
              ${iso('MAX(e.ts)')} AS last_ts
         FROM mcp_usage e WHERE e.ts >= ? AND e.identity IS NOT NULL
        GROUP BY e.identity, e.service ORDER BY last_ts DESC LIMIT 50`,
      [s],
    )).map(r => ({ identity: r.identity, service: r.service, n: num(r.n), last_ts: r.last_ts }))

    const topTools = (await q<any[]>(
      `SELECT ${jstr('e', 'tool')} AS tool, e.service AS service, CAST(COUNT(*) AS SIGNED) AS n,
              CAST(SUM(CASE WHEN ${jstr('e', 'result')} LIKE 'error:%' THEN 1 ELSE 0 END) AS SIGNED) AS errors,
              ROUND(AVG(${jnum('e', 'durationMs')})) AS avg_ms
         FROM mcp_usage e WHERE e.ts >= ? AND ${jstr('e', 'tool')} IS NOT NULL
        GROUP BY tool, e.service ORDER BY n DESC LIMIT 50`,
      [s],
    )).map(r => ({ tool: r.tool, service: r.service, n: num(r.n), errors: num(r.errors), avg_ms: numOrNull(r.avg_ms) }))

    const authFailures = (await q<any[]>(
      `SELECT e.service AS service, e.source_ip AS source_ip, ${jstr('e', 'reason')} AS reason,
              CAST(COUNT(*) AS SIGNED) AS n, ${iso('MAX(e.ts)')} AS last_ts
         FROM mcp_usage e WHERE e.ts >= ? AND ${eventExpr('e')} = 'auth_failure'
        GROUP BY e.service, e.source_ip, reason ORDER BY n DESC LIMIT 50`,
      [s],
    )).map(r => ({ service: r.service, source_ip: r.source_ip ?? null, reason: r.reason ?? null, n: num(r.n), last_ts: r.last_ts }))

    const total = await q<any[]>('SELECT CAST(COUNT(*) AS SIGNED) AS n FROM mcp_usage')
    return { perDay, perHour, topIdentities, topTools, authFailures, totalEvents: num(total[0]?.n) }
  },

  async statusLog(service?: string) {
    // pid / detail 在監控 DB 側收在 detail_json 裡（sqlite 是兩個獨立欄位）。
    // 這個約定必須與 Phase 4 的 status collector 寫入端一致：
    //     detail_json = {"pid": <int|null>, "detail": <string|null>}
    const rows = await q<any[]>(
      `SELECT s.id AS id, s.service AS service, ${iso('s.ts')} AS ts, s.status AS status,
              ${djnum('s.detail_json', 'pid')} AS pid,
              ${djstr('s.detail_json', 'detail')} AS detail
         FROM service_status_log s
        ${service ? 'WHERE s.service = ? COLLATE utf8mb4_bin' : ''}
        ORDER BY s.id DESC LIMIT 200`,
      service ? [service] : [],
    )
    return rows.map(r => ({
      id: num(r.id),
      service: r.service,
      ts: r.ts,
      status: r.status,
      pid: numOrNull(r.pid),
      detail: r.detail ?? null,
    })) as StatusLogRow[]
  },

  async pipelineRuns(limit: number) {
    const rows = await q<any[]>(
      `${RUNS_SELECT} WHERE ${RUNS_LIST_WHERE} ORDER BY r.started_at DESC LIMIT ${limitLiteral(limit)}`,
    )
    return rows.map(toPipelineRunRow)
  },

  async pipelineRunByKey(key: string) {
    const rows = await q<any[]>(
      `${RUNS_SELECT} WHERE (r.legacy_key = ? COLLATE utf8mb4_bin OR r.run_id = ? COLLATE utf8mb4_bin)
         ORDER BY r.started_at DESC LIMIT 1`,
      [key, key],
    )
    return rows.length ? toPipelineRunRow(rows[0]) : null
  },

  async pipelineRunsByTicket(kind: string, ticket: string) {
    const rows = await q<any[]>(
      `${RUNS_SELECT} WHERE r.kind = ? COLLATE utf8mb4_bin AND r.ticket = ? COLLATE utf8mb4_bin
         AND ${RUNS_LIST_WHERE}`,
      [kind, ticket],
    )
    return rows.map(toPipelineRunRow)
  },

  async allAgentRuns() {
    const rows = await q<any[]>(`${AGENT_RUNS_SELECT} ORDER BY a.started_at`)
    return rows.map(toAgentRunRow)
  },

  async latestBugRunKey(ticket: string) {
    const rows = await q<any[]>(
      `SELECT COALESCE(r.legacy_key, r.run_id) AS \`key\`
         FROM runs r
        WHERE r.kind = 'bug' AND r.ticket = ? COLLATE utf8mb4_bin AND r.started_at IS NOT NULL
        ORDER BY r.started_at DESC LIMIT 1`,
      [ticket],
    )
    return rows.length ? (rows[0].key as string) : null
  },

  async identityUsage() {
    const rows = await q<any[]>(
      `SELECT e.identity AS identity, e.service AS service, ${iso('MAX(e.ts)')} AS last_ts,
              CAST(COUNT(*) AS SIGNED) AS n
         FROM mcp_usage e
        WHERE e.identity IS NOT NULL AND ${eventExpr('e')} = 'request'
        GROUP BY e.identity, e.service`,
    )
    return rows.map(r => ({ identity: r.identity, service: r.service, last_ts: r.last_ts, n: num(r.n) })) as IdentityUsageRow[]
  },
}
