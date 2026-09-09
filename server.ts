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
// 讀取面（sqlite 已於 2026-09-09 退役，恆為 mysql，見 lib/read/index.ts）。
// server.ts 只認識這個介面，不直接碰 mysql SQL——所有 SQL 都在 lib/read/ 底下，
// **回應組裝一律留在本檔**（單一來源、形狀不分岔）。
import { getReader, initReader } from './lib/read/index.ts'
import { resolveReadSource } from './lib/read/source.ts'
import { decodeEventsCursor, encodeEventsCursor } from './lib/events-cursor.ts'
import { resolveNextStaticPath } from './lib/next-static-path.ts'
// 從 types.ts 匯入，**不是** lib/read/mysql.ts——只是要型別，不需要連帶引入
// mysql2 的 runtime 依賴。
import { UnresolvableBeforeIdError } from './lib/read/types.ts'
import { dedupRemoteDispatches, type RemoteDispatchCandidate } from './lib/read/remote-dispatches.ts'
import { startCollectors, getLastProbes, listRunningPipelineProcs, listBugLocks, loadRoster, cancelPipeline, summarizeEvents, computeBugStages, readTrackerStatusAsync, isBugOutcomeRetryable, parseClaudeEvents, getReviewRoundCounts } from './lib/ingest.ts'
import { loadConnectedUsers, loadPendingSenders, loadAllTechUsers, assignChatId, unsetChatId, sendTestMessage } from './lib/tg-users.ts'
import { getWebhookStatus } from './lib/webhook-status.ts'
import { fetchPipelineLimits, readQueuedTickets } from './lib/pipeline-queue-state.ts'
import {
  getClusterSecret,
  listWorkers,
  listDispatchEntries,
  fetchWorkerHealth,
  fetchWorkerCapacity,
  fetchWorkerJobStatus,
  cancelRemoteJob,
  disableWorker,
  enableWorker,
  removeWorker,
  readHeadMaintenance,
  setHeadMaintenance,
  fetchWorkerMaintenance,
  setWorkerMaintenance,
  fetchRemoteFile,
  fetchRemoteStageFiles,
  fetchRemoteCurrentStage,
  retryRemoteDispatch,
  applyRemoteJobStatus,
  evaluateRemoteRetryBlock,
} from './lib/cluster-state.ts'
import { tailRemoteLogContent, sinceRemoteLogContent } from './lib/remote-log-slice.ts'
import { RUNS_HOST } from './lib/mon-db.ts'
import { listToolsmithRuns } from './lib/toolsmith.ts'
import { attachAgentRuns } from './lib/agent-runs-summary.ts'

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

// 讀取面固定為 mysql（sqlite 讀取面已於 2026-09-09 退役，維護協議紅區項目 6，
// 見 lib/read/index.ts）：initReader() 探針失敗會直接 throw，不再有 sqlite
// 可以退——這是已知取捨（沒有 fallback 才是正確行為：crash-loop 讓 launchd
// 自動重試，見 lib/read/index.ts 的說明）。
//
// ⚠️ **必須排在 startCollectors() 之前**（2026-09-02 實測後調整，不是風格問題）：
// 監控 DB 的 pool 只有 4 條連線且 `waitForConnections: false`（§4.6 pool 歸屬表 +
// lib/mon-db.ts），借不到就**立刻報錯、不排隊**。collector 一啟動就會對 MySQL
// 灌入大量寫入（MON_DB_ENABLED=1 之後，光 rounds 寫入端開機就是數十筆），把 4 條
// 連線瞬間佔滿；開機探針若排在後面，會搶不到連線、拿到 `No connections available`，
// 誤判成「監控 DB 連不上」。排到前面之後，探針執行時 pool 還沒有任何競爭者，
// 這是結構性的保證，不是靠等待。
await initReader()

startCollectors({ probeEveryMs: 5000, ingestEveryMs: 3000 })

// 2026-08-28（使用者定案）：併發上限不再複製數字寫死（先前 demand 上限漂移
// 成 2、實際程式碼是 6），啟動時經 CLI 行程邊界讀 dispatcher 程式碼裡的
// 真實常數——見 lib/pipeline-queue-state.ts 檔頭註解。
const PIPELINE_LIMITS = await fetchPipelineLimits()
console.error(`tg-monitor: pipeline 併發上限 bug=${PIPELINE_LIMITS.bug} demand=${PIPELINE_LIMITS.demand}（source=${PIPELINE_LIMITS.source}）`)


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
  // Reviewer B MINOR-9：解析抽成純函式（lib/next-static-path.ts），非法百分號
  // 序列與目錄穿越都回 null → 404，不再讓 decodeURIComponent 的 throw 穿透成 500。
  const target = resolveNextStaticPath(NEXT_DIST, c.req.path.slice('/next/'.length))
  if (target === null) return c.text('not found', 404)
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

  // 分頁游標（a7-D46）。`cursor` 是 opaque 字串；`before_id` 是 deprecated 的舊參數，
  // 保留一個發版週期——前後端同 repo 同次 kickstart 一起上，沒有版本錯配窗口，
  // **除了瀏覽器裡開著的舊分頁**，而這是一個會被開著好幾天的監控面板。
  let cursorFilter: { beforeId?: number; beforeTs?: string } = {}
  if (q.cursor) {
    const cur = decodeEventsCursor(q.cursor)
    // 解不開就 400，不靜默當成第一頁：靜默會讓分頁的客戶端看起來「跳回最上面」
    // 甚至無限繞圈，而那種失敗沒有人會發現。
    if (!cur) return c.json({ error: 'invalid cursor' }, 400)
    cursorFilter = { beforeTs: cur.ts, beforeId: cur.id }
  } else if (q.before_id) {
    cursorFilter = { beforeId: Number(q.before_id) }
  }
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
    ...cursorFilter,
    limit,
  }).catch(err => {
    // deprecated 的 before_id 在 mysql 軌對不到列 → 400，與壞 cursor 同樣待遇。
    // 靜默回空頁會讓前端顯示「已到底」，而那種失敗沒有人會發現。
    if (err instanceof UnresolvableBeforeIdError) return null
    throw err
  })
  if (rows === null) return c.json({ error: 'invalid before_id' }, 400)
  // next_cursor（a7-D46）：客戶端不得自行構造游標（opaque），所以「下一頁從哪裡開始」
  // 必須由伺服器給。`null` ＝ 沒有更早的資料了——這個訊號同時解掉既有缺陷
  // 「0 筆時前端不更新 oldestId，之後『載入更早』永遠 0 筆且沒有已到底提示」。
  // 判準用 `rows.length < limit`：剛好整頁時仍給游標，客戶端會多發一次拿到 0 筆、
  // 那一次回 null 而終止。多一次請求換「不會漏資料」，這個取捨是刻意的。
  const last = rows[rows.length - 1] as any
  const nextCursor = rows.length < limit || !last ? null : encodeEventsCursor({ ts: last.ts, id: last.id })
  return c.json({ rows, limit, next_cursor: nextCursor })
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

/**
 * `remote` 陣列的候選來源（去重前）。
 *
 * 任務 1（2026-09-04）：改查監控 DB 的 `dispatch_attempts`（head 唯一寫入、
 * `status_rank < 100` 即尚未終結的派工），取代原本只讀 head 行程記憶體登記表
 * （`listDispatchEntries()`）——後者只在「進行中」期間存在，跟 `runs` 表撈出
 * 的 `rows` 是兩個互不知情的資料源，worker 執行期間兩邊各存在一筆，是
 * 「列表出現兩筆相同資料」的根因（見 lib/read/remote-dispatches.ts 檔頭）。
 * sqlite 讀取面退役後（2026-09-09）恆走這條 mysql 路徑。
 */
/** `run.host`（`agent_runs`/`runs.host`，只有 MON_READ_SOURCE=mysql 才會帶）
 * 對應的 worker 位址——`host` 存的是 CLUSTER_WORKER_NAME，等於 worker 名冊
 * 的 `.name`（見 telegram-dispatcher/lib/monitor-db/env.ts 的 MON_HOST 慣例）。
 * 查不到（worker 已退役/名冊沒有）回 null。 */
function findWorkerByName(name: string): { name: string; url: string } | null {
  return listWorkers().find(w => w.name === name) ?? null
}

/**
 * 修正「worker 執行中的 bug/demand run，`running` 被誤判成 false」（task 1，
 * 2026-09-04 觀察並修正）：本檔原本每一列的 `running` 只靠 head 本機 ps 掃描
 * （`listRunningPipelineProcs()`），worker 執行的行程天生不在 head 的 ps
 * 快照裡——一張票明明還在某台 worker 上跑，head 卻永遠回報「沒在跑」。
 *
 * 後果不只是畫面好看與否：`retryable`／取消按鈕的顯示都靠 `running` 判斷
 * （見上面 buildPipelinesPayload 迴圈、PipelinesListView.tsx 的 actions 欄）——
 * 誤判為 false 會讓使用者對一張其實還在執行的 worker 票按不到取消。
 *
 * 只對「這裡的 rows 已經確定還沒結束（`finished_at===null`）且執行機不是
 * head」的列另外即時問一次該 worker 的 `/jobs/:ticket`（ground truth）：
 * 已結束的 run 的 `finished_at` 是執行機自己寫的（R1：`runs` 只有執行機自己
 * 寫），不受 head 本機 ps 掃描影響，本來就準——這批通常只有個位數列（cluster
 * 併發上限本來就不大），逐列打一次 worker 成本可接受；secret 未設定
 * （單機部署）或查無該 worker 時整段是 no-op，維持原本（錯誤但無害）的
 * false，不讓這段修正在單機模式下引入任何行為變化。
 *
 * fail-closed（2026-09-04 安全審查 finding 修正）：`fetchWorkerJobStatus()`
 * 逾時/連不上時回傳 `null`，此時「無法確認該票是否還在跑」，不等於「確定
 * 沒在跑」——原本這裡完全不修正，`running` 會靜默停留在 ps 掃描帶來的預設
 * 錯誤值 `false`，導致 `retryable` 把一張其實可能還在 worker 上跑的票判成
 * 可重試，前端顯示出可誤按的「重試」按鈕。改成明確標記
 * `runningStatusUnknown = true`，呼叫端據此把 retryable 一併壓成 false（見
 * 下面兩處重算 retryable 的迴圈），前端則顯示「無法確認執行狀態」而非任何
 * 操作按鈕。
 */
async function correctRemoteRunningFlags(
  rows: { kind: string; ticket: string; host?: string; finished_at: string | null; running: boolean; runningStatusUnknown?: boolean }[],
): Promise<void> {
  const secret = getClusterSecret()
  if (!secret) return
  const candidates = rows.filter(r => r.finished_at === null && r.host && r.host !== RUNS_HOST)
  if (candidates.length === 0) return
  await Promise.all(
    candidates.map(async r => {
      const worker = findWorkerByName(r.host!)
      if (!worker) return
      const status = await fetchWorkerJobStatus(worker.url, secret, r.ticket)
      applyRemoteJobStatus(r, status)
    }),
  )
}

async function listRemoteDispatchCandidates(): Promise<RemoteDispatchCandidate[]> {
  const { readActiveDispatchAttempts } = await import('./lib/read/mysql.ts')
  const rows = await readActiveDispatchAttempts()
  return rows.map(r => ({
    ticket: r.ticket,
    kind: r.kind,
    // dispatch_attempts.status_rank < 100 之下只會看到 'dispatching'（10）或
    // 'dispatched'（20）——見 telegram-dispatcher/lib/cluster/dispatch-registry.ts
    // 的 DISPATCH_STATUS_RANK；'dispatched' 對映前端既有的 'confirmed' 語意
    // （已確認派到哪台，worker 已接單）。
    status: r.status === 'dispatching' ? 'dispatching' : 'confirmed',
    worker: r.workerName ?? '',
    workerUrl: r.workerUrl ?? '',
    dispatchedAt: r.dispatchedAt,
    // dispatch_attempts 只存 triggered_by_email（沒有 name 欄，見 migrations
    // 001 的 schema），name 退回 email 本身，好過完全空白。
    triggeredBy: r.triggeredByEmail ? { name: r.triggeredByEmail, email: r.triggeredByEmail } : null,
    remoteRunId: r.remoteRunId,
  }))
}

async function buildPipelinesPayload() {
  // 排隊中的單（2026-08-28）：不在 pipeline_runs（還沒 spawn、沒有 log 檔），
  // 從佇列快照另組一段清單，前端顯示在列表最上方。
  const queued = readQueuedTickets()
  const reader = getReader()
  const [remoteCandidates, rows] = await Promise.all([listRemoteDispatchCandidates(), reader.pipelineRuns(300) as Promise<any[]>])
  attachAgentRuns(rows, await reader.allAgentRuns())
  for (const r of rows) delete r.agents // 列表只給彙總，詳情另打 /api/pipelines/run
  // 任務 1：一張票若已經在 rows（真實 run 記錄）出現，就不該同時出現在
  // remote 陣列——見 lib/read/remote-dispatches.ts 的 dedupRemoteDispatches。
  const rowKeys = new Set(rows.map(r => `${r.kind}:${r.ticket}`))
  const remote = dedupRemoteDispatches(remoteCandidates, rowKeys)
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
  // task 1：worker 執行中的列，running 改問該 worker 本人（見函式註解）。
  // 這會讓上面剛算好的 retryable 對這批列失真（它假設 running 已經是最終
  // 值）——worker 執行中的票本來就不該顯示重試按鈕，重算一次同一條件即可，
  // 不需要整段搬到迴圈之後。runningStatusUnknown（worker 連不上/逾時）也要
  // 一併壓成不可重試——fail-closed，見 correctRemoteRunningFlags 註解。
  await correctRemoteRunningFlags(rows)
  for (const r of rows) {
    if (r.host && r.host !== RUNS_HOST) {
      r.retryable = r.kind === 'bug' && !r.running && !r.runningStatusUnknown && isBugOutcomeRetryable(r.outcome)
    }
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
  // task 3（2026-09-04）：Workers 分頁「目前指派在這台的票」表格補上連到
  // PipelineDetailView 的連結——DispatchEntry（head 記憶體登記表）本身沒有
  // pipeline_runs.key，這裡比照 buildPipelineRunPayload 的 siblings 查法，用
  // (kind, ticket) 反查最新一次 run 的 key。查不到（run 還沒落地/尚未被
  // collector 撈到）就是 null，前端據此決定要不要顯示連結，不是錯誤。
  const reader = getReader()
  const tickets = await Promise.all(
    listDispatchEntries()
      .filter(d => d.worker === name)
      .map(async d => {
        const runs = (await reader.pipelineRunsByTicket(d.kind, d.ticket)) as any[]
        const latest = runs.slice().sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0]
        return { ...d, runKey: latest?.key ?? null }
      }),
  )
  return c.json({ worker, online: health !== null, health, capacity, tickets, ticketStatus })
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

// ---------- 維護模式（2026-09-08，手動控制 Bug／需求單受理開關）----------
// head 與每台 worker 各自獨立一份旗標（見 telegram-dispatcher
// lib/maintenance/mode-store.ts 檔頭「belt-and-braces」說明），這裡把兩邊
// 現況彙整成一個回應給前端顯示，並提供「一鍵全部切換」的寫入端點——head
// 讀本機檔案（同 listWorkers() 的既有做法），worker 得逐台即時打
// GET /maintenance（遠端機器沒有本機檔案可讀）。
app.get('/api/maintenance', async c => {
  const secret = getClusterSecret()
  const workers = listWorkers()
  const workerRows = await Promise.all(
    workers.map(async w => ({ name: w.name, url: w.url, on: secret ? await fetchWorkerMaintenance(w.url, secret) : null })),
  )
  return c.json({ secretConfigured: secret !== null, head: { on: readHeadMaintenance() }, workers: workerRows })
})

// 一鍵切換：head + 全部已註冊 worker 一起打。單台打不通不影響其他台，逐台
// 回報結果讓前端知道哪些沒切成功（例如某台 worker 剛好斷線）——不是「全部
// 成功才算數」的 all-or-nothing 語意，維護模式本來就是寧可漏開一台也不要
// 因為一台連不上就完全卡住整個切換動作。
app.post('/api/maintenance', async c => {
  const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null
  if (typeof body?.on !== 'boolean') return c.json({ ok: false, reason: 'missing on' }, 400)
  const on = body.on
  const secret = getClusterSecret()
  if (secret === null) return c.json({ ok: false, reason: 'CLUSTER_SHARED_SECRET 未設定，cluster 機制停用' }, 409)
  const workers = listWorkers()
  const toggleWorkers = () => Promise.all(workers.map(async w => ({ name: w.name, ok: (await setWorkerMaintenance(w.url, secret, on)).ok })))
  // 開啟：head 與全部 worker 是各自獨立的請求，平行打（review 發現：原本先
  // await head 才開始打 worker，讓 worst-case 延遲變成兩者相加而非取最大值）。
  // 關閉：worker 先關、head 最後關——head 一關就立刻觸發
  // drainMaintenanceQueue() 把排隊單重新完整跑一次，若這時候某台 worker 的
  // 維護旗標還沒真的關掉，帶產物親和性的單會被那台 503 拒絕、誤判成『該機
  // 離線，請稍後再點一次』（對抗性 review 2026-09-09 發現）；worker 先關
  // 就不會有這個窗口，代價是關閉這個方向不再是「取最大值」而是稍微加總，
  // 換到正確性優先。
  let headResult: Awaited<ReturnType<typeof setHeadMaintenance>>
  let workerResults: Awaited<ReturnType<typeof toggleWorkers>>
  if (on) {
    ;[headResult, workerResults] = await Promise.all([setHeadMaintenance(secret, on), toggleWorkers()])
  } else {
    workerResults = await toggleWorkers()
    headResult = await setHeadMaintenance(secret, on)
  }
  const ok = headResult.ok && workerResults.every(r => r.ok)
  return c.json({ ok, head: { ok: headResult.ok }, workers: workerResults }, ok ? 200 : 207)
})

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
  // task 1：這張票在 worker 上執行時，上面的 head 本機 ps 掃描天生看不到，
  // running 會被誤判成 false（見 correctRemoteRunningFlags 註解，同一個修正
  // 這裡也需要一份——這個 endpoint 只查單一 ticket，不值得為它複用那個吃
  // 陣列的版本）。已結束的 run 不受影響（finished_at 是執行機自己寫的）。
  if (me.finished_at === null && me.host && me.host !== RUNS_HOST) {
    const secret = getClusterSecret()
    const worker = secret ? findWorkerByName(me.host) : null
    if (worker && secret) {
      const status = await fetchWorkerJobStatus(worker.url, secret, me.ticket)
      applyRemoteJobStatus(me, status)
    }
  }
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
  // task 1：worker 執行的票，Debug/worktrees 產物只落在 worker 本地檔案系統，
  // head 沒有本機路徑可掃——查不到 worker 位址/secret 未設定/worker 逾時連
  // 不上時明確給一個理由，不要讓整段功能因為 worker 一時連不上就靜默顯示成
  // 「沒有任何產物」（那會誤導使用者以為 pipeline 什麼都還沒做）。
  let stagesUnavailableReason: string | null = null
  // task 2：worker 執行中的票，「目前正在跑第幾輪/哪個 agent」的即時細節——跟
  // stagesUnavailableReason 是兩件事：後者代表整份階段檢核表都拿不到（worker
  // 連不上，連已完成階段的 mtime 都沒有），這個代表「檢核表拿到了，但無法確認
  // 此刻正在跑哪一步」（worker 的 current-stage 探測逾時/連不上），fail-closed
  // 不顯示假的 running 細節，只顯示這句提示。
  let liveProgressUnavailableReason: string | null = null
  if (run.kind === 'bug' && (me.running || (!ticketHasRunningProc && latest.key === me.key))) {
    if (me.host && me.host !== RUNS_HOST) {
      const secret = getClusterSecret()
      const worker = secret ? findWorkerByName(me.host) : null
      if (!worker || !secret) {
        stagesUnavailableReason = `此票執行於 worker「${me.host}」，但目前查不到該 worker 的位址或 CLUSTER_SHARED_SECRET 未設定，暫時無法取得階段進度`
      } else {
        const remoteFiles = await fetchRemoteStageFiles(worker.url, secret, run.ticket)
        if (remoteFiles) {
          const remoteCurrentStage = me.running ? await fetchRemoteCurrentStage(worker.url, secret, run.ticket, run.started_at) : undefined
          if (remoteCurrentStage && !remoteCurrentStage.ok) {
            liveProgressUnavailableReason = `此票執行於 worker「${me.host}」，但目前無法確認正在跑哪一步（worker 連不上或逾時），下方檢核表只反映已完成的階段`
          }
          stages = computeBugStages(run.ticket, run.started_at, await readTrackerStatusAsync(run.ticket), me.running, remoteFiles, remoteCurrentStage)
        } else {
          stagesUnavailableReason = `此票執行於 worker「${me.host}」，但目前連不上該 worker 或逾時，暫時無法取得階段進度，請稍後重試`
        }
      }
    } else {
      // 非同步版本（execFile 非 execFileSync）——這個 endpoint 是票詳情頁開著時
      // 定期輪詢的，用 *Sync 版本會撞 lib/ingest.ts 檔頭記載的「handler 內同步
      // spawn 遇客戶端中斷會 segfault」既有踩坑（見 listRunningPipelineProcs 旁
      // 的註解）。
      stages = computeBugStages(run.ticket, run.started_at, await readTrackerStatusAsync(run.ticket), me.running)
    }
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
  return { run: me, progress, stages, stagesUnavailableReason, liveProgressUnavailableReason }
}

app.get('/api/pipelines/run', async c => {
  const payload = await buildPipelineRunPayload(c.req.query('key') ?? '')
  if (!payload) return c.json({ error: 'not found' }, 404)
  return c.json(payload)
})

// 單一 agent 的完整對話：現讀 trace JSON（或 bug pipeline 的 stdout.log），整理成 turns。
// task 1（2026-09-04）：`host` 帶非 head 值時（前端從該 agent 列的 AgentRunRow.host
// 帶過來，見 frontend fetchAgentTrace 呼叫處）改向該 worker 的 GET /files 要內容，
// 不再對 worker 執行的 run 直接掃 head 本機路徑（那個絕對路徑只存在於 worker
// 自己的檔案系統，head 一律 404，見 lib/cluster-state.ts fetchRemoteFile 註解）。
app.get('/api/agent-trace', async c => {
  const path = c.req.query('path') ?? ''
  const host = c.req.query('host') ?? ''
  if (!isAllowedTracePath(path)) return c.text('path not allowed', 403)
  let rawText: string
  if (host && host !== RUNS_HOST) {
    const secret = getClusterSecret()
    const worker = secret ? findWorkerByName(host) : null
    if (!worker || !secret) {
      return c.json({ error: `此 agent 執行於 worker「${host}」，但目前查不到該 worker 的位址或 CLUSTER_SHARED_SECRET 未設定，暫時無法取得對話內容` }, 502)
    }
    const remote = await fetchRemoteFile(worker.url, secret, path)
    if (!remote.ok) {
      // worker 端 not_allowed/missing 也會落在這裡（reason 直接透傳），跟本機
      // 分支的 403/404 語意不完全對齊，但前端只認 traceErrorMessage() 讀
      // body.error 純文字，不特別分岔狀態碼——502 統一代表「這次沒能從 worker
      // 拿到內容」，reason 已經足夠讓使用者判斷是白名單問題還是連線問題。
      return c.json({ error: `worker「${host}」暫時無法取得 trace 內容：${remote.reason}` }, 502)
    }
    rawText = remote.content
  } else {
    if (!existsSync(path)) return c.json({ error: 'missing' }, 404)
    rawText = readFileSync(path, 'utf8')
  }
  let raw: any
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

/**
 * 這張票目前是否派在某個 worker 上執行中（`status='confirmed'` 且
 * worker/workerUrl 都有值）——任務 3：`/api/pipelines/cancel` 本機查不到時，
 * 用它判斷要不要把取消請求轉發過去。直接複用 `listRemoteDispatchCandidates()`
 * （任務 1 已接上的 dispatch_attempts / 記憶體登記表二選一來源），不再另開
 * 一條查詢路徑。
 */
async function findRemoteWorkerForTicket(kind: 'bug' | 'demand', ticket: string): Promise<{ name: string; url: string } | null> {
  const candidates = await listRemoteDispatchCandidates()
  const entry = candidates.find(e => e.kind === kind && e.ticket === ticket && e.status === 'confirmed' && e.worker && e.workerUrl)
  return entry ? { name: entry.worker, url: entry.workerUrl } : null
}

// 取消背景 pipeline（只接受本機請求；server 本來就只綁 127.0.0.1）
app.post('/api/pipelines/cancel', async c => {
  const body = await c.req.json().catch(() => null) as { kind?: string; ticket?: string } | null
  const kind = body?.kind
  const ticket = body?.ticket ?? ''
  if ((kind !== 'bug' && kind !== 'demand') || !/^[A-Z]+-\d+$/.test(ticket)) return c.json({ ok: false, reason: 'bad params' }, 400)
  const r = await cancelPipeline(kind, ticket)
  if (r.ok) {
    console.error(`cancel ${kind} ${ticket}: ${JSON.stringify(r)}`)
    return c.json(r, 200)
  }
  // 任務 3：本機 ps 快照查不到時，不直接回「not running」——這張票可能派在
  // 某台 worker 上執行中（head 完全沒有它的本機行程可查），改查
  // dispatch_attempts/登記表判斷要不要轉發。
  const remoteWorker = await findRemoteWorkerForTicket(kind, ticket)
  if (!remoteWorker) {
    console.error(`cancel ${kind} ${ticket}: ${JSON.stringify(r)}`)
    return c.json(r, 409)
  }
  const secret = getClusterSecret()
  if (!secret) {
    const reason = '這張單派在 worker 上，但 CLUSTER_SHARED_SECRET 未設定，無法轉發取消請求'
    console.error(`cancel ${kind} ${ticket}: ${reason}`)
    return c.json({ ok: false, reason }, 409)
  }
  const remoteResult = await cancelRemoteJob(remoteWorker.url, secret, ticket)
  console.error(`cancel ${kind} ${ticket}（轉發至 worker ${remoteWorker.name}）: ${JSON.stringify(remoteResult)}`)
  return c.json(remoteResult, remoteResult.ok ? 200 : 409)
})

// 重試（只接受本機請求；server 本來就只綁 127.0.0.1）：2026-08-26 起改為
// 「續跑」語意（使用者核准的紅區變更）——spawn 時帶 --resume，/create-mr 的
// Step 0.2 會跑 scripts/resume-inventory.sh 盤點既有 Debug 產物、review 結論
// 與 mr/ 分支 commit，從最後完成的階段接續（例如三審皆 PASSED → 直接
// Solution 彙整起；審查有 FAILED → fixer 帶回饋重做）。盤點失敗時 pipeline
// 自動退回整張全跑，不會卡死。
//
// 2026-09-09 起：tracker.md 退役，權限判斷不再查/寫 tracker.sh，改成只看
// 「這張票現在是否真的在跑」（下面三關），詳見端點內註解。
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
  // task 2：上面的 running 只查 head 本機 ps——這張票若正在某台 worker 上跑，
  // head 的 ps 快照天生看不到（同 correctRemoteRunningFlags 的既有落差）。
  // tracker 狀態 'in_progress' 同時涵蓋「真的還在跑」與「卡住需要人工重試」
  // 兩種情境（下面 tracker 檢查會放行 'in_progress'），只靠 tracker 狀態分不
  // 出來，這裡額外向 worker 求證一次，避免對一張還在執行中的 worker 票重複
  // 觸發（兩台同時跑同一張票）。
  const clusterSecret = getClusterSecret()
  if (clusterSecret) {
    const remoteWorker = await findRemoteWorkerForTicket('bug', ticket)
    if (remoteWorker) {
      const status = await fetchWorkerJobStatus(remoteWorker.url, clusterSecret, ticket)
      // fail-closed（2026-09-04 安全審查 finding 修正，見 evaluateRemoteRetryBlock
      // 註解）：status === null（worker 連不上/逾時）比照「還在跑」擋下，不
      // 放行到下面的 retryRemoteDispatch()。
      const block = evaluateRemoteRetryBlock(remoteWorker.name, status)
      if (block.blocked) return c.json({ ok: false, reason: block.reason }, 409)
    }
  }

  // 2026-09-09（使用者核准，紅區：retry 權限判斷語意變更，tracker.md 退役）：
  // 拿掉「tracker 完成狀態必須是 failed/in_progress/rerun 才放行」這道閘門。
  // 原因：create-mr pipeline 在 head/worker 端偶爾會出錯而沒有把 Notion
  // 狀態改到終態（停在「分析中」），造成這張票在任何地方都查不到「可重試」
  // 的狀態、monitor 卻明明知道它已經不在跑——使用者要 monitor 有權限對任何
  // 狀態的票重跑，只要上面 3 關（本機 ps／併發上限／worker 即時查證
  // fail-closed）確認過「這張票現在真的沒在跑」即可。也不再需要 `tracker.sh
  // set rerun` 這個前置寫入——tracker.md 已退役，claim-ticket.sh 的
  // `--resume` 旗標本身就會跳過候選檢查（見 aladdin_ai/scripts/claim-ticket.sh）。
  // 2026-09-01：重試沿用上一筆 run 的發起人，否則重試出來的 run 在列表
  // 「發起人」欄會空白，看不出這張單是誰認領的。取不到（上一筆本來就是人工
  // CLI 跑的、sidecar 缺檔）就不帶，行為同以前。
  const prevEmail = await readLastTriggeredByEmail(ticket)

  // task 2（2026-09-04）：cluster 啟用時改打 head 的 POST /cluster/retry，讓
  // 續跑走跟一般派工（claim.ts 的 dispatchBug()）相同的分派判斷——resume 靠
  // checkout 既有 mr/{ticket} 分支到新 worktree，不依賴哪台機器的本地磁碟
  // 殘留狀態，所以可能落到跟原本執行機不同的 worker，這是預期內、可接受的
  // 行為（不用特別要求一定要回到原本那台機器）。見 lib/cluster-state.ts
  // retryRemoteDispatch() 與 telegram-dispatcher/lib/cluster/cluster-head.ts
  // 的 /cluster/retry 端點註解。
  //
  // cluster 停用（單機部署，CLUSTER_SHARED_SECRET 未設定）時維持原本的本機
  // CLI 路徑——行為與加入這次改動之前 100% 相同（同 cluster-env.ts 檔頭的
  // 既有不變式）。CLI 邊界呼叫 telegram-dispatcher 的 spawn-create-mr.ts（見
  // 檔頭 import 註解），不是直接 import spawnCreateMr——結果走 stdout 一行
  // JSON + exit code。
  if (clusterSecret) {
    const result = await retryRemoteDispatch(clusterSecret, ticket, prevEmail)
    if (!result.ok) return c.json({ ok: false, reason: `分派失敗（票已設回 rerun，可再按一次重試）：${result.reason}` }, 500)
    if (result.status === 'started' || result.status === 'queued') return c.json({ ok: true, pid: result.status === 'started' ? result.pid : undefined, status: result.status })
    if (result.status === 'remote_started' || result.status === 'already_running_remote') return c.json({ ok: true, status: result.status, worker: result.worker })
    return c.json({ ok: true, status: result.status })
  }

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

// worker 執行的票，log 屬於 host-aware（task 1，2026-09-04）：查不到 worker
// 位址/secret 未設定/worker 連不上或逾時都回 502 + 明確理由（fail-closed，
// 比照 /api/agent-trace 的同款分流），不靜默回空內容或本機的舊快取當成即時
// 資料。`missing` 這個 reason 例外——那不是失敗，是「worker 上這個路徑確實
// 不存在」，跟本機 `!existsSync(path)` 同一種正常狀態，直接比照本機分支的
// 回應形狀（`{ text: '', size: 0, missing: true }` / `{ text: '', offset: 0,
// missing: true }`），不當錯誤處理。
app.get('/api/log/tail', async c => {
  const path = c.req.query('path') ?? ''
  const host = c.req.query('host') ?? ''
  if (!isAllowedLogPath(path)) return c.text('path not allowed', 403)
  if (host && host !== RUNS_HOST) {
    const secret = getClusterSecret()
    const worker = secret ? findWorkerByName(host) : null
    if (!worker || !secret) return c.json({ error: `此 log 屬於 worker「${host}」，但目前查不到該 worker 的位址或 CLUSTER_SHARED_SECRET 未設定` }, 502)
    const remote = await fetchRemoteFile(worker.url, secret, path)
    if (!remote.ok) {
      if (remote.reason === 'missing') return c.json({ text: '', size: 0, missing: true })
      return c.json({ error: `worker「${host}」暫時無法取得 log 內容：${remote.reason}` }, 502)
    }
    const kb = Math.min(Number(c.req.query('kb') ?? 64), 2048)
    return c.json(tailRemoteLogContent(remote.content, kb * 1024))
  }
  if (!existsSync(path)) return c.json({ text: '', size: 0, missing: true })
  const kb = Math.min(Number(c.req.query('kb') ?? 64), 2048)
  return c.json(tailFile(path, kb * 1024))
})

// 即時跟隨：客戶端帶上次看到的 offset 來拿新增部分。輪詢是當年 Bun 1.2.9 的
// ReadableStream 客戶端斷線 segfault 逼出來的；2026-09-02 於 Bun 1.4.0 以最小
// repro（多條 SSE 連線硬斷 + cancel callback）實測已修復，SSE 不再是禁區——
// 但「handler 內同步 spawn 遇斷線 segfault」是另一個踩坑（見 lib/ingest.ts
// 檔頭），未隨之解除，SSE handler 內仍禁 *Sync spawn。
//
// task 1（2026-09-04）：worker 執行的票，`GET /files` 沒有「從 offset 起讀」
// 的能力（見 lib/remote-log-slice.ts 檔頭）——host-aware 分支改成每次都把整份
// 內容從 worker 抓回來，在記憶體裡做跟本機分支相同的 offset 切片
// （sinceRemoteLogContent()，含同樣的 2MB 單次上限與截斷/輪替重置語意），
// 1500ms 輪詢一次、pipeline log 檔案量級不大，這是風險最低的做法（不需要在
// worker 端新增有狀態的 offset 協定）。
app.get('/api/log/since', async c => {
  const path = c.req.query('path') ?? ''
  const host = c.req.query('host') ?? ''
  if (!isAllowedLogPath(path)) return c.text('path not allowed', 403)
  if (host && host !== RUNS_HOST) {
    const secret = getClusterSecret()
    const worker = secret ? findWorkerByName(host) : null
    if (!worker || !secret) return c.json({ error: `此 log 屬於 worker「${host}」，但目前查不到該 worker 的位址或 CLUSTER_SHARED_SECRET 未設定` }, 502)
    const remote = await fetchRemoteFile(worker.url, secret, path)
    if (!remote.ok) {
      if (remote.reason === 'missing') return c.json({ text: '', offset: 0, missing: true })
      return c.json({ error: `worker「${host}」暫時無法取得 log 內容：${remote.reason}` }, 502)
    }
    const offset = Number(c.req.query('offset') ?? 0)
    return c.json(sinceRemoteLogContent(remote.content, offset))
  }
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
// （lib/ingest.ts:113-117），本端點推的每一個 payload 都只走
// 快取（getLastProbes / listRunningPipelineProcs）、檔案讀取與 async execFile，
// 全鏈路沒有任何 *Sync spawn——動這裡時務必維持這條。

const SSE_HEARTBEAT_MS = 15_000
// 對應前端的兩條既有輪詢迴圈：全域心跳 5000ms、log 跟隨 1500ms
// （frontend/src/api/transport.ts 的 POLL_INTERVAL_MS / LOG_FOLLOW_INTERVAL_MS）。
const SSE_DEFAULT_INTERVAL_MS = 5000
const SSE_LOG_INTERVAL_MS = 1500
// 同一個 topic 連續失敗幾次就把整條串流關掉。
// 為什麼要關而不是繼續送註解列：`:` 開頭的註解列 EventSource **一定會忽略**，
// `onerror` 只在連線層失敗時才觸發，所以「連線活著、每一拍都失敗」在前端看起來
// 是一條健康的連線配上永遠不更新的畫面——對一個監控面板來說這是最糟的失敗模式
// （輪詢版同樣的失敗會走 ApiError → transport.ts 的 onError → 分頁顯示錯誤）。
// 主動 error 掉串流，前端的 onerror 才會觸發、才會依 transport.ts 的既定計畫
// 降級回輪詢，然後從一般 GET 端點拿到真正的錯誤。
const SSE_MAX_CONSECUTIVE_FAILURES = 3
// 同時允許的 /api/stream 連線數上限。每條連線都常駐 1~6 個 timer、每 5 秒觸發
// 一輪查詢（`pipeline-run` 還會 spawn 一次 tracker.sh），沒有上限的話開太多分頁
// 就能把這台機器的讀取面拖垮。超過就回 503，不是靜默排隊。
const SSE_MAX_CONNECTIONS = 32
let sseConnections = 0

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

  if (sseConnections >= SSE_MAX_CONNECTIONS) {
    return c.json({ error: `/api/stream 連線數已達上限（${SSE_MAX_CONNECTIONS}）` }, 503)
  }

  const enc = new TextEncoder()
  const timers: ReturnType<typeof setInterval>[] = []
  let closed = false
  sseConnections++

  /** 唯一的收尾路徑：清 timer、放掉連線名額。重複呼叫安全。 */
  const shutdown = () => {
    if (closed) return
    closed = true
    for (const t of timers) clearInterval(t)
    timers.length = 0
    sseConnections--
  }

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        if (closed) return false
        // 背壓：ReadableStream 的 enqueue 不會阻塞，消費端不讀時 Bun 會一直往
        // 內部佇列堆。log topic 每 1500ms 最多 2MB，客戶端休眠／分頁被節流／
        // TCP 視窗塞住但連線未斷時，這條連線的佇列會一路長到 OOM。
        // desiredSize <= 0 代表佇列已滿——這一拍整拍不送（log 那側也因此不會
        // 推進 offset，下一拍會重送同一段，不會遺漏內容）。
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return false
        try {
          controller.enqueue(enc.encode(chunk))
          return true
        } catch {
          // 客戶端已斷線但 cancel() 還沒被呼叫到的短暫視窗。這條路徑同樣要
          // 收尾——只靠 cancel() 的話（stream 是 error 而非 cancel 收場時）
          // 這條連線的 timer 會永遠留在事件迴圈裡空轉。
          shutdown()
          return false
        }
      }
      const emit = (topic: string, payload: unknown) => send(`event: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`)
      // 註解行（`:` 開頭）EventSource 會直接忽略——只拿來當心跳與人工排查用的
      // 痕跡，**不拿它當錯誤通道**（見 SSE_MAX_CONSECUTIVE_FAILURES 的說明）。
      const note = (msg: string) => send(`: ${msg.replace(/[\r\n]+/g, ' ')}\n\n`)

      /** 讓整條串流以錯誤收場，觸發前端 EventSource 的 onerror → 降級回輪詢。 */
      const fail = (reason: string) => {
        if (closed) return
        console.error(`tg-monitor: /api/stream 中止：${reason}`)
        shutdown()
        try {
          controller.error(new Error(reason))
        } catch {}
      }

      // 每個 topic 各一條迴圈，且各自帶 inFlight 旗標：某次 build 比 interval 慢
      // 時只會略過這一拍，不會愈疊愈多（同一個 topic 永遠最多一個 build 在飛）。
      const loop = (topic: StreamTopic, intervalMs: number, tick: () => Promise<void>) => {
        let inFlight = false
        let consecutiveFailures = 0
        const run = () => {
          if (closed || inFlight) return
          inFlight = true
          tick()
            .then(() => {
              consecutiveFailures = 0
            })
            .catch(err => {
              consecutiveFailures++
              console.error(`tg-monitor: /api/stream topic=${topic} 產生 payload 失敗（連續第 ${consecutiveFailures} 次）：${err}`)
              note(`error ${topic}`)
              if (consecutiveFailures >= SSE_MAX_CONSECUTIVE_FAILURES) {
                fail(`topic=${topic} 連續 ${consecutiveFailures} 次失敗：${err}`)
              }
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
            // 查無此 key **不能**當成一份成功的 payload 推出去：GET 端點是回
            // 404（走前端的 ApiError → onError → 顯示「找不到紀錄」），而 SSE
            // 若把同一個 body 塞進 onData，前端的
            // `notFound = Boolean(error) && !data` 會因為 data 是 truthy 而判成
            // false，畫出一頁語意全錯的空白詳情。改成讓這條串流以錯誤收場，
            // 前端降級回輪詢後就會拿到真正的 404。
            if (!payload) throw new Error(`pipeline run not found: ${runKey}`)
            emit(topic, payload)
          })
        } else if (topic === 'log') {
          loop(topic, SSE_LOG_INTERVAL_MS, async () => {
            // 與 /api/log/since 同一份語意。
            if (!existsSync(logPath)) {
              logOffset = 0
              emit(topic, { text: '', offset: 0, missing: true })
              return
            }
            const size = statSync(logPath).size
            const prevOffset = logOffset
            if (size < logOffset) logOffset = 0 // 被截斷 / 輪替
            if (size === logOffset) {
              // 沒有新內容就整拍不推（省頻寬）——**但剛剛被截斷的那一拍例外**。
              // log 被清成 0 bytes 時 size === logOffset === 0，如果這裡直接
              // return，前端的 `if (res.offset < offsetRef.current) setText('')`
              // 永遠沒機會執行，畫面會卡在舊內容上（可能很久，或永遠）。
              // /api/log/since 在同樣情況下是會回 `{text:'', offset:0}` 的。
              if (logOffset < prevOffset) emit(topic, { text: '', offset: logOffset })
              return
            }
            const fd = openSync(logPath, 'r')
            try {
              const buf = Buffer.alloc(Math.min(size - logOffset, 2 * 1024 * 1024))
              readSync(fd, buf, 0, buf.length, logOffset)
              // 只有真的送出去才推進 offset：背壓擋掉這一拍時 offset 不動，
              // 下一拍會重送同一段，內容不會被跳過。
              if (emit(topic, { text: buf.toString('utf8'), offset: logOffset + buf.length })) {
                logOffset += buf.length
              }
            } finally {
              closeSync(fd)
            }
          })
        }
      }

      timers.push(setInterval(() => note('ping'), SSE_HEARTBEAT_MS))
    },
    cancel() {
      shutdown()
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

// 目前生效的讀取面資料源。**唯讀端點**：sqlite 讀取面退役前（`MON_READ_SOURCE
// =mysql` 但探針失敗）會靜默退回 sqlite，這支端點就是為了讓那件事從外面也
// 看得到（原本只寫在 stderr）。刻意不把它塞進 /api/overview：那會改到既有
// 回應的形狀。
app.get('/api/read-source', c => {
  const raw = process.env.MON_READ_SOURCE
  return c.json({
    // 原始字串，未經解析——設定打錯字時要看得到打錯的那個字。
    requested: raw ?? null,
    effective: getReader().source,
    // sqlite 退役後（2026-09-09）不再有「探針失敗、靜默退回 sqlite」這個降級
    // 路徑：探針失敗時 initReader() 直接 throw（見 lib/read/index.ts），行程
    // 根本起不來，這支端點也就不會被打到——會走到這裡就代表 mysql 是活的，
    // 恆為 false。欄位保留（不改回應形狀）供 health-monitor 既有的翻轉條件
    // 沿用。
    degraded: false,
    // 這個值本身認不認得（2026-09-02 新增，供 health-monitor 的翻轉條件使用）。
    // MON_READ_SOURCE 現在對讀取面已無實際效果（恆為 mysql），這裡仍保留字面
    // 檢查——純粹是「設定值本身寫得對不對」的診斷，跟讀取面實際行為分開。
    requestedValid: (raw ?? '').trim() === '' || resolveReadSource(raw) === (raw ?? '').trim().toLowerCase(),
  })
})

console.error(`tg-monitor ready on http://127.0.0.1:${PORT}`)

export default { fetch: app.fetch, port: PORT, hostname: '127.0.0.1', idleTimeout: 120 }
