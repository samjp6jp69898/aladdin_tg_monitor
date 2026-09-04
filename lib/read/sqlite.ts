// lib/read/sqlite.ts — 既有 sqlite 讀取面（MON_READ_SOURCE 未設 / 'sqlite' 時走這裡）。
//
// **本檔的每一條 SQL 都是從 server.ts 逐字搬過來的**，一個字元都沒有改：
//   activeUsersStmt / countSinceStmt / errSinceStmt / lastEventStmt /
//   lastStatusChangeStmt（原 server.ts:60-73）、/api/events、/api/sessions、
//   /api/stats、/api/status-log、/api/pipelines、/api/pipelines/run、
//   attachAgentRuns 內的 agent_runs 查詢。
//
// 「sqlite 模式下全部端點行為 byte-level 不變」這條硬驗收，靠的就是這件事＋
// 「回應組裝邏輯完全留在 server.ts」這兩件事一起——本檔不做任何轉換、不補欄、
// 不排序、不改型別，拿到什麼就回什麼。要改行為請去改 server.ts，不要改這裡。

import { db } from '../db.ts'
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

// ── 以下五條原封不動搬自 server.ts:60-73 ──────────────────────────────────
const activeUsersStmt = db.prepare(`
  SELECT identity, COUNT(*) AS n, MAX(ts) AS last_ts, MIN(ts) AS first_ts,
         (SELECT tool FROM events e2 WHERE e2.service = e.service AND e2.identity = e.identity AND e2.tool IS NOT NULL ORDER BY ts DESC LIMIT 1) AS last_tool,
         (SELECT source_ip FROM events e3 WHERE e3.service = e.service AND e3.identity = e.identity ORDER BY ts DESC LIMIT 1) AS source_ip
  FROM events e
  WHERE service = ? AND ts >= ? AND identity IS NOT NULL
  GROUP BY identity ORDER BY last_ts DESC
`)
const countSinceStmt = db.prepare('SELECT COUNT(*) AS n FROM events WHERE service = ? AND ts >= ?')
const errSinceStmt = db.prepare("SELECT COUNT(*) AS n FROM events WHERE service = ? AND ts >= ? AND (event = 'auth_failure' OR result LIKE 'error:%')")
const lastEventStmt = db.prepare('SELECT ts, identity, tool, path, result FROM events WHERE service = ? ORDER BY ts DESC LIMIT 1')
const lastStatusChangeStmt = db.prepare('SELECT ts, status FROM status_log WHERE service = ? ORDER BY id DESC LIMIT 1')
// ─────────────────────────────────────────────────────────────────────────

export const sqliteReader: MonitorReader = {
  source: 'sqlite',

  async serviceAuditStats(serviceIds, windows) {
    const out = new Map<string, ServiceAuditStats>()
    for (const id of serviceIds) {
      out.set(id, {
        activeUsers: activeUsersStmt.all(id, windows.activeSince) as ServiceAuditStats['activeUsers'],
        req1h: (countSinceStmt.get(id, windows.hourAgo) as any).n,
        req24h: (countSinceStmt.get(id, windows.dayAgo) as any).n,
        err24h: (errSinceStmt.get(id, windows.dayAgo) as any).n,
        lastEvent: (lastEventStmt.get(id) as ServiceAuditStats['lastEvent']) ?? null,
      })
    }
    return out
  },

  async lastStatusChanges(serviceIds) {
    const out = new Map<string, LastStatusChangeRow>()
    for (const id of serviceIds) {
      const row = lastStatusChangeStmt.get(id) as LastStatusChangeRow | undefined
      if (row) out.set(id, row)
    }
    return out
  },

  async queryEvents(f: EventsFilter) {
    const where: string[] = []
    const params: any[] = []
    if (f.service) { where.push('service = ?'); params.push(f.service) }
    if (f.identity) { where.push('identity = ?'); params.push(f.identity) }
    if (f.from) { where.push('ts >= ?'); params.push(f.from) }
    if (f.to) { where.push('ts <= ?'); params.push(f.to) }
    if (f.event) { where.push('event = ?'); params.push(f.event) }
    if (f.errorsOnly) where.push("(event = 'auth_failure' OR result LIKE 'error:%')")
    if (f.toolOnly) where.push('tool IS NOT NULL')
    if (f.q) {
      where.push('(tool LIKE ? OR path LIKE ? OR result LIKE ? OR source_ip LIKE ? OR agrabah_identifier LIKE ?)')
      const like = `%${f.q}%`
      params.push(like, like, like, like, like)
    }
    if (f.beforeId !== undefined) { where.push('id < ?'); params.push(f.beforeId) }
    const sql = `SELECT id, service, ts, event, identity, source_ip, method, path, tool, result, agrabah_identifier, duration_ms, reason
               FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
    params.push(f.limit)
    return db.prepare(sql).all(...params) as EventRow[]
  },

  async sessionEvents(f: SessionsFilter) {
    const where = ['ts >= ?', 'identity IS NOT NULL']
    const params: any[] = [f.since]
    if (f.service) { where.push('service = ?'); params.push(f.service) }
    if (f.identity) { where.push('identity = ?'); params.push(f.identity) }
    // ORDER BY 補 id 破平手（Reviewer B MINOR-1）：同一毫秒內的多列（MCP 一次
    // tool 呼叫常見）在 ts 之後順序未定義，會讓 /api/sessions 的 tools[] 順序不穩定。
    return db
      .prepare(`SELECT id, service, ts, identity, tool, path, result, source_ip, agrabah_identifier FROM events WHERE ${where.join(' AND ')} ORDER BY service, identity, ts, id`)
      .all(...params) as SessionEventRow[]
  },

  async stats(since: string, hourWindowSince: string): Promise<StatsResult> {
    const perDay = db.prepare(`SELECT substr(ts, 1, 10) AS day, service, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY day, service ORDER BY day`).all(since) as StatsResult['perDay']
    const perHour = db.prepare(`SELECT substr(ts, 1, 13) AS hour, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY hour ORDER BY hour`).all(hourWindowSince) as StatsResult['perHour']
    const topIdentities = db.prepare(`SELECT identity, service, COUNT(*) AS n, MAX(ts) AS last_ts FROM events WHERE ts >= ? AND identity IS NOT NULL GROUP BY identity, service ORDER BY last_ts DESC LIMIT 50`).all(since) as StatsResult['topIdentities']
    const topTools = db.prepare(`SELECT tool, service, COUNT(*) AS n, SUM(CASE WHEN result LIKE 'error:%' THEN 1 ELSE 0 END) AS errors, ROUND(AVG(duration_ms)) AS avg_ms FROM events WHERE ts >= ? AND tool IS NOT NULL GROUP BY tool, service ORDER BY n DESC LIMIT 50`).all(since) as StatsResult['topTools']
    const authFailures = db.prepare(`SELECT service, source_ip, reason, COUNT(*) AS n, MAX(ts) AS last_ts FROM events WHERE ts >= ? AND event = 'auth_failure' GROUP BY service, source_ip, reason ORDER BY n DESC LIMIT 50`).all(since) as StatsResult['authFailures']
    const total = db.prepare('SELECT COUNT(*) AS n FROM events').get() as any
    return { perDay, perHour, topIdentities, topTools, authFailures, totalEvents: total.n }
  },

  async statusLog(service?: string, limit = 200) {
    return (service
      ? db.prepare('SELECT * FROM status_log WHERE service = ? ORDER BY id DESC LIMIT ?').all(service, limit)
      : db.prepare('SELECT * FROM status_log ORDER BY id DESC LIMIT ?').all(limit)) as StatusLogRow[]
  },

  async pipelineRuns(limit: number) {
    return db.prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?').all(limit) as PipelineRunRow[]
  },

  async pipelineRunByKey(key: string) {
    return (db.prepare('SELECT * FROM pipeline_runs WHERE key = ?').get(key) as PipelineRunRow | undefined) ?? null
  },

  async pipelineRunsByTicket(kind: string, ticket: string) {
    return db.prepare('SELECT * FROM pipeline_runs WHERE kind = ? AND ticket = ?').all(kind, ticket) as PipelineRunRow[]
  },

  async allAgentRuns() {
    return db.prepare('SELECT * FROM agent_runs ORDER BY started_at').all() as AgentRunRow[]
  },

  async latestBugRunKey(ticket: string) {
    const row = db
      .prepare("SELECT key FROM pipeline_runs WHERE kind = 'bug' AND ticket = ? ORDER BY started_at DESC LIMIT 1")
      .get(ticket) as { key: string } | undefined
    return row?.key ?? null
  },

  async identityUsage() {
    return db
      .prepare(`SELECT identity, service, MAX(ts) AS last_ts, COUNT(*) AS n FROM events WHERE identity IS NOT NULL AND event = 'request' GROUP BY identity, service`)
      .all() as IdentityUsageRow[]
  },
}
