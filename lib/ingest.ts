// 資料蒐集：
//  1) tail 各 hosted MCP server 的 audit.jsonl（H32 稽核 log）→ events 表
//     - 以 (inode, offset) 續讀；inode 變了或檔案縮水（輪替成 .1）就從 0 重讀
//     - 同一行 JSON 靠 UNIQUE(service, raw) 去重，所以重讀不會重複
//  2) 掃 telegram-dispatcher/logs 的逐票 pipeline log 檔名 → pipeline_runs 表
//     - 檔名規則見 spawn-create-mr.ts / spawn-demand-pipeline.ts：
//       <TICKET>.<ISO ts 以 - 取代 :.>.stdout.log          (bug)
//       <TICKET>.<ISO ts>.demand-pipeline.stdout.log        (demand)
//     - 是否仍在跑：ps 裡還有 `run-create-mr <ticket>` / `run-demand-pipeline <ticket>`
//  3) 探測各 port 存活（/health + lsof 拿 PID）→ status_log 只記翻轉

import { openSync, readSync, closeSync, fstatSync, statSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SERVICES, DISPATCHER_LOG_DIR, AGENT_TRACE_DIR, BUG_LOCK_DIR, type ServiceDef } from './services.ts'
import { db, insertMany, getOffset, setOffset, recordStatusIfChanged, upsertRun, finishRun, markCancelled, agentRunMtime, upsertAgentRun } from './db.ts'

// ---------- 1) audit.jsonl tail ----------

function readNewLines(path: string): string[] {
  if (!existsSync(path)) return []
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    const saved = getOffset(path)
    let start = 0
    if (saved && saved.inode === st.ino && saved.offset <= st.size) start = saved.offset
    if (st.size <= start) {
      if (!saved || saved.inode !== st.ino) setOffset(path, st.ino, start)
      return []
    }
    const len = st.size - start
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    const text = buf.toString('utf8')
    // 只吃到最後一個換行為止，半行留到下次
    const lastNl = text.lastIndexOf('\n')
    if (lastNl < 0) return []
    const consumed = Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
    setOffset(path, st.ino, start + consumed)
    return text
      .slice(0, lastNl)
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
  } finally {
    closeSync(fd)
  }
}

export function ingestAuditLogs(): number {
  let total = 0
  for (const s of SERVICES) {
    if (!s.auditLog) continue
    // 先補讀輪替檔 .1（若有、且還沒讀過），再讀主檔
    for (const p of [`${s.auditLog}.1`, s.auditLog]) {
      try {
        const lines = readNewLines(p)
        if (lines.length) total += insertMany(s.id, lines)
      } catch (err) {
        console.error(`ingest ${p} failed: ${err}`)
      }
    }
  }
  return total
}

// ---------- 2) pipeline runs ----------

const BUG_RE = /^([A-Z]+-\d+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.stdout\.log$/
const DEMAND_RE = /^([A-Z]+-\d+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.demand-pipeline\.stdout\.log$/

function fileTsToIso(t: string): string {
  // 2026-08-21T01-23-16-901Z → 2026-08-21T01:23:16.901Z
  return t.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
}

export type RunningProc = { pid: number; etime: string; kind: 'bug' | 'demand'; ticket: string; extra: string }

// 只在 collector tick 裡呼叫（spawnSync）；request handler 一律讀 cachedRunning。
// Bun 1.2.9 實測：handler 內 spawnSync 遇到客戶端中斷請求會 segfault。
let cachedRunning: RunningProc[] = []
let cachedPpid = new Map<number, number>() // pid → ppid（與 cachedRunning 同一次 ps 快照）
export function listRunningPipelineProcs(): RunningProc[] {
  return cachedRunning
}

function scanRunningPipelineProcs(): RunningProc[] {
  try {
    const out = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,etime=,command=']).stdout.toString()
    const res: RunningProc[] = []
    const ppidMap = new Map<number, number>()
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      if (!m) continue
      ppidMap.set(Number(m[1]), Number(m[2]))
      const cmd = m[4]
      const etime = m[3]
      // 只認 dispatcher spawn 的 wrapper 本體：`bash -c <script> run-create-mr <ticket> <stdout>`
      // （位置參數在命令列最末端）。不能只比對子字串，否則 grep / 人工 shell 的命令列也會中。
      let mm = /^bash -c [\s\S]*\brun-create-mr\s+([A-Z]+-\d+)\s+(\S+)\s*$/.exec(cmd)
      if (mm) {
        res.push({ pid: Number(m[1]), etime, kind: 'bug', ticket: mm[1], extra: mm[2] })
        continue
      }
      mm = /^bash -c [\s\S]*\brun-demand-pipeline\s+([A-Z]+-\d+)\s+(\S+)\s*$/.exec(cmd)
      if (mm) res.push({ pid: Number(m[1]), etime, kind: 'demand', ticket: mm[1], extra: mm[2] })
    }
    // 同一張票可能有 bash wrapper + 子 process 多行，留 pid 最小那個
    const byKey = new Map<string, RunningProc>()
    for (const r of res) {
      const k = `${r.kind}:${r.ticket}`
      if (!byKey.has(k) || byKey.get(k)!.pid > r.pid) byKey.set(k, r)
    }
    cachedPpid = ppidMap
    return [...byKey.values()]
  } catch {
    return []
  }
}

/**
 * 取消一條背景 pipeline：對 wrapper bash（ps 裡 `run-create-mr <ticket>` /
 * `run-demand-pipeline <ticket>` 那個 pid）與它的全部子孫送 SIGTERM，子孫先、
 * wrapper 後；wrapper 的 EXIT trap（見 spawn-create-mr.ts / spawn-demand-pipeline.ts）
 * 會照常執行：釋放 bug-lock、以非 0 exit code 發 TG 通知給認領人、dispatcher
 * 端的 onExit 釋放併發名額。timeout(1) 會自己開新 process group，所以不能只
 * 殺 pgid，要走 ppid 樹。5 秒後還活著的補 SIGKILL。
 * 不在這裡 spawn 任何東西（只用 process.kill + 快取的 ps 快照），避開 Bun 1.2.9
 * handler 內 spawnSync 的 segfault。
 */
export function cancelPipeline(kind: 'bug' | 'demand', ticket: string): { ok: boolean; killed: number[]; wrapperPid?: number; reason?: string } {
  const target = cachedRunning.find(r => r.kind === kind && r.ticket === ticket)
  if (!target) return { ok: false, killed: [], reason: 'not running（可能剛結束，或 ps 快照尚未更新，3 秒後再試）' }
  // 由 ppid 快照展開子孫（BFS），再反轉成「最深的先殺」
  const order: number[] = []
  const queue = [target.pid]
  while (queue.length) {
    const p = queue.shift()!
    order.push(p)
    for (const [pid, ppid] of cachedPpid) if (ppid === p && !order.includes(pid)) queue.push(pid)
  }
  // 先只殺子孫（最深的先），讓 wrapper bash 自然 wait 到子行程的 143、在 EXIT
  // trap 裡拿到非 0 的 $? 而發出 TG 通知；實測若同時對 wrapper 送 TERM，trap
  // 看到的 $? 會是 0、通知就不會發。1.5 秒後 wrapper 還活著才補 TERM。
  const killed: number[] = []
  const descendants = order.slice(1).reverse()
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGTERM')
      killed.push(pid)
    } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(target.pid, 0)
      process.kill(target.pid, 'SIGTERM')
    } catch {}
  }, 1500)
  setTimeout(() => {
    for (const pid of order) {
      try {
        process.kill(pid, 0) // 還活著才會成功
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }, 5000)
  markCancelled(kind, ticket)
  return { ok: true, killed, wrapperPid: target.pid }
}

function guessOutcome(stdoutPath: string): string {
  // claude -p --output-format json 的 stdout 是 JSON 陣列，最後一個元素通常是 result
  try {
    const txt = readFileSync(stdoutPath, 'utf8').trim()
    if (!txt) return 'empty'
    const j = JSON.parse(txt)
    const last = Array.isArray(j) ? j[j.length - 1] : j
    if (last?.subtype) return String(last.subtype)
    if (last?.is_error) return 'error'
    return 'done'
  } catch {
    return 'non-json'
  }
}

/**
 * 需求 pipeline 不寫 stdout（run-demand-pipeline.ts 全部 appendFileSync 到共用的
 * demand-pipeline.log），所以結果/結束時間改從那支 log 取：該 ticket 在
 * [startedAt, nextStart) 區間內的最後一行。
 */
function demandOutcomeFromLog(ticket: string, startedAt: string, nextStart: string | null): { finishedAt: string; outcome: string } | null {
  const p = join(DISPATCHER_LOG_DIR, 'demand-pipeline.log')
  if (!existsSync(p)) return null
  let last: { ts: string; msg: string } | null = null
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^(\S+Z) (\S+) (.*)$/.exec(line)
    if (!m || m[2] !== ticket) continue
    if (m[1] < startedAt) continue
    if (nextStart && m[1] >= nextStart) break
    last = { ts: m[1], msg: m[3] }
  }
  if (!last) return null
  return { finishedAt: last.ts, outcome: last.msg.length > 80 ? last.msg.slice(0, 80) + '…' : last.msg }
}

export function scanPipelineRuns() {
  if (!existsSync(DISPATCHER_LOG_DIR)) { cachedRunning = scanRunningPipelineProcs(); return }
  cachedRunning = scanRunningPipelineProcs()
  const running = new Set(cachedRunning.map(r => `${r.kind}:${r.ticket}`))
  const files = readdirSync(DISPATCHER_LOG_DIR)
  // 每張票各次開始時間（排序）：需求單用來切 demand-pipeline.log 區間；兩種都用來
  // 判斷「只有最新一次才可能是 running」，舊的同票紀錄一律結案。
  const demandStarts = new Map<string, string[]>()
  const bugStarts = new Map<string, string[]>()
  for (const f of files) {
    let m = DEMAND_RE.exec(f)
    if (m) { demandStarts.set(m[1], [...(demandStarts.get(m[1]) ?? []), fileTsToIso(m[2])].sort()); continue }
    m = BUG_RE.exec(f)
    if (m) bugStarts.set(m[1], [...(bugStarts.get(m[1]) ?? []), fileTsToIso(m[2])].sort())
  }
  for (const f of files) {
    let m = DEMAND_RE.exec(f)
    let kind: 'bug' | 'demand' = 'demand'
    if (!m) {
      m = BUG_RE.exec(f)
      kind = 'bug'
    }
    if (!m) continue
    const [, ticket, ts] = m
    const key = f.replace(/\.stdout\.log$/, '')
    const stdoutPath = join(DISPATCHER_LOG_DIR, f)
    const stderrPath = stdoutPath.replace(/\.stdout\.log$/, '.stderr.log')
    const startedAt = fileTsToIso(ts)
    upsertRun(key, kind, ticket, startedAt, stdoutPath, stderrPath)
    const starts = (kind === 'demand' ? demandStarts : bugStarts).get(ticket) ?? []
    const isLatest = starts[starts.length - 1] === startedAt
    if (!(running.has(`${kind}:${ticket}`) && isLatest)) {
      try {
        if (kind === 'demand') {
          const nextStart = demandStarts.get(ticket)?.find(t => t > startedAt) ?? null
          const r = demandOutcomeFromLog(ticket, startedAt, nextStart)
          if (r) finishRun(key, r.finishedAt, r.outcome)
          else finishRun(key, statSync(stdoutPath).mtime.toISOString(), 'no log')
        } else {
          // Bug pipeline：stdout 是 claude -p 的 JSON，用檔案 mtime 當結束時間
          const st = statSync(stdoutPath)
          finishRun(key, st.mtime.toISOString(), guessOutcome(stdoutPath))
          ingestBugStdout(ticket, startedAt, stdoutPath)
        }
      } catch {}
    }
  }
}

// ---------- 2b) agent traces ----------
//
// telegram-dispatcher/lib/pipeline-runner/claude-exec.ts 帶 trace 選項時，每次
// claude -p 呼叫落地一份 logs/agent-traces/<ticket>/<startedAt>-<stage>.json：
// { ticket, stage, startedAt, endedAt, cwd, args, prompt, events | error }。
// events 是 claude -p --output-format json 的完整事件陣列（system init /
// assistant / user(tool_result) / result）。這裡只抽摘要進 agent_runs；完整
// 對話由 /api/agent-trace 現讀檔案。Bug pipeline 的 <ticket>.<ts>.stdout.log
// 本身就是同樣格式的事件陣列，視為單一 stage 'create-mr' 一併收進來。

export type AgentSummary = {
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

export function summarizeEvents(events: any[] | null): AgentSummary {
  const out: AgentSummary = { model: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_create_tokens: null, cost_usd: null, num_turns: null, tool_calls: 0, is_error: 0, result_preview: null }
  if (!Array.isArray(events)) return out
  for (const e of events) {
    if (e?.type === 'system' && e.subtype === 'init' && e.model) out.model = e.model
    if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
      out.tool_calls += e.message.content.filter((c: any) => c?.type === 'tool_use').length
      if (e.message?.model) out.model = e.message.model
    }
    if (e?.type === 'result') {
      const u = e.usage ?? {}
      out.input_tokens = u.input_tokens ?? null
      out.output_tokens = u.output_tokens ?? null
      out.cache_read_tokens = u.cache_read_input_tokens ?? null
      out.cache_create_tokens = u.cache_creation_input_tokens ?? null
      out.cost_usd = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null
      out.num_turns = e.num_turns ?? null
      out.is_error = e.is_error ? 1 : 0
      if (typeof e.result === 'string') out.result_preview = e.result.slice(0, 300)
      if (e.modelUsage && typeof e.modelUsage === 'object') {
        const models = Object.keys(e.modelUsage)
        if (models.length) out.model = models.join(', ')
      }
    }
  }
  return out
}

export function scanAgentTraces() {
  if (!existsSync(AGENT_TRACE_DIR)) return
  for (const ticket of readdirSync(AGENT_TRACE_DIR)) {
    const dir = join(AGENT_TRACE_DIR, ticket)
    let files: string[]
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')) } catch { continue }
    for (const f of files) {
      const path = join(dir, f)
      try {
        const st = statSync(path)
        const mtime = st.mtime.toISOString()
        if (agentRunMtime(path) === mtime) continue
        const d = JSON.parse(readFileSync(path, 'utf8'))
        const sum = summarizeEvents(d.events)
        if (d.error) { sum.is_error = 1; sum.result_preview = String(d.error.message ?? 'error').slice(0, 300) }
        upsertAgentRun({
          path, ticket: d.ticket ?? ticket, kind: 'demand', stage: d.stage ?? f.replace(/^.*?Z-/, '').replace(/\.json$/, ''),
          started_at: d.startedAt ?? mtime, ended_at: d.endedAt ?? null, ...sum, file_mtime: mtime,
        })
      } catch (err) {
        console.error(`agent trace ${path} 解析失敗: ${err}`)
      }
    }
  }
}

/** Bug pipeline：結束後把 stdout.log（claude -p 事件陣列）當成單一 stage 收進 agent_runs */
function ingestBugStdout(ticket: string, startedAt: string, stdoutPath: string) {
  try {
    const st = statSync(stdoutPath)
    if (st.size === 0) return
    const mtime = st.mtime.toISOString()
    if (agentRunMtime(stdoutPath) === mtime) return
    const events = JSON.parse(readFileSync(stdoutPath, 'utf8'))
    const sum = summarizeEvents(events)
    upsertAgentRun({ path: stdoutPath, ticket, kind: 'bug', stage: 'create-mr', started_at: startedAt, ended_at: mtime, ...sum, file_mtime: mtime })
  } catch {}
}

export function listBugLocks(): { ticket: string; info: string }[] {
  if (!existsSync(BUG_LOCK_DIR)) return []
  const res: { ticket: string; info: string }[] = []
  for (const t of readdirSync(BUG_LOCK_DIR)) {
    const p = join(BUG_LOCK_DIR, t, 'info')
    let info = ''
    try {
      info = readFileSync(p, 'utf8').trim()
    } catch {}
    res.push({ ticket: t, info })
  }
  return res
}

// ---------- 3) port probe ----------

export type ProbeResult = {
  id: string
  status: 'up' | 'down'
  pid: number | null
  latencyMs: number | null
  uptimeSeconds: number | null
  detail: string | null
  checkedAt: string
}

const lastProbe = new Map<string, ProbeResult>()

function lsofPids(): Map<number, number> {
  // port → pid
  const map = new Map<number, number>()
  try {
    const ports = SERVICES.map(s => `-iTCP:${s.port}`)
    const out = Bun.spawnSync(['lsof', '-nP', ...ports, '-sTCP:LISTEN', '-Fpn']).stdout.toString()
    let pid = 0
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (line.startsWith('n')) {
        const mm = /:(\d+)$/.exec(line)
        if (mm) map.set(Number(mm[1]), pid)
      }
    }
  } catch {}
  return map
}

async function probeOne(s: ServiceDef, pid: number | null): Promise<ProbeResult> {
  const t0 = performance.now()
  let status: 'up' | 'down' = 'down'
  let detail: string | null = null
  let uptime: number | null = null
  try {
    const r = await fetch(s.healthUrl, { signal: AbortSignal.timeout(2000) })
    if (r.ok) {
      status = 'up'
      const j: any = await r.json().catch(() => null)
      if (j && typeof j.uptime_seconds === 'number') uptime = j.uptime_seconds
      if (s.id === 'ngrok' && j?.tunnels) {
        const t = j.tunnels[0]
        detail = t ? `${t.public_url} → ${t.config?.addr}` : 'no tunnel'
        if (!t) status = 'down'
      }
    } else detail = `HTTP ${r.status}`
  } catch (err: any) {
    detail = err?.name === 'TimeoutError' ? 'timeout' : 'connection refused'
  }
  const res: ProbeResult = {
    id: s.id,
    status,
    pid,
    latencyMs: status === 'up' ? Math.round(performance.now() - t0) : null,
    uptimeSeconds: uptime,
    detail,
    checkedAt: new Date().toISOString(),
  }
  recordStatusIfChanged(s.id, status, pid, detail)
  lastProbe.set(s.id, res)
  return res
}

export async function probeAll(): Promise<ProbeResult[]> {
  const pids = lsofPids()
  return Promise.all(SERVICES.map(s => probeOne(s, pids.get(s.port) ?? null)))
}

export function getLastProbes(): ProbeResult[] {
  return SERVICES.map(s => lastProbe.get(s.id)).filter(Boolean) as ProbeResult[]
}

// ---------- tokens 名冊（identity → id / issued_at；絕不回傳 token 值） ----------

export function loadRoster(s: ServiceDef): { id: string; display_name: string; issued_at: string }[] {
  if (!s.tokensPath || !existsSync(s.tokensPath)) return []
  try {
    const j = JSON.parse(readFileSync(s.tokensPath, 'utf8'))
    const arr: any[] = Array.isArray(j) ? j : Array.isArray(j.tokens) ? j.tokens : []
    return arr.map(t => ({ id: String(t.id ?? ''), display_name: String(t.display_name ?? t.id ?? ''), issued_at: String(t.issued_at ?? '') }))
  } catch {
    return []
  }
}

// ---------- 排程 ----------

export function startCollectors(opts: { probeEveryMs: number; ingestEveryMs: number }) {
  const tick = async () => {
    try {
      ingestAuditLogs()
      scanPipelineRuns()
      scanAgentTraces()
    } catch (err) {
      console.error(`ingest tick failed: ${err}`)
    }
  }
  void tick()
  setInterval(tick, opts.ingestEveryMs)
  void probeAll()
  setInterval(() => void probeAll(), opts.probeEveryMs)
}

export { db }
