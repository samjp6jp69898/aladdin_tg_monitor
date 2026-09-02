// tg-monitor — 本機監控 UI：tg-dispatcher 與它 proxy 的各 port 目前誰在用、log、
// 歷史紀錄、請求序列。只綁 127.0.0.1，不經 tunnel、不對外。
//
//   bun run server.ts          → http://127.0.0.1:8799
//   TG_MONITOR_PORT=xxxx 可改 port；TG_MONITOR_DB 可改 SQLite 路徑（預設 data/monitor.sqlite）

import { Hono } from 'hono'
import { existsSync, openSync, readSync, closeSync, fstatSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { SERVICES, DISPATCHER_LOG_DIR, isAllowedLogPath, isAllowedTracePath, restartService } from './lib/services.ts'
// 讀取面（MON_READ_SOURCE=sqlite|mysql，plan-db-as-truth-v3.md §8.1）。
// server.ts 只認識這個介面，不再直接碰 sqlite——所有 SQL 都在 lib/read/ 底下，
// 兩個資料源交出同一個形狀，**回應組裝一律留在本檔**（單一來源、形狀不分岔）。
import { getReader, initReader } from './lib/read/index.ts'
import type { AgentRunRow } from './lib/read/types.ts'
import { startCollectors, getLastProbes, listRunningPipelineProcs, listBugLocks, loadRoster, cancelPipeline, summarizeEvents, computeBugStages, readTrackerStatusAsync, isBugOutcomeRetryable, parseClaudeEvents, getReviewRoundCounts } from './lib/ingest.ts'
import { loadConnectedUsers, loadPendingSenders, loadAllTechUsers, assignChatId, unsetChatId, sendTestMessage } from './lib/tg-users.ts'
import { getWebhookStatus } from './lib/webhook-status.ts'
import { fetchPipelineLimits, readQueuedTickets } from './lib/pipeline-queue-state.ts'
import { getClusterSecret, listWorkers, listDispatchEntries, fetchWorkerHealth, fetchWorkerCapacity, fetchWorkerJobStatus, disableWorker, enableWorker, removeWorker } from './lib/cluster-state.ts'
import { listToolsmithRuns } from './lib/toolsmith.ts'

const execFileAsync = promisify(execFile)
// telegram-dispatcher 是另一個獨立 repo，跟 tg-monitor 沒有 package.json 依賴
// 關係——刻意不 import 它的 spawn-create-mr.ts（review 2026-08-25 發現：那樣
// import 端會耦合到對方的內部型別/傳遞依賴/model-level singleton 狀態，且
// 兩邊各自獨立的 git 生命週期下互相看不到對方壞掉），改用行程邊界呼叫它新增
// 的 CLI 入口（`if (import.meta.main)` 那段）：介面只有「argv + stdout JSON +
// exit code」，兩邊各自的改動不會在編譯期互相牽動。
const SPAWN_CREATE_MR_SCRIPT = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/spawn-create-mr.ts'

const PORT = Number(process.env.TG_MONITOR_PORT ?? 8799)
const ACTIVE_WINDOW_MIN = 5
const SESSION_GAP_MIN = 10

startCollectors({ probeEveryMs: 5000, ingestEveryMs: 3000 })

// 2026-08-28（使用者定案）：併發上限不再複製數字寫死（先前 demand 上限漂移
// 成 2、實際程式碼是 6），啟動時經 CLI 行程邊界讀 dispatcher 程式碼裡的
// 真實常數——見 lib/pipeline-queue-state.ts 檔頭註解。
const PIPELINE_LIMITS = await fetchPipelineLimits()
console.error(`tg-monitor: pipeline 併發上限 bug=${PIPELINE_LIMITS.bug} demand=${PIPELINE_LIMITS.demand}（source=${PIPELINE_LIMITS.source}）`)

// 讀取面來源（MON_READ_SOURCE）。預設 sqlite；切 mysql 失敗會退回 sqlite 並記
// ERROR（見 lib/read/index.ts 的說明）。切換一律經由重啟：
//   改 tg-monitor/.env 的一個字 + launchctl kickstart -k com.aladdin.tg-monitor
const READ_SOURCE = await initReader()
console.error(`tg-monitor: 讀取面資料源 = ${READ_SOURCE}`)

const app = new Hono()

// 舊版 vanilla JS 前端（public/index.html）已於 2026-09-02 經使用者核准刪除，React 版
// 成為唯一前端。根路徑導向 /next/，讓既有書籤與手感仍可用（React 版的 build base 是
// '/next/'，資產路徑都帶這個前綴，所以維持該路徑而非搬到根目錄）。
// 舊版最後狀態可從 git 取回：git show 624ae25:public/index.html
app.get('/', c => c.redirect('/next/'))

// 新版 React 前端（frontend/）的 build 產物掛在 /next/ 底下，與舊版 public/index.html
// 並存，方便新舊對照驗收；舊版路徑與所有既有 API 端點行為完全不變。
const NEXT_DIST = new URL('./frontend/dist/', import.meta.url).pathname
app.get('/next', c => c.redirect('/next/'))
app.get('/next/*', async c => {
  const rel = decodeURIComponent(c.req.path.slice('/next/'.length))
  const target = rel === '' ? join(NEXT_DIST, 'index.html') : join(NEXT_DIST, rel)
  if (!target.startsWith(NEXT_DIST)) return c.text('not found', 404)
  const file = Bun.file(target)
  if (await file.exists()) return new Response(file)
  const index = Bun.file(join(NEXT_DIST, 'index.html'))
  if (await index.exists()) return new Response(index)
  return c.text('新前端尚未 build：cd frontend && bun run build', 404)
})

// ---------- 總覽 ----------
// 五條 SQL（activeUsers / req1h / req24h / err24h / lastEvent / lastStatusChange）
// 已搬進 lib/read/sqlite.ts，逐字未改；這裡只剩「組裝」。
async function buildOverviewPayload() {
  const now = Date.now()
  const activeSince = new Date(now - ACTIVE_WINDOW_MIN * 60_000).toISOString()
  const hourAgo = new Date(now - 3600_000).toISOString()
  const dayAgo = new Date(now - 86400_000).toISOString()
  const probes = new Map(getLastProbes().map(p => [p.id, p]))
  const reader = getReader()
  const auditIds = SERVICES.filter(s => s.auditLog).map(s => s.id)
  const audit = await reader.serviceAuditStats(auditIds, { activeSince, hourAgo, dayAgo })
  const statusChanges = await reader.lastStatusChanges(SERVICES.map(s => s.id))
  const services = SERVICES.map(s => {
    const a = s.auditLog ? audit.get(s.id) : undefined
    return {
      id: s.id,
      name: s.name,
      port: s.port,
      proxyPrefix: s.proxyPrefix ?? null,
      launchdLabel: s.launchdLabel ?? null,
      hasAudit: !!s.auditLog,
      probe: probes.get(s.id) ?? null,
      lastStatusChange: statusChanges.get(s.id) ?? null,
      activeUsers: a ? a.activeUsers : [],
      req1h: a ? a.req1h : null,
      req24h: a ? a.req24h : null,
      err24h: a ? a.err24h : null,
      lastEvent: a ? a.lastEvent : null,
      rosterSize: loadRoster(s).length,
    }
  })
  const running = listRunningPipelineProcs()
  const webhook = await getWebhookStatus()
  const connected = loadConnectedUsers()
  const pending = loadPendingSenders()
  // 排隊中的單（2026-08-28 排隊機制）：dispatcher 額滿時排入 FIFO 佇列，
  // 快照落在 logs/pipeline-queue.*.json，見 lib/pipeline-queue-state.ts。
  const queued = readQueuedTickets()
  return {
    now: new Date(now).toISOString(),
    activeWindowMin: ACTIVE_WINDOW_MIN,
    services,
    webhook,
    tgUsers: { connectedCount: connected.length, pendingCount: pending.length },
    pipelines: {
      running,
      queued,
      limitsSource: PIPELINE_LIMITS.source,
      bugSlots: { used: running.filter(r => r.kind === 'bug').length, limit: PIPELINE_LIMITS.bug, queued: queued.filter(q => q.kind === 'bug').length },
      demandSlots: { used: running.filter(r => r.kind === 'demand').length, limit: PIPELINE_LIMITS.demand, queued: queued.filter(q => q.kind === 'demand').length },
      locks: listBugLocks(),
    },
  }
}

app.get('/api/overview', async c => c.json(await buildOverviewPayload()))

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
app.get('/api/events', async c => {
  const q = c.req.query()
  const limit = Math.min(Number(q.limit ?? 200), 1000)
  const rows = await getReader().queryEvents({
    service: q.service,
    identity: q.identity,
    from: q.from,
    to: q.to,
    event: q.event,
    errorsOnly: q.errors === '1',
    // 只看真正呼叫了 tool 的請求（隱藏 initialize / tools-list / notifications 等
    // MCP 握手雜訊——server 對每個 HTTP request 都建立全新 stateless McpServer，
    // 一次企劃端的 tool 呼叫實際上會產生好幾個握手 request，這些依 audit_log.ts
    // 設計 tool 欄固定 null，屬預期行為而非漏記，這裡只是給前端一個濾掉它們的開關）
    toolOnly: q.toolOnly === '1',
    q: q.q,
    beforeId: q.before_id ? Number(q.before_id) : undefined,
    limit,
  })
  return c.json({ rows, limit })
})

// 「序列」：把同一人在同一服務上的連續請求（間隔 < SESSION_GAP_MIN）串成一段 session，
// 列出每段的起訖、請求數、依序用到的 tool。
app.get('/api/sessions', async c => {
  const q = c.req.query()
  const days = Number(q.days ?? 7)
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  const rows = (await getReader().sessionEvents({ since, service: q.service, identity: q.identity })) as any[]
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

app.get('/api/stats', async c => {
  const days = Number(c.req.query('days') ?? 7)
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  // perHour 固定近 24 小時，不受 days 影響（既有行為，見 00-api-inventory.md）。
  const s = await getReader().stats(since, new Date(Date.now() - 86400_000).toISOString())
  return c.json({ days, ...s })
})

app.get('/api/status-log', async c => {
  const rows = await getReader().statusLog(c.req.query('service'))
  return c.json({ rows })
})

// 把 agent_runs 依 (kind, ticket, 時間區間) 掛到對應的 pipeline run：
// trace 的 started_at 落在 [run.started_at, 同票下一次 run.started_at) 即屬於該 run。
function attachAgentRuns(rows: any[], agents: AgentRunRow[]) {
  const byKey = new Map<string, any[]>()
  for (const r of rows) byKey.set(`${r.kind}:${r.ticket}`, [...(byKey.get(`${r.kind}:${r.ticket}`) ?? []), r])
  // MON_READ_SOURCE=mysql 時兩邊都帶 run_id（agent_runs 的 PK 一半就是它），
  // 歸戶不必再靠時間視窗猜——直接對位。sqlite 模式兩邊都沒有 run_id，
  // 這個 Map 是空的，一律落到下面既有的時間視窗邏輯，行為完全不變。
  const byRunId = new Map<string, any>()
  for (const r of rows) if (typeof r.run_id === 'string' && r.run_id) byRunId.set(r.run_id, r)
  for (const r of rows) { r.agents = []; }
  for (const a of agents as any[]) {
    const exact = typeof a.run_id === 'string' && a.run_id ? byRunId.get(a.run_id) : undefined
    if (exact) { exact.agents.push(a); continue }
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

async function buildPipelinesPayload() {
  // 排隊中的單（2026-08-28）：不在 pipeline_runs（還沒 spawn、沒有 log 檔），
  // 從佇列快照另組一段清單，前端顯示在列表最上方。
  const queued = readQueuedTickets()
  // 派在遠端 worker 上執行中的單（2026-08-31 T37）：這台 head 完全沒有它的
  // pipeline_runs 紀錄（log 檔落在 worker 那台機器上），唯一的可見痕跡就是
  // dispatch-registry 這份「派到哪台」登記表——只有進行中的條目，worker 回報
  // job-done 後就清掉，看不到遠端執行的歷史（見 cluster-state.ts 檔頭）。
  const remote = listDispatchEntries()
  const reader = getReader()
  const rows = (await reader.pipelineRuns(300)) as any[]
  attachAgentRuns(rows, await reader.allAgentRuns())
  for (const r of rows) delete r.agents // 列表只給彙總，詳情另打 /api/pipelines/run
  // 2026-08-28（FAQ-4768 連點事故）：bug run 以 stdout 路徑對應 ps 行程歸戶
  // （見 lib/ingest.ts scanPipelineRuns 同日註解）；demand 維持 ticket+最新
  // 一次的判法。
  const procs = listRunningPipelineProcs()
  const runningBugPaths = new Set(procs.filter(p => p.kind === 'bug').map(p => p.extra))
  const runningDemand = new Set(procs.filter(p => p.kind === 'demand').map(p => `demand:${p.ticket}`))
  // 同票多次執行時只有最新一次（第一筆，已依 started_at DESC 排序）可能是 running
  const seen = new Set<string>()
  for (const r of rows) {
    const k = `${r.kind}:${r.ticket}`
    r.running = r.kind === 'bug'
      ? runningBugPaths.has(r.stdout_path)
      : !seen.has(k) && r.finished_at === null && runningDemand.has(k)
    seen.add(k)
    // 2026-08-27 使用者釐清：這欄要顯示「當時觸發這次 run 的人」，不是 Notion
    // 當前指派（那欄事後會被轉派給別人，例如轉測試給非技術人員，兩者是不同
    // 概念，混用會誤導）。triggered_by 是 telegram-dispatcher 在認領當下寫的
    // sidecar，沒有就留空——不再退回 Notion 當前指派頂替，那正是要修掉的來源。
    r.assignee = r.triggered_by ?? null
    // 前端「重試」按鈕的顯示依據——跟 /api/pipelines/retry 的真正權限判斷共用
    // 同一個 isBugOutcomeRetryable()，不再各自維護一份判斷式（review 2026-08-25
    // 發現的前後端不同步問題）。這裡只看已存的 outcome 字串，不額外查一次
    // tracker（避免對列表裡最多 300 列都同步呼叫 shell）；真正能不能重試以
    // retry 端點送出當下的即時檢查為準，這裡只保證「大致準、失敗會有清楚錯誤訊息」。
    r.retryable = r.kind === 'bug' && !r.running && isBugOutcomeRetryable(r.outcome)
  }
  return { rows, queued, remote }
}

app.get('/api/pipelines', async c => c.json(await buildPipelinesPayload()))

// aladdin_toolsmith_generate_tool 的即時進度（企劃透過 toolsmith 自助擴充
// admin/platform tool 的每一次請求）：不落地成 pipeline_runs（那張表是靠 ps
// 掃 telegram-dispatcher 產生的子行程，toolsmith 的背景任務活在它自己
// hosted server 的 process 裡，這裡沒有對應的子行程可掃），直接現讀
// scratch/<requestId>/conversation.json，見 lib/toolsmith.ts 檔頭說明。
function buildToolsmithPayload() {
  return { rows: listToolsmithRuns() }
}

app.get('/api/toolsmith', c => {
  return c.json(buildToolsmithPayload())
})

// ---------- 多機派工（T37 head/worker cluster）----------
app.get('/api/cluster/workers', async c => {
  const secret = getClusterSecret()
  const workers = listWorkers()
  const dispatched = listDispatchEntries()
  const rows = await Promise.all(
    workers.map(async w => {
      const health = await fetchWorkerHealth(w.url)
      const capacity = secret ? await fetchWorkerCapacity(w.url, secret) : null
      return { ...w, online: health !== null, health, capacity, tickets: dispatched.filter(d => d.worker === w.name) }
    }),
  )
  return c.json({ secretConfigured: secret !== null, workers: rows })
})

// 單一 worker 的即時詳情（health + capacity + 指派在它身上的票），可選帶
// ?ticket= 順便查那張票在該 worker 的實況（GET /jobs/:ticket）——供 Workers
// 分頁的詳情面板與 Pipelines 分頁「查看 worker」連結共用。
app.get('/api/cluster/worker', async c => {
  const name = c.req.query('name') ?? ''
  const worker = listWorkers().find(w => w.name === name)
  if (!worker) return c.json({ error: 'worker 未註冊（可能已退役或名稱打錯）' }, 404)
  const secret = getClusterSecret()
  const [health, capacity] = await Promise.all([fetchWorkerHealth(worker.url), secret ? fetchWorkerCapacity(worker.url, secret) : Promise.resolve(null)])
  const ticket = c.req.query('ticket')
  let ticketStatus: unknown = null
  if (ticket && secret && /^(FAQ|ALDREQ)-\d+$/.test(ticket)) {
    ticketStatus = { ticket, status: await fetchWorkerJobStatus(worker.url, secret, ticket) }
  }
  return c.json({ worker, online: health !== null, health, capacity, tickets: listDispatchEntries().filter(d => d.worker === name), ticketStatus })
})

// 中斷／恢復／移除（只接受本機請求；server 本來就只綁 127.0.0.1）：實際動作
// 是打 head（telegram-dispatcher 8787）新增的 /cluster/worker/:name/* 端點，
// 見 cluster-state.ts 檔頭——名冊活在 head 的 process 記憶體裡，這裡不能
// 直接改檔案。CLUSTER_SHARED_SECRET 未設定時這三個動作結構上不可能成功
// （head 那組路由整個沒掛），直接回錯誤訊息，不嘗試打網路。
async function handleWorkerAction(c: any, action: (name: string, secret: string) => Promise<{ ok: boolean; status: number }>) {
  const body = (await c.req.json().catch(() => null)) as { name?: string } | null
  const name = (body?.name ?? '').trim()
  if (!name) return c.json({ ok: false, reason: 'missing name' }, 400)
  const secret = getClusterSecret()
  if (secret === null) return c.json({ ok: false, reason: 'CLUSTER_SHARED_SECRET 未設定，cluster 機制停用' }, 409)
  const r = await action(name, secret)
  if (r.ok) return c.json({ ok: true })
  return c.json({ ok: false, reason: r.status === 404 ? `head 名冊裡找不到 worker「${name}」` : `head 回應 ${r.status || '（連不上）'}` }, 409)
}
app.post('/api/cluster/worker/disable', c => handleWorkerAction(c, disableWorker))
app.post('/api/cluster/worker/enable', c => handleWorkerAction(c, enableWorker))
app.post('/api/cluster/worker/remove', c => handleWorkerAction(c, removeWorker))

// 單一 run 詳情：run 本身 + 每個 agent 的摘要
// 找不到該 key 回 null（呼叫端負責決定要 404 還是略過不推）。
async function buildPipelineRunPayload(key: string) {
  const reader = getReader()
  const run = (await reader.pipelineRunByKey(key)) as any
  if (!run) return null
  const siblings = (await reader.pipelineRunsByTicket(run.kind, run.ticket)) as any[]
  // mysql 模式下 key 有可能是以 run_id 命中的（legacy_key 為空的列），
  // 而 siblings 是以 (kind, ticket) 撈的、其 key 一律是 legacy_key ?? run_id；
  // 兩者對不上時把 run 自己補進去，避免 me 變成 undefined。
  // sqlite 模式 run.key 必然等於查詢用的 key、且必在 siblings 內，這行不會生效。
  if (!siblings.some(r => r.key === run.key)) siblings.push(run)
  attachAgentRuns(siblings, await reader.allAgentRuns())
  const me = siblings.find(r => r.key === run.key)
  const procs = listRunningPipelineProcs()
  const latest = siblings.slice().sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0]
  // bug 以 stdout 路徑歸戶（見 /api/pipelines 同日註解），demand 維持舊判法。
  me.running = me.kind === 'bug'
    ? procs.some(p => p.kind === 'bug' && p.extra === me.stdout_path)
    : me.finished_at === null && procs.some(p => p.kind === 'demand' && p.ticket === me.ticket) && latest.key === me.key
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
  // Bug pipeline：Debug/{ticket}/{ticket}-*.md 存在與否即階段檢核表，見
  // computeBugStages 註解——同一張票的多次執行（例如失敗後 rerun）共用同一份
  // Debug 產物，不逐次分別重算。歸屬規則（2026-08-28 FAQ-4768 連點事故後
  // 修正）：有行程真的在跑時，檢核表跟著**真正在跑的那次**（me.running，以
  // stdout 路徑歸戶）；都沒在跑時才退回「最新一次」的歷史檢視——舊邏輯只認
  // 最新一次，重複觸發時活著的舊 run 反而分不到檢核表（實際踩過）。
  const ticketHasRunningProc = procs.some(p => p.kind === 'bug' && p.ticket === run.ticket)
  let stages: ReturnType<typeof computeBugStages> = []
  if (run.kind === 'bug' && (me.running || (!ticketHasRunningProc && latest.key === me.key))) {
    // 非同步版本（execFile 非 execFileSync）——這個 endpoint 是票詳情頁開著時
    // 定期輪詢的，用 *Sync 版本會撞 lib/ingest.ts 檔頭記載的「handler 內同步
    // spawn 遇客戶端中斷會 segfault」既有踩坑（見 listRunningPipelineProcs 旁
    // 的註解）。
    stages = computeBugStages(run.ticket, run.started_at, await readTrackerStatusAsync(run.ticket), me.running)
  }
  // 審查輪數（2026-09-02）：跑完的 run 靠 DB 欄位（collector tick 已在最後
  // 一次掃描時持久化，見 ingest.ts persistReviewRounds）；還在跑的 run 額外
  // 即時掃一次 transcript，取兩者較大值——DB 值可能落後最多一個 ingest tick
  // 間隔。0 或無值就不帶 rounds 欄位（歷史 run 沒有這兩欄，graceful degrade）。
  if (run.kind === 'bug' && stages.length) {
    const live = me.running ? getReviewRoundCounts(run.ticket, run.started_at) : null
    const reviewRounds = Math.max(me.review_rounds ?? 0, live?.reviewRounds ?? 0)
    const finalReviewRounds = Math.max(me.final_review_rounds ?? 0, live?.finalReviewRounds ?? 0)
    for (const s of stages) {
      if (s.key === 'review' && reviewRounds > 0) s.rounds = reviewRounds
      else if (s.key === 'final-review' && finalReviewRounds > 0) s.rounds = finalReviewRounds
    }
  }
  return { run: me, progress, stages }
}

app.get('/api/pipelines/run', async c => {
  const payload = await buildPipelineRunPayload(c.req.query('key') ?? '')
  if (!payload) return c.json({ error: 'not found' }, 404)
  return c.json(payload)
})

// 單一 agent 的完整對話：現讀 trace JSON（或 bug pipeline 的 stdout.log），整理成 turns
app.get('/api/agent-trace', c => {
  const path = c.req.query('path') ?? ''
  if (!isAllowedTracePath(path)) return c.text('path not allowed', 403)
  if (!existsSync(path)) return c.json({ error: 'missing' }, 404)
  let raw: any
  const rawText = readFileSync(path, 'utf8')
  try {
    raw = JSON.parse(rawText)
  } catch (err) {
    // 2026-08-26 起 bug pipeline stdout 是 stream-json 的 JSONL（執行中逐行
    // 落盤，尾行可能寫到一半）——整檔 parse 失敗時改逐行解析成事件陣列，
    // 跟舊格式（單一 JSON 陣列）走同一條 isTrace=false 路徑。
    raw = parseClaudeEvents(rawText)
    if (!raw) return c.json({ error: `parse failed: ${err}` }, 500)
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
  const r = await cancelPipeline(kind, ticket)
  console.error(`cancel ${kind} ${ticket}: ${JSON.stringify(r)}`)
  return c.json(r, r.ok ? 200 : 409)
})

// 重試（只接受本機請求；server 本來就只綁 127.0.0.1）：2026-08-26 起改為
// 「續跑」語意（使用者核准的紅區變更）——spawn 時帶 --resume，/create-mr 的
// Step 0.2 會跑 scripts/resume-inventory.sh 盤點既有 Debug 產物、review 結論
// 與 mr/ 分支 commit，從最後完成的階段接續（例如三審皆 PASSED → 直接
// Solution 彙整起；審查有 FAILED → fixer 帶回饋重做）。盤點失敗時 pipeline
// 自動退回整張全跑，不會卡死。
//
// 沿用既有、已合法的機制：tracker.sh 的 rerun 狀態本來就存在（`next` 子指令
// 本就優先撿 rerun），create-mr.md Step 0.1 claim 本就接受 pending/rerun——
// 這裡只是新增一個觸發入口，不是新語意。
//
// 併發上限用 ps 現場真實計數（listRunningPipelineProcs），不是
// spawn-create-mr.ts 裡的 in-memory GLOBAL_CONCURRENCY_LIMIT 計數器：那個
// 計數器只活在 telegram-dispatcher webhook server 自己的 process 記憶體裡
// （這裡改用 CLI 呼叫，見上面 import 區塊註解，連讀到那個計數器的機會都沒
// 有），就算讀得到也是另一份從 0 開始、彼此不同步的計數器，用它判斷會允許
// 超過真正上限。ps 快照不管由哪個 process 觸發都反映同一個事實，天生不會有
// 這個問題。
// 2026-08-28 起不再複製數字：啟動時經 CLI 讀 dispatcher 的
// GLOBAL_CONCURRENCY_LIMIT 真實常數（見 PIPELINE_LIMITS），不會再漂移。
const RETRY_CONCURRENCY_LIMIT = PIPELINE_LIMITS.bug
/**
 * 這張票最近一筆 bug run 的發起人 email：讀 telegram-dispatcher 寫的
 * `<key>.triggered-by.json` sidecar（pipeline_runs.triggered_by 只存了 name，
 * 而 spawn-create-mr.ts 的 `--triggered-by-email` 要的是 email）。任一環節缺
 * （沒跑過、sidecar 不存在、格式跑掉）都回 null，重試照舊不帶發起人。
 */
async function readLastTriggeredByEmail(ticket: string): Promise<string | null> {
  const lastKey = await getReader().latestBugRunKey(ticket)
  if (!lastKey) return null
  try {
    const parsed = JSON.parse(readFileSync(join(DISPATCHER_LOG_DIR, `${lastKey}.triggered-by.json`), 'utf8')) as { email?: unknown }
    return typeof parsed.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(parsed.email) ? parsed.email : null
  } catch {
    return null
  }
}

app.post('/api/pipelines/retry', async c => {
  const body = await c.req.json().catch(() => null) as { ticket?: string } | null
  const ticket = body?.ticket ?? ''
  if (!/^FAQ-\d+$/.test(ticket)) return c.json({ ok: false, reason: 'ticket 格式錯誤（僅支援 FAQ-數字，需求單 ALDREQ 目前不提供這個按鈕）' }, 400)

  const running = listRunningPipelineProcs()
  if (running.some(p => p.kind === 'bug' && p.ticket === ticket)) return c.json({ ok: false, reason: '這張票目前還在跑，不能重複觸發' }, 409)
  if (running.filter(p => p.kind === 'bug').length >= RETRY_CONCURRENCY_LIMIT) return c.json({ ok: false, reason: `背景 pipeline 併發已達上限（${RETRY_CONCURRENCY_LIMIT}），稍後再試` }, 429)

  // 即時查一次（非快取、非同步版本），這裡是唯一的權限判斷——上面 /api/pipelines
  // 回傳的 retryable 只是給前端顯示按鈕用的粗略提示（見 isBugOutcomeRetryable
  // 註解），送出當下一律以這裡查到的最新狀態為準。'rerun' 也放行：
  // tracker.sh set ... rerun 成功、但下面 spawn 失敗（或 spawn 成功但新的一次
  // 執行來不及 claim 就 skipped/crash）時，票會被留在 rerun 狀態——若這裡不放行
  // rerun，使用者會撞進一個按鈕自己造成、又自己拒絕重試的死路（review 2026-08-25
  // 發現）。
  const tracker = await readTrackerStatusAsync(ticket)
  if (!tracker) return c.json({ ok: false, reason: 'tracker 查無這張票' }, 404)
  if (tracker.status !== 'failed' && tracker.status !== 'in_progress' && tracker.status !== 'rerun') {
    return c.json({ ok: false, reason: `目前 tracker 狀態是「${tracker.status}」，只有 failed / in_progress（卡住）/ rerun 才能用這個按鈕重試` }, 409)
  }

  try {
    await execFileAsync('bash', ['/Users/user/aladdin/scripts/tracker.sh', 'set', ticket, 'rerun'], { encoding: 'utf8', timeout: 10_000 })
  } catch (err) {
    return c.json({ ok: false, reason: `tracker.sh set 失敗：${err}` }, 500)
  }
  // CLI 邊界呼叫 telegram-dispatcher 的 spawn-create-mr.ts（見檔頭 import 註解），
  // 不是直接 import spawnCreateMr——結果走 stdout 一行 JSON + exit code。
  // 2026-09-01：重試沿用上一筆 run 的發起人（`--triggered-by-email`），否則
  // 重試出來的 run 在列表「發起人」欄會空白，看不出這張單是誰認領的。取不到
  // （上一筆本來就是人工 CLI 跑的、sidecar 缺檔）就不帶旗標，行為同以前。
  const prevEmail = await readLastTriggeredByEmail(ticket)
  const spawnArgs = [SPAWN_CREATE_MR_SCRIPT, ticket, '--resume', ...(prevEmail ? ['--triggered-by-email', prevEmail] : [])]
  try {
    const { stdout } = await execFileAsync('bun', spawnArgs, { encoding: 'utf8', timeout: 10_000 })
    const spawned = JSON.parse(stdout.trim()) as { ok: true; pid: number | undefined } | { ok: false; reason: string }
    if (!spawned.ok) return c.json({ ok: false, reason: `spawn 失敗：${spawned.reason}` }, 500)
    return c.json({ ok: true, pid: spawned.pid })
  } catch (err) {
    return c.json({ ok: false, reason: `spawn 呼叫失敗（票已設回 rerun，可再按一次重試）：${err}` }, 500)
  }
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

// Token 權限總覽：把各名冊以「人」為主鍵樞紐——每人一列、每個 hosted server（環境）
// 一欄，附核發時間與稽核事件推出的最後使用時間/累計請求數。只讀 id / display_name /
// issued_at，絕不讀或回傳 token 值（同 loadRoster 的既有紀律）。
app.get('/api/token-grants', async c => {
  const svcs = SERVICES.filter(s => s.tokensPath)
  const usage = await getReader().identityUsage()
  const usageMap = new Map(usage.map(u => [`${u.identity}\u0000${u.service}`, u]))
  const people = new Map<string, { id: string; display_name: string; grants: Record<string, { issued_at: string; last_ts: string | null; n: number }> }>()
  for (const s of svcs) {
    for (const t of loadRoster(s)) {
      const p = people.get(t.id) ?? { id: t.id, display_name: t.display_name, grants: {} }
      // 稽核 log 的 identity 有兩種歷史格式：舊事件（含目前線上版本）寫
      // display_name、audit_log.ts H28 之後寫名冊唯一 id——兩種都比對並合計。
      // 已知侷限：兩個 id 共用同一個 display_name 時（如打錯字重發的舊 id），
      // display_name 那份用量會同時算在兩個人頭上，稽核 log 本身無從區分。
      const byId = usageMap.get(`${t.id}\u0000${s.id}`)
      const byName = t.display_name && t.display_name !== t.id ? usageMap.get(`${t.display_name}\u0000${s.id}`) : undefined
      const lastTs = [byId?.last_ts, byName?.last_ts].filter(Boolean).sort().pop() ?? null
      p.grants[s.id] = { issued_at: t.issued_at, last_ts: lastTs, n: (byId?.n ?? 0) + (byName?.n ?? 0) }
      people.set(t.id, p)
    }
  }
  return c.json({ services: svcs.map(s => ({ id: s.id, name: s.name })), people: [...people.values()].sort((a, b) => a.id.localeCompare(b.id)) })
})

// ---------- Token 權限管理（撤銷 / 補簽 / 改名 / 重發 / 新增）----------
// kit 四環境一律 spawn make-starter-kit.ts、toolsmith 一律 spawn 它自己的
// manage-tokens.ts（各自都是該名冊的唯一寫入者），monitor 絕不自己改名冊
// JSON。toolsmith 不屬於企劃 kit（工程師名冊）：token 不進 kit zip，簽發/重簽
// 時由 manage-tokens.ts 直接把 .mcp.json 片段發到 kit 管理者 TG。
const MAKE_KIT_SCRIPT = '/Users/user/aladdin/aladdin_mcps/aladdin-ai-assistant-kit/make-starter-kit.ts'
const TOOLSMITH_TOKENS_SCRIPT = '/Users/user/aladdin/aladdin_mcps/aladdin-toolsmith/manage-tokens.ts'
const KIT_RESEND_SCRIPT = '/Users/user/aladdin/telegram-dispatcher/lib/webhook-server/kit-resend.ts'
const KIT_GRANT_BY_SERVICE: Record<string, string> = { 'admin-dev': 'admin-dev', 'admin-pre': 'admin-pre', 'admin-evi': 'admin-evi', 'platform': 'platform-dev-pk', 'platform-6t': 'platform-dev-6t', 'platform-pre-pk': 'platform-pre-pk', 'platform-pre-6t': 'platform-pre-6t', 'platform-evi-6t': 'platform-evi-6t' }
const KIT_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/

async function runTokenScript(script: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; result: string }> {
  try {
    const { stdout } = await execFileAsync('bun', [script, ...args], { timeout: timeoutMs })
    return { ok: true, result: stdout.trim() }
  } catch (err: any) {
    return { ok: false, result: String(err?.stderr || err?.stdout || err?.message || err).trim() }
  }
}
const runMakeKit = (args: string[]) => runTokenScript(MAKE_KIT_SCRIPT, args, 30_000)
const runToolsmithTokens = (args: string[]) => runTokenScript(TOOLSMITH_TOKENS_SCRIPT, args, 90_000) // 含 TG 發送
const runKitResend = (args: string[]) => runTokenScript(KIT_RESEND_SCRIPT, args, 120_000) // rotate + zip + TG 發送

const rosterHas = (serviceId: string, id: string): boolean => {
  const s = SERVICES.find(x => x.id === serviceId)
  return !!s && loadRoster(s).some(t => t.id === id)
}
const findDisplayName = (id: string): string => {
  for (const s of SERVICES.filter(s => s.tokensPath)) {
    const e = loadRoster(s).find(t => t.id === id)
    if (e?.display_name) return e.display_name
  }
  return ''
}
/** 多個底層腳本呼叫的結果彙整：全部成功才算成功，輸出串接。 */
const combine = (parts: { ok: boolean; result: string }[]) => ({
  ok: parts.every(p => p.ok),
  result: parts.map(p => p.result).filter(Boolean).join('\n\n'),
})

/**
 * 依 services 清單（畫面勾選狀態）核發/重簽 kit 與 toolsmith 權限，供「新增
 * token」與「重發 token」共用：清單裡沒有的環境一律不動（不會自動撤銷，撤權
 * 走既有的「移除」）；有列進來的環境，沒有舊 token 就核發、有舊 token 就重簽。
 * kit 環境靠 make-starter-kit.ts 的 --rotate 語意本來就同時處理這兩種情況
 * （見該檔 --rotate 說明）；toolsmith 的 manage-tokens.ts --rotate 要求 id
 * 已存在於它自己的名冊，所以這裡先查有沒有、沒有就改叫 --issue。
 *
 * toolsmith 與 kit 的交付管道整合（2026-08-26）：make-starter-kit.ts 現在會
 * 唯讀併入 toolsmith 名冊的條目到輸出的 .mcp.json（見該檔 mergeToolsmithGrant）。
 * 所以這裡固定先跑 toolsmith 動作、再跑 kit 這邊，讓 kit 重建時撈到的是剛
 * 核發/重簽的新 token；此人只要「有 kit 環境（這次勾的或原本就有的都算）」，
 * toolsmith 那次呼叫就加 --quiet，改由隨後的 kit zip 把新設定一起帶走，
 * 不重複發「請手動貼進 .mcp.json」那則訊息。只勾 toolsmith、但此人原本就有
 * kit 環境時，改叫 make-starter-kit.ts 的 --rebuild（不重簽任何 kit 環境，
 * 只重新組一次 .mcp.json 把新 toolsmith token 併進去）。
 */
async function reconcileGrants(id: string, name: string, services: string[]): Promise<{ ok: boolean; result: string }> {
  const kitGrants = services.filter(s => s !== 'toolsmith').map(s => KIT_GRANT_BY_SERVICE[s]).filter(Boolean)
  const wantToolsmith = services.includes('toolsmith')
  const hasExistingKit = Object.keys(KIT_GRANT_BY_SERVICE).some(svc => rosterHas(svc, id))
  const willHaveKit = hasExistingKit || kitGrants.length > 0
  const parts: { ok: boolean; result: string }[] = []
  if (wantToolsmith) {
    const hasToolsmith = rosterHas('toolsmith', id)
    const args = [hasToolsmith ? '--rotate' : '--issue', '--id', id, '--name', name]
    if (willHaveKit) args.push('--quiet') // 交給 kit zip 一併帶走，不重複發 TG
    parts.push(await runToolsmithTokens(args))
  }
  if (kitGrants.length) {
    parts.push(await runKitResend(['--id', id, '--name', name, '--grants', kitGrants.join(',')]))
  } else if (wantToolsmith && hasExistingKit) {
    // 只勾 toolsmith、但此人已有 kit：不重簽任何 kit 環境，純重建 .mcp.json
    // 把剛核發/重簽的 toolsmith token 併進去，一樣走 zip+TG 交付（不能只呼叫
    // runMakeKit 的 --rebuild——那只會落地寫 dist/，不會打包送出去）。
    parts.push(await runKitResend(['--rebuild', '--id', id, '--name', name]))
  }
  return combine(parts)
}

app.post('/api/token-grants/revoke', async c => {
  const body = await c.req.json().catch(() => null) as { id?: string; services?: string[] } | null
  const id = (body?.id ?? '').trim()
  const services = Array.isArray(body?.services) ? body.services : []
  if (!KIT_ID_PATTERN.test(id)) return c.json({ ok: false, result: 'REVOKE_ERR_ARGS: id 格式不合法' }, 400)
  const wantToolsmith = services.includes('toolsmith')
  const kitGrants = services.filter(s => s !== 'toolsmith').map(s => KIT_GRANT_BY_SERVICE[s])
  if (!services.length || kitGrants.some(g => !g)) return c.json({ ok: false, result: 'REVOKE_ERR_ARGS: services 只能是 admin-dev / admin-pre / admin-evi / platform / platform-6t / platform-pre-pk / platform-pre-6t / platform-evi-6t / toolsmith' }, 400)
  const parts: { ok: boolean; result: string }[] = []
  if (kitGrants.length) parts.push(await runMakeKit(['--revoke', '--id', id, '--grants', kitGrants.join(',')]))
  if (wantToolsmith) parts.push(await runToolsmithTokens(['--revoke', '--id', id]))
  const r = combine(parts)
  return c.json(r, r.ok ? 200 : 409)
})

app.post('/api/token-grants/add', async c => {
  const body = await c.req.json().catch(() => null) as { id?: string; service?: string } | null
  const id = (body?.id ?? '').trim()
  const service = (body?.service ?? '').trim()
  if (!KIT_ID_PATTERN.test(id)) return c.json({ ok: false, result: 'ADD_ERR_ARGS: id 格式不合法' }, 400)
  if (service !== 'toolsmith' && !KIT_GRANT_BY_SERVICE[service]) return c.json({ ok: false, result: 'ADD_ERR_ARGS: service 只能是 admin-dev / admin-pre / admin-evi / platform / platform-6t / platform-pre-pk / platform-pre-6t / platform-evi-6t / toolsmith' }, 400)
  // 只允許「補簽還沒有的環境」：該環境名冊已有這個 id 時，底層會走 rotate 換掉
  // 現役 token——那是「重簽」，不該由「簽發」按鈕誤觸。
  if (rosterHas(service, id)) return c.json({ ok: false, result: 'ADD_ERR_EXISTS: 此環境已有這個 id 的 token（要換新 token 請用「重發 token」）' }, 409)
  // display_name 從既有任一名冊條目取——能走到「補簽」的人必然已存在於某環境；
  // 全新的人請走「新增 token」表單。
  const displayName = findDisplayName(id)
  if (!displayName) return c.json({ ok: false, result: 'ADD_ERR_NOT_FOUND: 名冊裡找不到這個 id（全新的人請用「新增 token」表單）' }, 404)
  const r = service === 'toolsmith'
    ? await runToolsmithTokens(['--issue', '--id', id, '--name', displayName])
    : await runMakeKit(['--id', id, '--name', displayName, '--grants', KIT_GRANT_BY_SERVICE[service], '--rotate'])
  return c.json(r, r.ok ? 200 : 409)
})

// 改顯示名：只動各名冊的 display_name（token 與核發時間不變，不需重新交付）。
// kit 名冊與 toolsmith 名冊各自有條目才各自改。
app.post('/api/token-grants/rename', async c => {
  const body = await c.req.json().catch(() => null) as { id?: string; name?: string } | null
  const id = (body?.id ?? '').trim()
  const name = (body?.name ?? '').trim()
  if (!KIT_ID_PATTERN.test(id)) return c.json({ ok: false, result: 'RENAME_ERR_ARGS: id 格式不合法' }, 400)
  if (!name || name.length > 64) return c.json({ ok: false, result: 'RENAME_ERR_ARGS: display_name 不能為空且不超過 64 字' }, 400)
  const inKit = Object.keys(KIT_GRANT_BY_SERVICE).some(s => rosterHas(s, id))
  const inToolsmith = rosterHas('toolsmith', id)
  if (!inKit && !inToolsmith) return c.json({ ok: false, result: 'RENAME_ERR_NOT_FOUND: 名冊裡找不到這個 id' }, 404)
  const parts: { ok: boolean; result: string }[] = []
  if (inKit) parts.push(await runMakeKit(['--rename', '--id', id, '--name', name]))
  if (inToolsmith) parts.push(await runToolsmithTokens(['--rename', '--id', id, '--name', name]))
  const r = combine(parts)
  return c.json(r, r.ok ? 200 : 409)
})

// 新增／補齊 token：依勾選的 services 核發或重簽——沒有的環境核發、已有的環境
// 重簽（見 reconcileGrants）。id 全新或已存在都可以用同一個表單，已存在時等於
// 「補齊這次勾選但原本沒有的環境」而不會誤觸未勾選的既有環境。
app.post('/api/token-grants/create', async c => {
  const body = await c.req.json().catch(() => null) as { id?: string; name?: string; services?: string[] } | null
  const id = (body?.id ?? '').trim()
  const name = (body?.name ?? '').trim()
  const services = Array.isArray(body?.services) ? body.services : []
  if (!KIT_ID_PATTERN.test(id)) return c.json({ ok: false, result: 'CREATE_ERR_ARGS: id 格式不合法（小寫英數/連字號/底線，2-32 字，小寫字母開頭）' }, 400)
  if (!name || name.length > 64) return c.json({ ok: false, result: 'CREATE_ERR_ARGS: display_name 不能為空且不超過 64 字' }, 400)
  const kitGrants = services.filter(s => s !== 'toolsmith').map(s => KIT_GRANT_BY_SERVICE[s])
  if (!services.length || kitGrants.some(g => !g)) return c.json({ ok: false, result: 'CREATE_ERR_ARGS: services 至少一個，且只能是 admin-dev / admin-pre / admin-evi / platform / platform-6t / platform-pre-pk / platform-pre-6t / platform-evi-6t / toolsmith' }, 400)
  const r = await reconcileGrants(id, name, services)
  return c.json(r, r.ok ? 200 : 409)
})

// 重發：依勾選的 services 核發/重簽並重新交付（見 reconcileGrants）——沒勾的
// 環境不動、不會自動撤銷。body 沒帶 services 時（例如列表頁的快速「重發
// token」按鈕，畫面上沒有勾選框）沿用舊行為：對此人名冊裡現有的全部環境重簽。
app.post('/api/token-grants/resend', async c => {
  const body = await c.req.json().catch(() => null) as { id?: string; services?: string[] } | null
  const id = (body?.id ?? '').trim()
  if (!KIT_ID_PATTERN.test(id)) return c.json({ ok: false, result: 'RESEND_ERR_ARGS: id 格式不合法' }, 400)
  const existingServices = [
    ...Object.keys(KIT_GRANT_BY_SERVICE).filter(svc => rosterHas(svc, id)),
    ...(rosterHas('toolsmith', id) ? ['toolsmith'] : []),
  ]
  if (!existingServices.length) return c.json({ ok: false, result: 'RESEND_ERR_NOT_FOUND: 此 id 沒有任何環境的 token' }, 404)
  const services = Array.isArray(body?.services) ? body.services : existingServices
  const invalidService = services.some(s => s !== 'toolsmith' && !KIT_GRANT_BY_SERVICE[s])
  if (!services.length || invalidService) return c.json({ ok: false, result: 'RESEND_ERR_ARGS: services 至少勾選一個，且只能是 admin-dev / admin-pre / admin-evi / platform / platform-6t / platform-pre-pk / platform-pre-6t / platform-evi-6t / toolsmith' }, 400)
  const displayName = findDisplayName(id) || id
  const r = await reconcileGrants(id, displayName, services)
  return c.json(r, r.ok ? 200 : 409)
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

// 即時跟隨：客戶端帶上次看到的 offset 來拿新增部分。輪詢是當年 Bun 1.2.9 的
// ReadableStream 客戶端斷線 segfault 逼出來的；2026-09-02 於 Bun 1.4.0 以最小
// repro（多條 SSE 連線硬斷 + cancel callback）實測已修復，SSE 不再是禁區——
// 但「handler 內同步 spawn 遇斷線 segfault」是另一個踩坑（見 lib/ingest.ts
// 檔頭），未隨之解除，SSE handler 內仍禁 *Sync spawn。
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

// ---------- SSE：單一串流端點 ----------
//
//   GET /api/stream?topics=overview,pipelines,toolsmith,log&path=<log 路徑>&offset=<n>&key=<run key>
//
// 契約（與前端已定案，見 frontend/src/api/transport.ts:9,173,194 與
// plan-db-as-truth-v3.md §8.2）：
//   - **單一**端點，topics 以逗號分隔；
//   - 每則訊息 `event: <topic>`，`data` 是該 topic 的**完整** JSON payload，
//     與對應 GET 端點的回應**完全同形**——因為兩邊呼叫的是同一個
//     build*Payload()，形狀結構上不可能分岔；
//   - 不在範圍內的低頻查詢維持 request/response，本端點不提供。
//
// 前置關卡（§8.2 硬性）：`bun run scripts/sse-segfault-repro.ts` 必須 PASS。
// 2026-09-02 於 Bun 1.4.0 實測 exit 0（8 條硬斷全部觸發 cancel、server 存活）。
// ⚠️ 該腳本只解除了「ReadableStream 斷線」這一條；**handler 內同步 spawn
// （spawnSync / execFileSync）遇客戶端中斷會 segfault 那條並未解除**
// （lib/ingest.ts:99-103），本端點推的每一個 payload 都只走
// 快取（getLastProbes / listRunningPipelineProcs）、檔案讀取與 async execFile，
// 全鏈路沒有任何 *Sync spawn——動這裡時務必維持這條。

const SSE_HEARTBEAT_MS = 15_000
// 對應前端的兩條既有輪詢迴圈：全域心跳 5000ms、log 跟隨 1500ms
// （frontend/src/api/transport.ts 的 POLL_INTERVAL_MS / LOG_FOLLOW_INTERVAL_MS）。
const SSE_DEFAULT_INTERVAL_MS = 5000
const SSE_LOG_INTERVAL_MS = 1500

type StreamTopic = 'overview' | 'pipelines' | 'toolsmith' | 'pipeline-run' | 'log'
const STREAM_TOPICS: StreamTopic[] = ['overview', 'pipelines', 'toolsmith', 'pipeline-run', 'log']

app.get('/api/stream', c => {
  const q = c.req.query()
  const requested = (q.topics ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (requested.length === 0) return c.json({ error: 'missing topics' }, 400)
  const unknown = requested.filter(t => !(STREAM_TOPICS as string[]).includes(t))
  if (unknown.length) return c.json({ error: `unknown topics: ${unknown.join(',')}` }, 400)
  const topics = [...new Set(requested)] as StreamTopic[]

  // 參數化 topic 的前置檢查：在建立串流「之前」就把錯誤用一般 HTTP 回應講清楚，
  // 不要開了串流才在裡面發錯誤事件（EventSource 那側看不到 body，只會看到 open）。
  const runKey = q.key ?? ''
  if (topics.includes('pipeline-run') && !runKey) return c.json({ error: 'topic pipeline-run 需要 key 參數' }, 400)
  const logPath = q.path ?? ''
  if (topics.includes('log')) {
    // 與 /api/log/tail、/api/log/since 同一道白名單、同一個錯誤回應。
    if (!isAllowedLogPath(logPath)) return c.text('path not allowed', 403)
  }
  let logOffset = Number(q.offset ?? 0)
  if (!Number.isFinite(logOffset) || logOffset < 0) logOffset = 0

  const enc = new TextEncoder()
  const timers: ReturnType<typeof setInterval>[] = []
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        if (closed) return false
        try {
          controller.enqueue(enc.encode(chunk))
          return true
        } catch {
          // 客戶端已斷線但 cancel() 還沒被呼叫到的短暫視窗
          closed = true
          return false
        }
      }
      const emit = (topic: string, payload: unknown) => send(`event: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`)
      // 註解行（`:` 開頭）EventSource 會直接忽略——拿來當心跳與錯誤紀錄，
      // 不必為了報錯而新增契約外的 event 名稱。
      const note = (msg: string) => send(`: ${msg.replace(/[\r\n]+/g, ' ')}\n\n`)

      // 每個 topic 各一條迴圈，且各自帶 inFlight 旗標：某次 build 比 interval 慢
      // 時只會略過這一拍，不會愈疊愈多（同一個 topic 永遠最多一個 build 在飛）。
      const loop = (topic: StreamTopic, intervalMs: number, tick: () => Promise<void>) => {
        let inFlight = false
        const run = () => {
          if (closed || inFlight) return
          inFlight = true
          tick()
            .catch(err => {
              console.error(`tg-monitor: /api/stream topic=${topic} 產生 payload 失敗：${err}`)
              note(`error ${topic}`)
            })
            .finally(() => {
              inFlight = false
            })
        }
        run() // 連上就先推一份，前端不必等第一個 interval
        timers.push(setInterval(run, intervalMs))
      }

      for (const topic of topics) {
        if (topic === 'overview') {
          loop(topic, SSE_DEFAULT_INTERVAL_MS, async () => {
            emit(topic, await buildOverviewPayload())
          })
        } else if (topic === 'pipelines') {
          loop(topic, SSE_DEFAULT_INTERVAL_MS, async () => {
            emit(topic, await buildPipelinesPayload())
          })
        } else if (topic === 'toolsmith') {
          loop(topic, SSE_DEFAULT_INTERVAL_MS, async () => {
            emit(topic, buildToolsmithPayload())
          })
        } else if (topic === 'pipeline-run') {
          loop(topic, SSE_DEFAULT_INTERVAL_MS, async () => {
            const payload = await buildPipelineRunPayload(runKey)
            // 查無此 key：GET 端點回 404，串流這側沒有狀態碼可用，
            // 推 `{ error: 'not found' }`——與該端點 404 的 body 同形。
            emit(topic, payload ?? { error: 'not found' })
          })
        } else if (topic === 'log') {
          loop(topic, SSE_LOG_INTERVAL_MS, async () => {
            // 與 /api/log/since 同一份語意：檔案不見回 missing、被截斷/輪替
            // 就把 offset 歸零讓前端清空、沒有新內容就整拍不推（省頻寬，
            // 前端的 `if (res.offset < offsetRef.current)` 判斷不受影響）。
            if (!existsSync(logPath)) {
              logOffset = 0
              emit(topic, { text: '', offset: 0, missing: true })
              return
            }
            const size = statSync(logPath).size
            if (size < logOffset) logOffset = 0
            if (size === logOffset) return
            const fd = openSync(logPath, 'r')
            try {
              const buf = Buffer.alloc(Math.min(size - logOffset, 2 * 1024 * 1024))
              readSync(fd, buf, 0, buf.length, logOffset)
              logOffset += buf.length
              emit(topic, { text: buf.toString('utf8'), offset: logOffset })
            } finally {
              closeSync(fd)
            }
          })
        }
      }

      timers.push(setInterval(() => note('ping'), SSE_HEARTBEAT_MS))
    },
    cancel() {
      closed = true
      for (const t of timers) clearInterval(t)
      timers.length = 0
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 本 server 只綁 127.0.0.1、前面沒有 nginx，但寫上不吃虧、也表明意圖。
      'x-accel-buffering': 'no',
    },
  })
})

console.error(`tg-monitor ready on http://127.0.0.1:${PORT}`)

export default { fetch: app.fetch, port: PORT, hostname: '127.0.0.1', idleTimeout: 120 }
