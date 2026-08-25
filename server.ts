// tg-monitor — 本機監控 UI：tg-dispatcher 與它 proxy 的各 port 目前誰在用、log、
// 歷史紀錄、請求序列。只綁 127.0.0.1，不經 tunnel、不對外。
//
//   bun run server.ts          → http://127.0.0.1:8799
//   TG_MONITOR_PORT=xxxx 可改 port；TG_MONITOR_DB 可改 SQLite 路徑（預設 data/monitor.sqlite）

import { Hono } from 'hono'
import { existsSync, openSync, readSync, closeSync, fstatSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SERVICES, DISPATCHER_LOG_DIR, isAllowedLogPath, isAllowedTracePath, restartService } from './lib/services.ts'
import { db } from './lib/db.ts'
import { startCollectors, getLastProbes, listRunningPipelineProcs, listBugLocks, loadRoster, cancelPipeline, summarizeEvents } from './lib/ingest.ts'
import { loadConnectedUsers, loadPendingSenders, loadAllTechUsers, assignChatId, unsetChatId, sendTestMessage } from './lib/tg-users.ts'
import { getWebhookStatus } from './lib/webhook-status.ts'

const PORT = Number(process.env.TG_MONITOR_PORT ?? 8799)
const ACTIVE_WINDOW_MIN = 5
const SESSION_GAP_MIN = 10

startCollectors({ probeEveryMs: 5000, ingestEveryMs: 3000 })

const app = new Hono()

app.get('/', c => c.html(Bun.file(new URL('./public/index.html', import.meta.url).pathname).text()))

// ---------- 總覽 ----------
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

app.get('/api/overview', async c => {
  const now = Date.now()
  const activeSince = new Date(now - ACTIVE_WINDOW_MIN * 60_000).toISOString()
  const hourAgo = new Date(now - 3600_000).toISOString()
  const dayAgo = new Date(now - 86400_000).toISOString()
  const probes = new Map(getLastProbes().map(p => [p.id, p]))
  const services = SERVICES.map(s => ({
    id: s.id,
    name: s.name,
    port: s.port,
    proxyPrefix: s.proxyPrefix ?? null,
    launchdLabel: s.launchdLabel ?? null,
    hasAudit: !!s.auditLog,
    probe: probes.get(s.id) ?? null,
    lastStatusChange: lastStatusChangeStmt.get(s.id) ?? null,
    activeUsers: s.auditLog ? activeUsersStmt.all(s.id, activeSince) : [],
    req1h: s.auditLog ? (countSinceStmt.get(s.id, hourAgo) as any).n : null,
    req24h: s.auditLog ? (countSinceStmt.get(s.id, dayAgo) as any).n : null,
    err24h: s.auditLog ? (errSinceStmt.get(s.id, dayAgo) as any).n : null,
    lastEvent: s.auditLog ? (lastEventStmt.get(s.id) ?? null) : null,
    rosterSize: loadRoster(s).length,
  }))
  const running = listRunningPipelineProcs()
  const webhook = await getWebhookStatus()
  const connected = loadConnectedUsers()
  const pending = loadPendingSenders()
  return c.json({
    now: new Date(now).toISOString(),
    activeWindowMin: ACTIVE_WINDOW_MIN,
    services,
    webhook,
    tgUsers: { connectedCount: connected.length, pendingCount: pending.length },
    pipelines: {
      running,
      bugSlots: { used: running.filter(r => r.kind === 'bug').length, limit: 5 },
      demandSlots: { used: running.filter(r => r.kind === 'demand').length, limit: 2 },
      locks: listBugLocks(),
    },
  })
})

// 重啟登錄表內的服務（只接受本機請求；server 本來就只綁 127.0.0.1）。複用
// lib/services.ts 的 restartService，id 必須是登錄表內、有 launchdLabel 的
// 服務，不接受任意字串當 launchd label。
app.post('/api/services/restart', async c => {
  const body = (await c.req.json().catch(() => null)) as { id?: string } | null
  const id = (body?.id ?? '').trim()
  if (!id) return c.json({ ok: false, result: 'RESTART_ERR_ARGS: missing id' }, 400)
  const r = restartService(id)
  return c.json(r, r.ok ? 200 : 409)
})

// ---------- 事件序列 / 歷史 ----------
app.get('/api/events', c => {
  const q = c.req.query()
  const where: string[] = []
  const params: any[] = []
  if (q.service) { where.push('service = ?'); params.push(q.service) }
  if (q.identity) { where.push('identity = ?'); params.push(q.identity) }
  if (q.from) { where.push('ts >= ?'); params.push(q.from) }
  if (q.to) { where.push('ts <= ?'); params.push(q.to) }
  if (q.event) { where.push('event = ?'); params.push(q.event) }
  if (q.errors === '1') where.push("(event = 'auth_failure' OR result LIKE 'error:%')")
  if (q.q) {
    where.push('(tool LIKE ? OR path LIKE ? OR result LIKE ? OR source_ip LIKE ? OR agrabah_identifier LIKE ?)')
    const like = `%${q.q}%`
    params.push(like, like, like, like, like)
  }
  if (q.before_id) { where.push('id < ?'); params.push(Number(q.before_id)) }
  const limit = Math.min(Number(q.limit ?? 200), 1000)
  const sql = `SELECT id, service, ts, event, identity, source_ip, method, path, tool, result, agrabah_identifier, duration_ms, reason
               FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  params.push(limit)
  const rows = db.prepare(sql).all(...params)
  return c.json({ rows, limit })
})

// 「序列」：把同一人在同一服務上的連續請求（間隔 < SESSION_GAP_MIN）串成一段 session，
// 列出每段的起訖、請求數、依序用到的 tool。
app.get('/api/sessions', c => {
  const q = c.req.query()
  const days = Number(q.days ?? 7)
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  const where = ['ts >= ?', 'identity IS NOT NULL']
  const params: any[] = [since]
  if (q.service) { where.push('service = ?'); params.push(q.service) }
  if (q.identity) { where.push('identity = ?'); params.push(q.identity) }
  const rows = db
    .prepare(`SELECT id, service, ts, identity, tool, path, result, source_ip, agrabah_identifier FROM events WHERE ${where.join(' AND ')} ORDER BY service, identity, ts`)
    .all(...params) as any[]
  const gap = SESSION_GAP_MIN * 60_000
  const sessions: any[] = []
  let cur: any = null
  for (const r of rows) {
    const t = Date.parse(r.ts)
    if (!cur || cur.service !== r.service || cur.identity !== r.identity || t - Date.parse(cur.end) > gap) {
      cur = { service: r.service, identity: r.identity, start: r.ts, end: r.ts, count: 0, errors: 0, tools: [] as string[], logins: [] as string[], ips: new Set<string>(), firstId: r.id, lastId: r.id }
      sessions.push(cur)
    }
    cur.end = r.ts
    cur.lastId = r.id
    cur.count++
    if (r.result && String(r.result).startsWith('error:')) cur.errors++
    if (r.tool) cur.tools.push(r.tool)
    if (r.agrabah_identifier && !cur.logins.includes(r.agrabah_identifier)) cur.logins.push(r.agrabah_identifier)
    if (r.source_ip) cur.ips.add(r.source_ip)
  }
  for (const s of sessions) s.ips = [...s.ips]
  sessions.sort((a, b) => (a.end < b.end ? 1 : -1))
  return c.json({ sessions, gapMin: SESSION_GAP_MIN, days })
})

app.get('/api/stats', c => {
  const days = Number(c.req.query('days') ?? 7)
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  const perDay = db.prepare(`SELECT substr(ts, 1, 10) AS day, service, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY day, service ORDER BY day`).all(since)
  const perHour = db.prepare(`SELECT substr(ts, 1, 13) AS hour, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY hour ORDER BY hour`).all(new Date(Date.now() - 86400_000).toISOString())
  const topIdentities = db.prepare(`SELECT identity, service, COUNT(*) AS n, MAX(ts) AS last_ts FROM events WHERE ts >= ? AND identity IS NOT NULL GROUP BY identity, service ORDER BY n DESC LIMIT 50`).all(since)
  const topTools = db.prepare(`SELECT tool, service, COUNT(*) AS n, SUM(CASE WHEN result LIKE 'error:%' THEN 1 ELSE 0 END) AS errors, ROUND(AVG(duration_ms)) AS avg_ms FROM events WHERE ts >= ? AND tool IS NOT NULL GROUP BY tool, service ORDER BY n DESC LIMIT 50`).all(since)
  const authFailures = db.prepare(`SELECT service, source_ip, reason, COUNT(*) AS n, MAX(ts) AS last_ts FROM events WHERE ts >= ? AND event = 'auth_failure' GROUP BY service, source_ip, reason ORDER BY n DESC LIMIT 50`).all(since)
  const total = db.prepare('SELECT COUNT(*) AS n FROM events').get() as any
  return c.json({ days, perDay, perHour, topIdentities, topTools, authFailures, totalEvents: total.n })
})

app.get('/api/status-log', c => {
  const service = c.req.query('service')
  const rows = service
    ? db.prepare('SELECT * FROM status_log WHERE service = ? ORDER BY id DESC LIMIT 200').all(service)
    : db.prepare('SELECT * FROM status_log ORDER BY id DESC LIMIT 200').all()
  return c.json({ rows })
})

// 把 agent_runs 依 (kind, ticket, 時間區間) 掛到對應的 pipeline run：
// trace 的 started_at 落在 [run.started_at, 同票下一次 run.started_at) 即屬於該 run。
function attachAgentRuns(rows: any[]) {
  const byKey = new Map<string, any[]>()
  for (const r of rows) byKey.set(`${r.kind}:${r.ticket}`, [...(byKey.get(`${r.kind}:${r.ticket}`) ?? []), r])
  const agents = db.prepare('SELECT * FROM agent_runs ORDER BY started_at').all() as any[]
  for (const r of rows) { r.agents = []; }
  for (const a of agents) {
    const runs = (byKey.get(`${a.kind}:${a.ticket}`) ?? []).slice().sort((x, y) => (x.started_at < y.started_at ? -1 : 1))
    let owner: any = null
    for (const r of runs) if (r.started_at <= a.started_at) owner = r
    // trace 可能比 run 的檔名時間早幾百毫秒（wrapper 先開檔），容忍 5 秒
    if (!owner && runs.length && Date.parse(runs[0].started_at) - Date.parse(a.started_at) < 5000) owner = runs[0]
    if (owner) owner.agents.push(a)
  }
  for (const r of rows) {
    r.agent_count = r.agents.length
    r.total_input = r.agents.reduce((n: number, a: any) => n + (a.input_tokens ?? 0) + (a.cache_read_tokens ?? 0) + (a.cache_create_tokens ?? 0), 0)
    r.total_output = r.agents.reduce((n: number, a: any) => n + (a.output_tokens ?? 0), 0)
    r.total_cost = r.agents.reduce((n: number, a: any) => n + (a.cost_usd ?? 0), 0)
  }
}

app.get('/api/pipelines', c => {
  const rows = db.prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 300').all() as any[]
  attachAgentRuns(rows)
  for (const r of rows) delete r.agents // 列表只給彙總，詳情另打 /api/pipelines/run
  const running = new Set(listRunningPipelineProcs().map(r => `${r.kind}:${r.ticket}`))
  // 同票多次執行時只有最新一次（第一筆，已依 started_at DESC 排序）可能是 running
  const seen = new Set<string>()
  for (const r of rows) {
    const k = `${r.kind}:${r.ticket}`
    r.running = !seen.has(k) && r.finished_at === null && running.has(k)
    seen.add(k)
  }
  return c.json({ rows })
})

// 單一 run 詳情：run 本身 + 每個 agent 的摘要
app.get('/api/pipelines/run', c => {
  const key = c.req.query('key') ?? ''
  const run = db.prepare('SELECT * FROM pipeline_runs WHERE key = ?').get(key) as any
  if (!run) return c.json({ error: 'not found' }, 404)
  const siblings = db.prepare('SELECT * FROM pipeline_runs WHERE kind = ? AND ticket = ?').all(run.kind, run.ticket) as any[]
  attachAgentRuns(siblings)
  const me = siblings.find(r => r.key === key)
  const running = new Set(listRunningPipelineProcs().map(r => `${r.kind}:${r.ticket}`))
  const latest = siblings.slice().sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0]
  me.running = me.finished_at === null && running.has(`${me.kind}:${me.ticket}`) && latest.key === me.key
  // 需求單：把 demand-pipeline.log 該區間的進度行一併回傳
  let progress: { ts: string; msg: string }[] = []
  if (run.kind === 'demand') {
    const p = join(DISPATCHER_LOG_DIR, 'demand-pipeline.log')
    const next = siblings.map(r => r.started_at).filter(t => t > run.started_at).sort()[0] ?? null
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = /^(\S+Z) (\S+) (.*)$/.exec(line)
        if (!m || m[2] !== run.ticket || m[1] < run.started_at || (next && m[1] >= next)) continue
        progress.push({ ts: m[1], msg: m[3] })
      }
    }
  }
  return c.json({ run: me, progress })
})

// 單一 agent 的完整對話：現讀 trace JSON（或 bug pipeline 的 stdout.log），整理成 turns
app.get('/api/agent-trace', c => {
  const path = c.req.query('path') ?? ''
  if (!isAllowedTracePath(path)) return c.text('path not allowed', 403)
  if (!existsSync(path)) return c.json({ error: 'missing' }, 404)
  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return c.json({ error: `parse failed: ${err}` }, 500)
  }
  const isTrace = !Array.isArray(raw)
  const events: any[] = isTrace ? (raw.events ?? []) : raw
  const turns: any[] = []
  for (const e of events) {
    if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
      const blocks = e.message.content.map((b: any) => {
        if (b.type === 'text') return { type: 'text', text: b.text }
        if (b.type === 'thinking') return { type: 'thinking', text: b.thinking }
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
        return { type: b.type }
      })
      turns.push({ role: 'assistant', ts: e.timestamp ?? null, blocks })
    } else if (e?.type === 'user' && Array.isArray(e.message?.content)) {
      const blocks = e.message.content.map((b: any) => {
        if (b.type === 'tool_result') {
          const content = Array.isArray(b.content) ? b.content.map((x: any) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') : String(b.content ?? '')
          return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: content.length > 20000 ? content.slice(0, 20000) + `\n…（截斷，共 ${content.length} 字）` : content }
        }
        if (b.type === 'text') return { type: 'text', text: b.text }
        return { type: b.type }
      })
      turns.push({ role: 'user', ts: e.timestamp ?? null, blocks })
    }
  }
  const result = events.find(e => e?.type === 'result') ?? null
  return c.json({
    meta: isTrace ? { ticket: raw.ticket, stage: raw.stage, startedAt: raw.startedAt, endedAt: raw.endedAt, cwd: raw.cwd, args: raw.args, error: raw.error ?? null } : { stage: 'create-mr' },
    prompt: isTrace ? raw.prompt ?? null : null,
    summary: summarizeEvents(events),
    result: result ? { text: typeof result.result === 'string' ? result.result : null, is_error: !!result.is_error, subtype: result.subtype, usage: result.usage, modelUsage: result.modelUsage, total_cost_usd: result.total_cost_usd, num_turns: result.num_turns, duration_ms: result.duration_ms } : null,
    turns,
    rawStdout: isTrace && raw.rawStdout ? String(raw.rawStdout).slice(0, 20000) : null,
  })
})

// 取消背景 pipeline（只接受本機請求；server 本來就只綁 127.0.0.1）
app.post('/api/pipelines/cancel', async c => {
  const body = await c.req.json().catch(() => null) as { kind?: string; ticket?: string } | null
  const kind = body?.kind
  const ticket = body?.ticket ?? ''
  if ((kind !== 'bug' && kind !== 'demand') || !/^[A-Z]+-\d+$/.test(ticket)) return c.json({ ok: false, reason: 'bad params' }, 400)
  const r = cancelPipeline(kind, ticket)
  console.error(`cancel ${kind} ${ticket}: ${JSON.stringify(r)}`)
  return c.json(r, r.ok ? 200 : 409)
})

// ---------- TG 連接同事 ----------
app.get('/api/tg-users', c => {
  return c.json({ connected: loadConnectedUsers(), pending: loadPendingSenders(), techUsers: loadAllTechUsers() })
})

// 待處理列表手動指定技術人員（只接受本機請求；server 本來就只綁 127.0.0.1）。
// 複用 tg-map-chatids.sh --set，不在這裡重新實作寫 CSV 的邏輯。
app.post('/api/tg-users/assign', async c => {
  const body = await c.req.json().catch(() => null) as { chat_id?: string; email?: string; force?: boolean } | null
  const chatId = (body?.chat_id ?? '').trim()
  const email = (body?.email ?? '').trim()
  if (!chatId || !email) return c.json({ ok: false, result: 'SET_ERR_ARGS: missing chat_id/email' }, 400)
  const r = assignChatId(email, chatId, { force: !!body?.force })
  return c.json(r, r.ok ? 200 : 409)
})

// 取消連接（只接受本機請求）：複用 tg-map-chatids.sh --unset。
app.post('/api/tg-users/unset', async c => {
  const body = await c.req.json().catch(() => null) as { email?: string } | null
  const email = (body?.email ?? '').trim()
  if (!email) return c.json({ ok: false, result: 'UNSET_ERR_ARGS: missing email' }, 400)
  const r = unsetChatId(email)
  return c.json(r, r.ok ? 200 : 409)
})

// 測試發送（只接受本機請求）：複用 tg-notify.sh --email。
app.post('/api/tg-users/test', async c => {
  const body = await c.req.json().catch(() => null) as { email?: string; text?: string } | null
  const email = (body?.email ?? '').trim()
  const text = (body?.text ?? '').trim() || '這是一則來自 tg-monitor 的測試訊息'
  if (!email) return c.json({ ok: false, result: 'TG_ERR_ARGS: missing email' }, 400)
  const r = sendTestMessage(email, text)
  return c.json(r, r.ok ? 200 : 409)
})

app.get('/api/rosters', c => {
  return c.json(SERVICES.filter(s => s.tokensPath).map(s => ({ service: s.id, roster: loadRoster(s) })))
})

// ---------- Logs ----------
app.get('/api/logs', c => {
  const registered = SERVICES.flatMap(s => s.logs.map(l => ({ service: s.id, label: l.label, path: l.path, exists: existsSync(l.path), size: existsSync(l.path) ? statSync(l.path).size : 0 })))
  let pipelineLogs: any[] = []
  if (existsSync(DISPATCHER_LOG_DIR)) {
    pipelineLogs = readdirSync(DISPATCHER_LOG_DIR)
      .filter(f => /^[A-Z]+-\d+\./.test(f) && f.endsWith('.log'))
      .map(f => {
        const p = join(DISPATCHER_LOG_DIR, f)
        const st = statSync(p)
        return { service: 'dispatcher', label: f, path: p, exists: true, size: st.size, mtime: st.mtime.toISOString() }
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  }
  return c.json({ registered, pipelineLogs })
})

function tailFile(path: string, maxBytes: number): { text: string; size: number } {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { text, size }
  } finally {
    closeSync(fd)
  }
}

app.get('/api/log/tail', c => {
  const path = c.req.query('path') ?? ''
  if (!isAllowedLogPath(path)) return c.text('path not allowed', 403)
  if (!existsSync(path)) return c.json({ text: '', size: 0, missing: true })
  const kb = Math.min(Number(c.req.query('kb') ?? 64), 2048)
  return c.json(tailFile(path, kb * 1024))
})

// 即時跟隨：客戶端帶上次看到的 offset 來拿新增部分（輪詢，不用 SSE——Bun 1.2.9 的
// ReadableStream 在客戶端中斷連線時會 segfault，實測踩到）。
app.get('/api/log/since', c => {
  const path = c.req.query('path') ?? ''
  if (!isAllowedLogPath(path)) return c.text('path not allowed', 403)
  if (!existsSync(path)) return c.json({ text: '', offset: 0, missing: true })
  let offset = Number(c.req.query('offset') ?? 0)
  const size = statSync(path).size
  if (size < offset) offset = 0 // 被截斷 / 輪替
  if (size === offset) return c.json({ text: '', offset })
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.min(size - offset, 2 * 1024 * 1024))
    readSync(fd, buf, 0, buf.length, offset)
    return c.json({ text: buf.toString('utf8'), offset: offset + buf.length })
  } finally {
    closeSync(fd)
  }
})

console.error(`tg-monitor ready on http://127.0.0.1:${PORT}`)

export default { fetch: app.fetch, port: PORT, hostname: '127.0.0.1', idleTimeout: 120 }
