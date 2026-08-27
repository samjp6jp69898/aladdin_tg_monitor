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
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
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

/**
 * 讀 <key>.triggered-by.json sidecar（見 spawn-create-mr.ts / spawn-demand-
 * pipeline.ts 寫入處）——只在 Telegram 認領觸發時存在，人工終端機跑
 * /create-mr、自動重試、tg-monitor 手動重試按鈕都不會有這份檔案，回傳 null
 * 是預期情況、不是錯誤。
 */
function readTriggeredBy(key: string): string | null {
  try {
    const raw = readFileSync(join(DISPATCHER_LOG_DIR, `${key}.triggered-by.json`), 'utf8')
    const parsed = JSON.parse(raw) as { name?: string }
    return parsed.name || null
  } catch {
    return null
  }
}

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
      // 只認 dispatcher spawn 的 wrapper 本體：`bash -c <script> run-create-mr <ticket> <stdout> [resume]`
      // （位置參數在命令列最末端）。不能只比對子字串，否則 grep / 人工 shell 的命令列也會中。
      // 尾端可選的字面 `resume`（2026-08-26）：spawn-create-mr.ts 的 $3 只有
      // {'resume', ''} 兩個值——2026-08-26 實際踩過：加了 resume 之後這條 regex
      // 沒跟上，resume run 全部掃不到，被 scanPipelineRuns 誤當「已結束」秒判
      // outcome=empty，取消/防重複觸發也一起失明。
      let mm = /^bash -c [\s\S]*\brun-create-mr\s+([A-Z]+-\d+)\s+(\S+?)(?:\s+resume)?\s*$/.exec(cmd)
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

/**
 * 雙格式事件解析（2026-08-26）：bug pipeline 的 stdout 舊格式是
 * --output-format json 的單一 JSON 陣列（結束才 flush）；新格式是
 * stream-json 的 JSONL（逐行即時落盤）。先試整檔 JSON（歷史 log），失敗改
 * 逐行——單行壞掉（執行中讀到寫一半的尾行、timeout 砍斷）跳過該行即可。
 * 完全解析不出任何 event → null。
 */
export function parseClaudeEvents(txt: string): any[] | null {
  const t = txt.trim()
  if (!t) return null
  try {
    const j = JSON.parse(t)
    return Array.isArray(j) ? j : [j]
  } catch {}
  const events: any[] = []
  for (const line of t.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  return events.length ? events : null
}

function guessOutcome(stdoutPath: string): string {
  // 舊格式最後一個元素、新格式最後一行通常是 type=result（見 parseClaudeEvents）
  try {
    const txt = readFileSync(stdoutPath, 'utf8').trim()
    if (!txt) return 'empty'
    const events = parseClaudeEvents(txt)
    if (!events) return 'non-json'
    const last = events.findLast((e: any) => e?.type === 'result') ?? events[events.length - 1]
    if (last?.subtype) return String(last.subtype)
    if (last?.is_error) return 'error'
    return 'done'
  } catch {
    return 'non-json'
  }
}

// spawn-create-mr.ts 的 WRAPPER_SCRIPT 目前設定 `timeout 5400`（90 分鐘）——
// 兩個 repo 各自獨立、沒有 import 關係，這裡只能複製常數，改動時要同步調整。
const CREATE_MR_TIMEOUT_SECONDS = 5400

const POST_RUN_NOTIFY_LOG = join(DISPATCHER_LOG_DIR, 'post-run-notify.log')

/**
 * post-run-notify.ts 的 main() 不管 shouldNotify 結果都會先 log 一行
 * `<ISO ts> <ticket> classification=<...> exitCode=<...>`，涵蓋 classify-result.ts
 * 的全部七種分類（含 2026-08-25 新增的 timeout）——比 guessOutcome() 單看 stdout
 * 準確：stdout 為空時 guessOutcome 只能猜成籠統的 'empty'，區分不出「逾時被砍」
 * 跟「其他 infra 層失敗」；這裡直接讀權威分類結果，guessOutcome 降級為找不到
 * log 行時（例如這支 log 上線前的歷史紀錄）的後備猜測。
 */
function readClassification(ticket: string, startedAt: string, nextStart: string | null): { classification: string; loggedAt: string } | null {
  if (!existsSync(POST_RUN_NOTIFY_LOG)) return null
  let found: { classification: string; loggedAt: string } | null = null
  const re = new RegExp(`^(\\S+Z) ${ticket} classification=(\\S+) exitCode=(\\S+)$`)
  for (const line of readFileSync(POST_RUN_NOTIFY_LOG, 'utf8').split('\n')) {
    const m = re.exec(line)
    if (!m) continue
    if (m[1] < startedAt) continue
    if (nextStart && m[1] >= nextStart) break
    // exitCode=124 直接判定 timeout，不信任 log 行裡的 classification 字面值：
    // 2026-08-25 以前 post-run-notify.ts 的 classify-result.ts 還沒把 timeout
    // 從 infra_failure 拆出來，舊 log 行寫的是 infra_failure，但 exitCode 這欄
    // 從一開始就忠實記錄了 124，用它回推比相信當時寫下的分類字串更準確。
    found = { loggedAt: m[1], classification: m[3] === '124' ? 'timeout' : m[2] }
  }
  return found
}

const TRACKER_SH = '/Users/user/aladdin/scripts/tracker.sh'
// classify-result.ts 的 NEEDS_NOTIFY 集合（複製，見 CREATE_MR_TIMEOUT_SECONDS
// 同一則註解——兩個 repo 各自獨立、無 import 關係）：這幾種分類代表 claude -p
// 這次執行本身沒有走到正常出口，但票本身完全可能事後被人工/其他 agent 補跑完成。
const UNRESOLVED_OUTCOMES = new Set(['skipped', 'timeout', 'infra_failure', 'cli_failure', 'unknown_failure'])

/**
 * 把 tracker.sh 的 `YYYY-MM-DD HHMM` 完成時間欄轉成 ISO（本機時區，跟
 * fileTsToIso 的輸入來源一致，都是本機當下時間，不需要額外校正時區）。
 */
function trackerCompletedAtToIso(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})$/.exec(s.trim())
  if (!m) return null
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`).toISOString()
}

/**
 * 這一次 claude -p 執行本身沒有跑到正常出口（timeout / infra_failure / …），
 * 但票可能後續被人工或另一個 agent 補跑完（例：FAQ-4723 2026-08-25——背景
 * 流程被 60 分鐘 timeout 砍斷，之後人工派 drive-uploader-mr + mr-pusher 把
 * 剩下的步驟做完，tracker 最終還是 done）。單看這次 process 的 log 只能說
 * 「這次執行 timeout」，不能說「這張票沒解決」——兩者是不同的事實，這裡把
 * tracker.sh 的終態當更晚、更權威的事實來源，覆蓋顯示用的 outcome。
 *
 * 只在 tracker 完成時間**晚於**這次執行原本的 finishedAt 時才覆蓋（避免把
 * 更早、不相關的一次 done 誤蓋到這次執行上）；tracker 仍是 pending/rerun/
 * in_progress（代表還沒被接手處理）時不覆蓋，如實顯示原本的失敗分類。
 */
function reconcileWithTracker(ticket: string, outcome: string, finishedAt: string): { outcome: string; finishedAt: string } {
  if (!UNRESOLVED_OUTCOMES.has(outcome)) return { outcome, finishedAt }
  const tracker = readTrackerStatus(ticket) // 只在 collector tick 呼叫，安全（見該函式註解）
  if (!tracker || !tracker.completedAt || tracker.completedAt <= finishedAt) return { outcome, finishedAt }
  if (tracker.status === 'done') return { outcome: 'recovered', finishedAt: tracker.completedAt }
  if (tracker.status === 'failed') return { outcome: 'failed（人工判定）', finishedAt: tracker.completedAt }
  if (tracker.status === 'needs_qa') return { outcome: 'needs_qa_clarification（人工判定）', finishedAt: tracker.completedAt }
  return { outcome, finishedAt }
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
    upsertRun(key, kind, ticket, startedAt, stdoutPath, stderrPath, readTriggeredBy(key))
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
          // Bug pipeline：優先用 post-run-notify.log 的權威分類（見
          // readClassification 註解）；找不到 log 行才退回 stdout 猜測。
          const nextStart = bugStarts.get(ticket)?.find(t => t > startedAt) ?? null
          const cls = readClassification(ticket, startedAt, nextStart)
          let finishedAt: string
          let outcome: string
          if (cls) {
            outcome = cls.classification
            // timeout 的 stdout 在被砍斷時通常什麼都沒 flush 到，檔案 mtime
            // 只落在行程「開始」附近（open 時建立），拿來當結束時間會把耗時
            // 算成接近 0；改用「開始時間 + 設定的 timeout 上限」還原真實耗時。
            finishedAt =
              cls.classification === 'timeout'
                ? new Date(new Date(startedAt).getTime() + CREATE_MR_TIMEOUT_SECONDS * 1000).toISOString()
                : cls.loggedAt
          } else {
            const st = statSync(stdoutPath)
            finishedAt = st.mtime.toISOString()
            outcome = guessOutcome(stdoutPath)
          }
          finishRun(key, finishedAt, outcome)
          ingestBugStdout(ticket, startedAt, stdoutPath)
        }
      } catch {}
    } else if (kind === 'bug') {
      // 執行中的 bug run（2026-08-26，stream-json 之後才有意義）：JSONL 逐行
      // 落盤，執行中就能收出即時的 agent 摘要（ended_at=null → UI 顯示
      // 進行中）；結束後上面的 finish 分支會用同一個 path upsert 蓋上最終值。
      // 舊格式（--output-format json）執行中 size=0，這裡自然 no-op。
      try {
        ingestBugStdout(ticket, startedAt, stdoutPath, true)
      } catch {}
    }
  }
  reconcileStaleOutcomes()
}

/**
 * 補跑（人工或另一個 agent 事後把 timeout/failed 的票做完）通常發生在
 * process 結束之後、tracker 更新之前——finishRun 那一刻 tracker 多半還是
 * in_progress，reconcileWithTracker 在那個時間點查不到東西。這裡每個
 * ingest tick 都對「最近 6 小時內結束、目前仍是未解決分類」的 bug pipeline
 * 重新查一次 tracker，一旦 tracker 給出更晚的終態時間就覆蓋 outcome/
 * finished_at；查詢天生會隨結果被 reconcileWithTracker 改掉分類（不再落在
 * UNRESOLVED_OUTCOMES）而自然停止，不需要額外的重試上限。6 小時窗口只是
 * 避免對「已經確定沒人再處理」的舊票每 3 秒重複 spawn tracker.sh，不是正確性
 * 邊界（超過窗口後續若真的被補跑完成，畫面只是繼續顯示原本的失敗分類，不是
 * 顯示錯誤資訊）。
 */
function reconcileStaleOutcomes(): void {
  const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString()
  const placeholders = [...UNRESOLVED_OUTCOMES].map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT key, ticket, finished_at, outcome FROM pipeline_runs WHERE kind = 'bug' AND finished_at IS NOT NULL AND finished_at >= ? AND outcome IN (${placeholders})`)
    .all(cutoff, ...UNRESOLVED_OUTCOMES) as { key: string; ticket: string; finished_at: string; outcome: string }[]
  const updateStmt = db.prepare('UPDATE pipeline_runs SET outcome = ?, finished_at = ? WHERE key = ?')
  for (const r of rows) {
    const resolved = reconcileWithTracker(r.ticket, r.outcome, r.finished_at)
    if (resolved.outcome !== r.outcome) updateStmt.run(resolved.outcome, resolved.finishedAt, r.key)
  }
}

// ---------- 2a) bug pipeline 階段檢核表 ----------
//
// create-mr.md 的 Step 1～6 各自落地一份 obsidian/Debug/{ticket}/{ticket}-*.md，
// 檔案存在＋mtime 就是「這步做到哪」最可靠的旁證——跟 scripts/pipeline-status.sh
// 讀的是同一組檔案、同一套判準（唯讀，不新增別的事實來源）。單一 claude -p
// session 內部的 Step 用 Task 工具彼此呼叫子 agent，不是各自獨立的 OS
// process，所以真正精確的「哪個 Step 現在正在跑」拿不到；這裡只能做到
// 「哪些 Step 的產物已經存在」，跟原本 pipeline-status.sh 的能力上限一樣。
const DEBUG_DIR = '/Users/user/aladdin/obsidian/Debug'

export type BugStage = {
  key: string
  label: string
  // reused（2026-08-26，重試改續跑語意後新增）：產物檔存在但 mtime 早於本輪
  // run 開始——resume 模式沿用上一輪產物、本輪直接跳過該階段時就是這個樣子。
  // 對「整張全跑」的 run 這代表「舊產物還在、本輪尚未重做到這步」，之後被
  // 覆寫時會自然轉成 done；兩種情況都如實顯示「檔案在，但不是本輪產的」。
  // running（2026-08-26）：只出現在「最新一次且仍在跑」的 run——從 pipeline
  // 的 session transcript 推定 manager 此刻派工中的 agent（見
  // inferCurrentBugStage），是唯一即時的「正在跑哪一步」訊號。
  status: 'done' | 'reused' | 'pending' | 'running'
  started_at: string | null
  finished_at: string | null
  detail?: string | null
}

function fileMtimeIso(p: string): string | null {
  try {
    return statSync(p).mtime.toISOString()
  } catch {
    return null
  }
}

// ---------- 2a') 進行中 run 的「目前執行階段」推定（2026-08-26）----------
//
// Debug 產物的 mtime 只能事後看「落地了什麼」，標不出此刻正在跑哪一步。
// 唯一即時且新舊 stdout 格式都適用的訊號是 pipeline 那個 claude -p session
// 的 transcript（~/.claude/projects/<cwd-slug>/<session>.jsonl，逐事件即時
// append；subagent 對話不寫進主檔，實測 28 分鐘的 run 主檔僅 221KB）：
// manager 每次派工是一筆 name=Agent 的 tool_use（input.subagent_type 指名
// agent），對應的 tool_result 回來前就是「正在跑」。首行 queue-operation 的
// content 即 -p prompt（`/create-mr:create-mr <ticket> ...`），用它錨定辨識
// 是哪張票的 session，不會誤抓同 cwd 的互動式 session。
const TRANSCRIPT_DIR = '/Users/user/.claude/projects/-Users-user-aladdin' // pipeline cwd=/Users/user/aladdin 的固定 slug
const BUG_AGENT_STAGE: Record<string, string> = {
  'bug-report-and-spec-analyst': 'analytics',
  'cqa-grounder': 'grounding',
  'bug-tracer': 'analysis-notes',
  'bug-tracer-with-callgraph': 'analysis-notes',
  'bug-fixer': 'fixer',
  'bug-fixer-with-tests': 'fixer',
  'solution-reviewer': 'review',
  'adversarial-solution-reviewer': 'review',
  'tdd-fidelity-reviewer': 'review',
  'drive-uploader': 'solution',
  'drive-uploader-mr': 'solution',
  'mr-pusher': 'exit',
}
const BUG_STAGE_ORDER = ['analytics', 'grounding', 'analysis-notes', 'worktree', 'fixer', 'review', 'solution', 'exit']

export type CurrentBugStage = { stageKey: string; agent: string; since: string }

// path 找到才快取（找不到不快取：spawn 後 transcript 建檔可能比第一次查詢晚幾秒）
const transcriptPathCache = new Map<string, string>()
// 逐檔增量掃描狀態：只讀新 append 的部分，pending = 已派工未回結果的 tool_use
const transcriptScanState = new Map<string, { offset: number; carry: string; pending: Map<string, { agent: string; ts: string }> }>()

function findPipelineTranscript(ticket: string, runStartedAt: string): string | null {
  const cacheKey = `${ticket}|${runStartedAt}`
  const hit = transcriptPathCache.get(cacheKey)
  if (hit) return hit
  try {
    const runStart = Date.parse(runStartedAt)
    for (const f of readdirSync(TRANSCRIPT_DIR)) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(TRANSCRIPT_DIR, f)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.mtime.getTime() < runStart) continue // 這次 run 開始後就沒寫過的檔案必不是本 run
      const fd = openSync(p, 'r')
      let head = ''
      try {
        const buf = Buffer.alloc(2048)
        head = buf.toString('utf8', 0, readSync(fd, buf, 0, 2048, 0))
      } finally { closeSync(fd) }
      if (head.includes(`/create-mr:create-mr ${ticket}`)) {
        transcriptPathCache.set(cacheKey, p)
        return p
      }
    }
  } catch {}
  return null
}

export function inferCurrentBugStage(ticket: string, runStartedAt: string): CurrentBugStage | null {
  const path = findPipelineTranscript(ticket, runStartedAt)
  if (!path) return null
  let st
  try { st = statSync(path) } catch { return null }
  if (st.size > 100 * 1024 * 1024) return null // 異常肥大就放棄推定，不拖垮輪詢
  let state = transcriptScanState.get(path)
  if (!state) { state = { offset: 0, carry: '', pending: new Map() }; transcriptScanState.set(path, state) }
  if (st.size < state.offset) { state.offset = 0; state.carry = ''; state.pending.clear() } // 檔案被截斷重置
  if (st.size > state.offset) {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(st.size - state.offset)
      const n = readSync(fd, buf, 0, buf.length, state.offset)
      state.offset += n
      const text = state.carry + buf.toString('utf8', 0, n)
      const lastNl = text.lastIndexOf('\n')
      state.carry = lastNl >= 0 ? text.slice(lastNl + 1) : text
      for (const line of (lastNl >= 0 ? text.slice(0, lastNl) : '').split('\n')) {
        // 便宜前置過濾：絕大多數行連 parse 都不用
        if (!line || (!line.includes('"tool_use"') && !line.includes('"tool_result"'))) continue
        let e: any
        try { e = JSON.parse(line) } catch { continue }
        if (e?.isSidechain) continue
        const content = e?.message?.content
        if (!Array.isArray(content)) continue
        for (const b of content) {
          if (b?.type === 'tool_use') {
            if ((b.name === 'Agent' || b.name === 'Task') && typeof b.input?.subagent_type === 'string') {
              state.pending.set(b.id, { agent: b.input.subagent_type, ts: e.timestamp ?? '' })
            } else if (b.name === 'Bash' && typeof b.input?.command === 'string' && b.input.command.includes('setup-worktree.sh')) {
              state.pending.set(b.id, { agent: 'setup-worktree.sh', ts: e.timestamp ?? '' })
            }
          } else if (b?.type === 'tool_result' && b.tool_use_id) {
            state.pending.delete(b.tool_use_id)
          }
        }
      }
    } finally { closeSync(fd) }
  }
  // 未回結果的派工＝此刻正在跑；平行派工（Step 2 兩位 / Step 6 三位）取
  // pipeline 順序最深的一個當代表（同屬一個階段時結果相同）。
  let best: CurrentBugStage | null = null
  for (const { agent, ts } of state.pending.values()) {
    const key = agent === 'setup-worktree.sh' ? 'worktree' : BUG_AGENT_STAGE[agent]
    if (!key) continue
    if (!best || BUG_STAGE_ORDER.indexOf(key) > BUG_STAGE_ORDER.indexOf(best.stageKey)) best = { stageKey: key, agent, since: ts || runStartedAt }
  }
  return best
}

/**
 * 每個 stage 的 started_at 沿用「前一個已完成 stage 的 finished_at」（沒有
 * 前一個就用 run.started_at）——這是本來就沒有更細粒度時間戳可用時最合理的
 * 估計，不是精確量測；跟 finished_at（真實檔案 mtime）性質不同，UI 顯示時
 * 要能分辨。
 */
export function computeBugStages(ticket: string, runStartedAt: string, tracker: { status: string; completedAt: string | null } | null, running = false): BugStage[] {
  const dir = join(DEBUG_DIR, ticket)
  // Debug/{ticket} 產物跨同一張票的多次執行共用（重試不會清掉上一輪留下的
  // 檔案）。只認「這次 run 開始之後才更新」的 mtime，避免「重試」後新 run
  // 才剛開始，卻讀到上一輪留下的舊檔案，誤判成本輪已完成、甚至讓
  // finished_at 早於 started_at 顯示出負數耗時。
  const rawAt = (file: string) => fileMtimeIso(join(dir, `${ticket}-${file}`))
  const at = (file: string) => {
    const m = rawAt(file)
    return m && m >= runStartedAt ? m : null
  }
  const reviewFiles = ['reviewer-report.md', 'adversarial-review.md', 'tdd-fidelity-review.md']
  const reviewMtimes = reviewFiles.map(f => at(f)).filter((x): x is string => x !== null)

  const defs: { key: string; label: string; finishedAt: string | null; reused?: boolean }[] = [
    { key: 'claim', label: 'Step 0.1 認領工單', finishedAt: runStartedAt },
    { key: 'analytics', label: 'Step 1 Bug 分析', finishedAt: at('analytics.md'), reused: !!rawAt('analytics.md') },
    { key: 'spec', label: 'Step 1 企劃規格比對', finishedAt: at('spec.md'), reused: !!rawAt('spec.md') },
    { key: 'grounding', label: 'Step 2a CQA 實證 Grounding', finishedAt: at('grounding.md'), reused: !!rawAt('grounding.md') },
    // 注意：analysis-notes.md 不只 tracer 會寫——Step 5 fixer 會往同一份文件追加
    // 「TDD 紀錄」「重審回應」段（tdd-fidelity-reviewer 依它驗 RED→GREEN），所以
    // resume 續跑跳過 tracer 時這列仍可能因 fixer 更新 mtime 而顯示 done：語意是
    // 「本輪有更新這份文件」，不保證是 tracer 本人。mtime 檢核表分不出作者。
    { key: 'analysis-notes', label: 'Step 2b 根因分析（Tracer）', finishedAt: at('analysis-notes.md'), reused: !!rawAt('analysis-notes.md') },
    // Step 4 的落地證據是 worktree 裡的 bootstrap.log（setup-worktree.sh 產出，
    // 不在 Debug/ 目錄）；run 結束後 cleanup-worktree.ts 會把它搬走，所以這列
    // 只在執行中（或殘留未清）時有訊號——歷史 run 顯示 pending 屬正常。
    // Step 5（fixer）刻意沒有列：它不產出獨立文件，commit 與 reset 都動同一個
    // branch ref，沒有便宜且不誤判的完成訊號（見 pd-stages-note 的 UI 說明）。
    { key: 'worktree', label: 'Step 4 隔離環境（worktree + bootstrap）', finishedAt: (() => { const m = fileMtimeIso(join('/Users/user/aladdin/worktrees', ticket, 'bootstrap.log')); return m && m >= runStartedAt ? m : null })(), reused: !!fileMtimeIso(join('/Users/user/aladdin/worktrees', ticket, 'bootstrap.log')) },
    { key: 'review', label: 'Step 6 三重平行審查', finishedAt: reviewMtimes.length === reviewFiles.length ? reviewMtimes.sort().slice(-1)[0]! : null, reused: reviewFiles.every(f => rawAt(f) !== null) },
    { key: 'solution', label: 'Solution 彙整', finishedAt: at('solution.md'), reused: !!rawAt('solution.md') },
    {
      key: 'exit',
      label: 'Step 7/8 開 MR + Notion 回寫 + tracker 終態',
      finishedAt: tracker && tracker.status !== 'pending' && tracker.status !== 'rerun' && tracker.status !== 'in_progress' ? tracker.completedAt : null,
    },
  ]

  const stages: BugStage[] = []
  let prevFinished = runStartedAt
  for (const d of defs) {
    // 重做迴圈（審查否決→tracer/fixer 重跑）會讓「排在前面的階段」比後面的
    // 更晚完成——此時「上一階段完成時間」不再是合理的開始時間估計（曾算出
    // 負耗時），開始時間改記 null（UI 顯示 -），prevFinished 也只單調前進。
    const outOfOrder = d.finishedAt !== null && d.finishedAt < prevFinished
    stages.push({
      key: d.key,
      label: d.label,
      status: d.finishedAt ? 'done' : d.reused ? 'reused' : 'pending',
      started_at: outOfOrder ? null : prevFinished,
      finished_at: d.finishedAt,
    })
    if (d.finishedAt && d.finishedAt > prevFinished) prevFinished = d.finishedAt
  }
  // 進行中的 run：從 session transcript 推定此刻在跑哪一步，把該列標成
  // running（覆蓋 done/reused——例如審查否決後重跑 review 時，舊報告的 done
  // 會被即時的 running 蓋掉）。Step 5（fixer）沒有產物列，動態插一列。
  if (running) {
    const cur = inferCurrentBugStage(ticket, runStartedAt)
    if (cur) {
      if (cur.stageKey === 'fixer') {
        const idx = stages.findIndex(s => s.key === 'review')
        stages.splice(idx < 0 ? stages.length : idx, 0, { key: 'fixer', label: 'Step 5 TDD 修復（Fixer）', status: 'running', started_at: cur.since, finished_at: null, detail: cur.agent })
      } else {
        const s = stages.find(x => x.key === cur.stageKey)
        if (s) { s.status = 'running'; s.started_at = cur.since; s.finished_at = null; s.detail = cur.agent }
      }
    }
  }
  return stages
}

/** 解析 tracker.sh row 的單行輸出，回傳目前 status 與（若有）完成時間的 ISO 字串。 */
function parseTrackerRow(row: string): { status: string; completedAt: string | null } | null {
  const cols = row.trim().split('|').map(s => s.trim()).filter((_, i, arr) => !(i === 0 || i === arr.length - 1))
  if (!cols[3]) return null
  return { status: cols[3], completedAt: cols[5] ? trackerCompletedAtToIso(cols[5]) : null }
}

/** 只准在 collector tick（scanPipelineRuns 系列）裡呼叫——見檔頭第 3) 節同一則
 * 「handler 內 spawnSync 會 segfault」的既有踩坑，這裡用同步版本换來 tick
 * 內程式碼可以線性寫、不用整條 async 化，代價是呼叫端要自己保證不在 HTTP
 * request handler 裡叫它。*/
export function readTrackerStatus(ticket: string): { status: string; completedAt: string | null } | null {
  try {
    return parseTrackerRow(execFileSync('bash', [TRACKER_SH, 'row', ticket], { encoding: 'utf8', timeout: 10_000 }))
  } catch {
    return null
  }
}

/** HTTP request handler 專用的非同步版本（見 server.ts /api/pipelines/run、
 * /api/pipelines/retry）——同一支 tracker.sh，只是換成 execFile（非 *Sync），
 * 避免本檔第 3) 節記載的「Bun 1.2.9 handler 內 *Sync* spawn 遇客戶端中斷會
 * segfault」那個既有踩坑；tracker.sh 本身有時要等自旋鎖（最壞 5 秒），用
 * async 版本才不會卡住整個 event loop 讓其他請求也跟著頓住。 */
export async function readTrackerStatusAsync(ticket: string): Promise<{ status: string; completedAt: string | null } | null> {
  try {
    const { stdout } = await execFileAsync('bash', [TRACKER_SH, 'row', ticket], { encoding: 'utf8', timeout: 10_000 })
    return parseTrackerRow(stdout)
  } catch {
    return null
  }
}

// classify-result.ts 的 NEEDS_NOTIFY／UNRESOLVED_OUTCOMES 加上 reconcileWithTracker
// 產生的「（人工判定）」後綴——純字串判斷、不做任何 I/O，供列表頁一次算出
// 「這一列要不要顯示重試按鈕」，跟 /api/pipelines/retry 的真正權限判斷（那邊
// 即時查一次 tracker.sh，見 server.ts）分開：這裡只保證「大致準」，真正能不
// 能重試以送出當下 retry 端點的即時檢查為準——這是 review 2026-08-25 發現
// 「前端自己另外維護一份判斷、跟後端不同步」問題後的修法：現在前後端共用同
// 一個判斷式，不會再各自漂移。
const RETRYABLE_OUTCOME_PREFIXES = new Set(['timeout', 'failed', 'infra_failure', 'cli_failure', 'unknown_failure', 'skipped'])
export function isBugOutcomeRetryable(outcome: string | null): boolean {
  if (!outcome) return false
  return RETRYABLE_OUTCOME_PREFIXES.has(outcome.replace(/（.*）$/, '').trim())
}

// ---------- 2b) agent traces ----------
//
// telegram-dispatcher/lib/pipeline-runner/claude-exec.ts 帶 trace 選項時，每次
// claude -p 呼叫落地一份 logs/agent-traces/<ticket>/<startedAt>-<stage>.json：
// { ticket, stage, startedAt, endedAt, cwd, args, prompt, events | error }。
// events 是 claude -p --output-format json 的完整事件陣列（system init /
// assistant / user(tool_result) / result）。這裡只抽摘要進 agent_runs；完整
// 對話由 /api/agent-trace 現讀檔案。Bug pipeline 的 <ticket>.<ts>.stdout.log
// 是同樣的事件物件，視為單一 stage 'create-mr' 一併收進來——格式上
// 2026-08-26 前是單一 JSON 陣列（結束才 flush），之後是 stream-json 的
// JSONL（逐行即時落盤，執行中也收得到），parseClaudeEvents 雙格式通吃。

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

/** Bug pipeline：把 stdout.log（舊格式事件陣列 / 新格式 JSONL，見
 * parseClaudeEvents）當成單一 stage 收進 agent_runs。2026-08-26 起 stream-json
 * 逐行落盤，執行中也有內容可收（running=true 時 ended_at 記 null，UI 顯示
 * 進行中）；舊格式 run 執行中 size=0，行為同以往（結束才收）。上限 50MB：
 * 這裡每個 ingest tick 都會整檔重讀重解析（mtime 變了就解析），異常肥大的
 * log 不值得拖垮 collector，超限就放棄即時摘要、留給結束後人工看檔案。 */
function ingestBugStdout(ticket: string, startedAt: string, stdoutPath: string, running = false) {
  try {
    const st = statSync(stdoutPath)
    if (st.size === 0 || st.size > 50 * 1024 * 1024) return
    const mtime = st.mtime.toISOString()
    // 防重複解析的 guard 值把 running 狀態編進去：執行中存 `<mtime>~live`，
    // 定稿存純 mtime。若兩邊共用純 mtime，會踩到「claude 剛把整包 stdout 寫完、
    // wrapper 的 EXIT trap 還在跑（ps 仍看得到）」的空窗——live 路徑先用最終
    // mtime 寫入 ended_at=null 的列，之後 finish 路徑看 mtime 相同直接跳過，
    // Agent 流程永遠卡在「進行中」（2026-08-26 FAQ-4743 實際踩過）。
    const guard = running ? `${mtime}~live` : mtime
    if (agentRunMtime(stdoutPath) === guard) return
    const events = parseClaudeEvents(readFileSync(stdoutPath, 'utf8'))
    if (!events) return
    const sum = summarizeEvents(events)
    upsertAgentRun({ path: stdoutPath, ticket, kind: 'bug', stage: 'create-mr', started_at: startedAt, ended_at: running ? null : mtime, ...sum, file_mtime: guard })
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
      // cloudflared metrics /ready：{"status":200,"readyConnections":N,"connectorId":"..."}
      // readyConnections=0 代表行程活著但完全連不上 Cloudflare 邊緣，算 down
      // （見 telegram-dispatcher/lib/webhook-server/health-monitor.ts 同一套判準）。
      if (s.id === 'cloudflare-tunnel' && j) {
        const rc = j.readyConnections
        detail = `readyConnections=${rc ?? '?'}${j.connectorId ? ' · connector ' + String(j.connectorId).slice(0, 8) : ''}`
        if (typeof rc !== 'number' || rc <= 0) status = 'down'
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
