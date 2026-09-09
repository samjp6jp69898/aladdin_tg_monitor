// 資料蒐集（背景 tick，見 startCollectors）：
//  1) 掃 telegram-dispatcher/logs 的逐票 bug pipeline log 檔名，把三位
//     reviewer／final-adversarial-reviewer 的審查輪數餵給 mon_ui（見
//     persistReviewRounds／scanPipelineRuns）——sqlite 讀取面退役後
//     （2026-09-09，維護協議紅區項目 6），這是本節唯一剩下的職責；原本
//     audit.jsonl 稽核事件 tail、agent-traces 摘要、pipeline_runs/agent_runs
//     落地都已隨 sqlite 一併移除（mysql 側這些表由 telegram-dispatcher 另一套
//     完全獨立的寫入路徑產生，不是靠這裡的檔案掃描接力寫入）。
//     檔名規則見 spawn-create-mr.ts：<TICKET>.<ISO ts 以 - 取代 :.>.stdout.log
//     是否仍在跑：ps 裡還有 `run-create-mr <ticket>`
//  2) 探測各 port 存活（/health + lsof 拿 PID）→ 只在 up/down 翻轉時餵給
//     mysql（見 appendServiceStatusIfChanged）。

import { openSync, readSync, closeSync, statSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
import { SERVICES, DISPATCHER_LOG_DIR, BUG_LOCK_DIR, type ServiceDef } from './services.ts'
import {
  isMonitorDbEnabled,
  getMonitorPool,
  resolveRunId,
  resolveRunIdLocalOnly,
  writeCancelFlag,
  appendCancelFlagToSpool,
  appendStatusLogToSpool,
  appendHeartbeatToSpool,
  isoToMysqlDatetime3,
  readActiveMarker,
  deriveLegacyKey,
  RUNS_HOST,
  persistReviewRoundsToMonDb,
  forgetRoundsMonDbState,
  reconcileStaleOutcomesToMonDb,
} from './mon-db.ts'

// ---------- 2) pipeline runs ----------

const BUG_RE = /^([A-Z]+-\d+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.stdout\.log$/

/**
 * 讀 <key>.triggered-by.json sidecar（見 spawn-create-mr.ts / spawn-demand-
 * pipeline.ts 寫入處）——只在 Telegram 認領觸發時存在，人工終端機跑
 * /create-mr、自動重試、tg-monitor 手動重試按鈕都不會有這份檔案，回傳 null
 * 是預期情況、不是錯誤。
 * 2026-09-04：抽出 readTriggeredByRecord 承載完整 {name, email}，本函式改
 * 為薄封裝，行為對既有呼叫端（scanPipelineRuns）逐位元組不變——cancelPipeline
 * 的 W4b 六欄修復需要 email，不重寫一份讀檔邏輯。
 */
function readTriggeredByRecord(key: string, logDir: string = DISPATCHER_LOG_DIR): { name: string | null; email: string | null } | null {
  try {
    const raw = readFileSync(join(logDir, `${key}.triggered-by.json`), 'utf8')
    const parsed = JSON.parse(raw) as { name?: string; email?: string }
    return { name: parsed.name ?? null, email: parsed.email ?? null }
  } catch {
    return null
  }
}

function fileTsToIso(t: string): string {
  // 2026-08-21T01-23-16-901Z → 2026-08-21T01:23:16.901Z
  return t.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
}

/**
 * 2026-09-04：cancelPipeline() 的 W4b 六欄修復（見 impl-errata-g2.md 對應項）
 * ——抽成純函式方便單測，因為 cachedRunning 是私有狀態，只有真的呼叫
 * scanRunningPipelineProcs()（真 ps）才會填入，ingest.cancel.test.ts 因此測
 * 不到 isMonitorDbEnabled() 分支內的邏輯。
 *
 * extra 只有 kind==='bug' 時才是 stdout log 絕對路徑——demand 的 extra 是
 * assigneeEmail（見 scanRunningPipelineProcs 的 ps 正則、spawn-demand-
 * pipeline.ts 的 spawnDetachedProcess 呼叫第三個位置參數），deriveLegacyKey
 * 對這個輸入本來就回 null，以下欄位因此對 demand 維持既有的全 null 降級，
 * 不是本次修復新引入的缺口，也不會把 assigneeEmail 誤寫進 stdout_path。
 */
export function deriveCancelFlagFields(
  kind: 'bug' | 'demand',
  extra: string,
  legacyKey: string | null,
  logDir: string = DISPATCHER_LOG_DIR,
): {
  stdoutPath: string | null
  stderrPath: string | null
  startedAt: string | null
  triggerSource: 'telegram' | 'cli'
  triggeredByEmail: string | null
  triggeredByName: string | null
} {
  const stdoutPath = kind === 'bug' && legacyKey ? extra : null
  const stderrPath = stdoutPath ? stdoutPath.replace(/\.stdout\.log$/, '.stderr.log') : null
  let startedAt: string | null = null
  if (stdoutPath) {
    const m = BUG_RE.exec(stdoutPath.split('/').pop() ?? '')
    if (m) startedAt = fileTsToIso(m[2])
  }
  // 比照 spawn-create-mr.ts:434 的既有慣例：有 sidecar ⇒ 'telegram'，沒有 ⇒ 'cli'。
  const triggeredByRecord = legacyKey ? readTriggeredByRecord(legacyKey, logDir) : null
  return {
    stdoutPath,
    stderrPath,
    startedAt,
    triggerSource: triggeredByRecord ? 'telegram' : 'cli',
    triggeredByEmail: triggeredByRecord?.email ?? null,
    triggeredByName: triggeredByRecord?.name ?? null,
  }
}

export type RunningProc = { pid: number; etime: string; kind: 'bug' | 'demand'; ticket: string; extra: string }

// 只在 collector tick 裡呼叫（spawnSync）；request handler 一律讀 cachedRunning。
// Bun 1.2.9 實測：handler 內 spawnSync 遇到客戶端中斷請求會 segfault。
// 注意：這條與「ReadableStream/SSE 斷線 segfault」是兩個獨立踩坑——後者
// 2026-09-02 於 Bun 1.4.0 實測已修復（見 server.ts /api/log/since 註解），
// 本條（handler 內同步 spawn）未隨之驗證解除，繼續遵守。
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
      // 2026-09-08 起尾端多一個恆帶的 mode 位置參數（$3 = full|analysis|fix|reanalyze），
      // resume 退到 $4：`run-create-mr <ticket> <stdout> [mode] [resume]`。mode 群組寫
      // 可選以相容加 mode 之前就 spawn 的舊 wrapper。與 telegram-dispatcher 的
      // post-run-notify.ts RUN_CREATE_MR_PROC_RE、local-proc-scan.ts 同款正則，三處同步改。
      // mode 值域須與 telegram-dispatcher lib/pipeline-runner/bug-mode.ts BUG_MODES 同步
      // （兩個獨立 repo，不互相 import，改動要手動同步）。
      let mm = /^bash -c [\s\S]*\brun-create-mr\s+([A-Z]+-\d+)\s+(\S+?)(?:\s+(?:full|analysis|fix|reanalyze))?(?:\s+resume)?\s*$/.exec(cmd)
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

const CANCEL_FLAG_BUDGET_MS = 1000

export interface CancelPipelineResult {
  ok: boolean
  killed: number[]
  wrapperPid?: number
  reason?: string
  /** 以下三個欄位只在 isMonitorDbEnabled() 為 true 時才會出現（見 mon-db.ts）——
   * flag 關閉期完全不寫、不落 spool，回應形狀與遷移前逐位元組相同
   * （【G:MJ-G2】§6.4(2) 二擇一裁定）。 */
  runId?: string
  runIdResolvedBy?: string
  flagWritten?: boolean
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
 *
 * 監控 DB 化（plan-db-as-truth-v3.2.md §6.4(2) 修訂，【G:BL-G2】【G:MJ-G1】
 * 【G:MJ-G2】）：殺行程前 await 五段 run_id 解析＋W4a/W4b 旗標寫入，單一
 * 1000ms 預算涵蓋整段；逾時或任一步失敗仍照殺，只是旗標改落本機 spool（見
 * mon-db.ts 的 appendCancelFlagToSpool）並計 cancel_flag_deferred。
 * isMonitorDbEnabled()=false 時整段（步驟 2–4）完全跳過，行為與遷移前
 * 逐位元組相同（唯一差異是函式簽名變成 async）。
 */
export async function cancelPipeline(kind: 'bug' | 'demand', ticket: string): Promise<CancelPipelineResult> {
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

  let dbFields: { runId: string; runIdResolvedBy: string; flagWritten: boolean } | undefined

  if (isMonitorDbEnabled()) {
    // 步驟 3：本機解析，不佔預算（不需要 DB）。
    const marker = readActiveMarker(kind, ticket)
    const legacyKey = deriveLegacyKey(target.extra)
    const cancelRequestedAt = new Date().toISOString()

    // 2026-09-04（W4b 六欄真正接上，見 impl-errata-g2.md 對應項）：邏輯抽成
    // deriveCancelFlagFields（純函式，見上方定義與單測）。
    const { stdoutPath, stderrPath, startedAt, triggerSource, triggeredByEmail, triggeredByName } =
      deriveCancelFlagFields(kind, target.extra, legacyKey)

    // 步驟 4：單一 1000ms 預算涵蓋「解析 run_id ＋ 寫旗標」整段
    // （【G:MJ-G1】：mysql2 對已建立但對端卡死的連線沒有 per-query 逾時，
    // connectTimeout 管不到，必須整段用 Promise.race 包住）。
    const attempt = (async () => {
      const pool = getMonitorPool()
      const resolved = await resolveRunId(pool, {
        kind,
        ticket,
        target: { pid: target.pid, pidSet: order },
        legacyKey,
        stdoutPath: target.extra,
        marker,
      })
      const write = await writeCancelFlag(pool, {
        runId: resolved.runId,
        ticket,
        kind,
        cancelRequestedAt,
        resolvedBy: resolved.resolvedBy,
        legacyKey,
        stdoutPath,
        stderrPath,
        startedAt,
        triggerSource,
        triggeredByEmail,
        triggeredByName,
      })
      return { runId: resolved.runId, resolvedBy: resolved.resolvedBy, ok: write.ok }
    })()
    const budget = new Promise<null>(resolve => setTimeout(() => resolve(null), CANCEL_FLAG_BUDGET_MS))
    // attempt 若晚於 budget 完成，讓它繼續在背景跑完（不 unref/取消，mysql2 沒
    // 有內建 query cancel）；race 只決定這次回應要不要等它。
    const raced = await Promise.race([attempt.catch(() => null), budget])

    if (raced && raced.ok) {
      dbFields = { runId: raced.runId, runIdResolvedBy: raced.resolvedBy, flagWritten: true }
    } else {
      const local = resolveRunIdLocalOnly(kind, marker)
      try {
        appendCancelFlagToSpool({
          runId: local.runId,
          host: RUNS_HOST,
          ticket,
          kind,
          cancelRequestedAt,
          resolvedBy: local.resolvedBy,
          legacyKey,
        })
      } catch (err) {
        console.error(`cancelPipeline: 落 spool 失敗（${ticket}）：${err}`)
      }
      console.warn(`cancel_flag_deferred: ticket=${ticket} kind=${kind} runId=${local.runId}（旗標整段逾時/失敗，已落 spool）`)
      dbFields = { runId: local.runId, runIdResolvedBy: local.resolvedBy, flagWritten: false }
    }
  }

  // 步驟 5：既有 kill 流程，不論步驟 3/4 的結果如何，只要拿到 target 就一定執行。
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
  return { ok: true, killed, wrapperPid: target.pid, ...dbFields }
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

// spawn-create-mr.ts 的 WRAPPER_SCRIPT 目前設定 `timeout 10800`（180 分鐘，
// plan-db-as-truth-v3.2.md §9.0(G) 逐點對照表第 6 列）——兩個 repo 各自獨立、
// 沒有 import 關係，這裡只能複製常數，改動時要同步調整。
const CREATE_MR_TIMEOUT_SECONDS = 10800

const POST_RUN_NOTIFY_LOG = join(DISPATCHER_LOG_DIR, 'post-run-notify.log')

/**
 * post-run-notify.ts 的 main() 不管 shouldNotify 結果都會先 log 一行
 * `<ISO ts> <ticket> classification=<...> exitCode=<...>`——用來推算這次 run
 * 真正的結束時間（timeout 的 stdout 常常沒 flush，mtime 落在開始附近，見
 * scanPipelineRuns 呼叫處）。找不到 log 行時（例如這支 log 上線前的歷史紀錄）
 * 才退回 stdout 檔案 mtime 當後備猜測。
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

/**
 * 把 tracker.sh 的 `YYYY-MM-DD HHMM` 完成時間欄轉成 ISO（本機時區，跟
 * fileTsToIso 的輸入來源一致，都是本機當下時間，不需要額外校正時區）。
 */
function trackerCompletedAtToIso(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})$/.exec(s.trim())
  if (!m) return null
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`).toISOString()
}

// mon_ui 側的 rounds 寫入範圍（對抗審查 BLOCKING-1(a)）：scanPipelineRuns 的
// finish 分支對 DISPATCHER_LOG_DIR 底下**每一個**歷史 stdout log 每個 tick
// 都會呼叫 persistReviewRounds 一次（實測本機 40 個歷史 bug run，40 個都算得
// 出 counts），若不設界，mon_ui 這一段會對每個歷史 run 每 3 秒重打一次
// SELECT，且與 cancel 共用同一個 4 連線 pool（見 mon-db.ts 的
// connectionLimit:4 + waitForConnections:false）——這條背景路徑不能無界。
// 比照同檔 reconcileStaleOutcomes 既有的 6 小時窗：只有「執行中」（finishedAt
// 傳 null）或「6 小時內結束」的 run 才進 mon_ui 分支；更舊的歷史 run 的
// rounds 是靜態值，本來就不需要每 3 秒重試。
const ROUNDS_MON_DB_RECENT_WINDOW_MS = 6 * 3600 * 1000
export function isRoundsMonDbEligible(finishedAt: string | null): boolean {
  if (finishedAt === null) return true // 執行中：呼叫端本就只在 ps 快照命中時才會走到這裡，天然有界。
  return finishedAt >= new Date(Date.now() - ROUNDS_MON_DB_RECENT_WINDOW_MS).toISOString()
}

/**
 * mon_ui 側 rounds 寫入的掛載點（與 sqlite 側的 persistReviewRounds 分開匯
 * 出，讓「flag 開但 MON_DB_* 缺漏」這條 BLOCKING-2 迴歸路徑可以不依賴真實
 * transcript/檔案系統直接單元測試——counts 由呼叫端算好傳入，不在這裡重算）。
 *
 * 兩層防線對應對抗審查兩個 BLOCKING：
 *   - BLOCKING-1(a) 範圍限縮：`isRoundsMonDbEligible` 見上方常數註解。
 *   - BLOCKING-2：`getMonitorPool()` 是同步呼叫，MON_DB_* 任一環境變數缺漏
 *     時會同步 throw（見 mon-db.ts）；本函式外層沒有任何 try/catch 的呼叫者
 *     （running 分支 `:5xx` 不在任何 try 內）曾經因此讓整個 scanPipelineRuns
 *     中斷、reconcileStaleOutcomes 永遠不執行、scanAgentTraces 每 tick 被跳
 *     過——這裡整段自己包 try/catch，設定錯誤只 WARN，不炸呼叫端。
 *
 * fire-and-forget：呼叫端是同步函式、掛在 scanPipelineRuns 的同步迴圈裡，不
 * 能為了一次 DB 寫入拖住整個 collector tick；失敗只 WARN、不落 spool，rounds
 * 每個 ingest tick 都會重算，下一輪自然重試，自癒。
 */
export function persistReviewRoundsToMonDbGuarded(
  key: string,
  ticket: string,
  stdoutPath: string,
  finishedAt: string | null,
  counts: { reviewRounds: number; finalReviewRounds: number },
): void {
  if (!isMonitorDbEnabled()) return
  if (!isRoundsMonDbEligible(finishedAt)) {
    // 出窗（結束超過 6 小時）就順手清掉這個 key 在 mon-db.ts 四個模組級容器裡
    // 的記錄——那些容器原本只增不減，清掉之後上界與 6 小時窗一致（對抗審查
    // NB-1）。純記憶體操作，不建 pool、不做任何 I/O。
    forgetRoundsMonDbState(key)
    return
  }
  try {
    const pool = getMonitorPool()
    void persistReviewRoundsToMonDb(pool, {
      key,
      ticket,
      stdoutPath,
      reviewRounds: counts.reviewRounds,
      finalReviewRounds: counts.finalReviewRounds,
    }).catch(err => {
      console.warn(`mon-db: rounds 寫入例外（ticket=${ticket} key=${key}）：${err}`)
    })
  } catch (err) {
    // getMonitorPool() 的同步 throw（MON_DB_HOST/PORT/SCHEMA/USER/PASSWORD
    // 任一缺漏、或 PORT 非法）落在這裡——不往外冒，呼叫端（scanPipelineRuns
    // 的其餘 run、reconcileStaleOutcomes、collector tick 的其他職責）照常跑。
    console.warn(`mon-db: rounds 掛載失敗（ticket=${ticket} key=${key}，可能是 MON_DB_* 環境變數缺漏）：${err}`)
  }
}

/**
 * 把目前累計的審查輪數（見 getReviewRoundCounts）持久化到 mon_ui 側
 * （persistReviewRoundsToMonDbGuarded 內建自己的 last-written cache，值沒有
 * 進展就不重寫，見該函式與 persistReviewRoundsToMonDb 註解）。掛在
 * scanPipelineRuns 的既有 tick 上呼叫，run 執行中與剛結束的最後一次掃描都
 * 會呼叫到（見呼叫處註解），確保 run 結束、transcript 停止增長後，DB 欄位
 * 仍留著最終輪數。
 *
 * `finishedAt`：run 仍在執行中傳 `null`（呼叫端天然有界，見
 * `isRoundsMonDbEligible` 註解）；已結束傳該次執行的結束時間，用來把 mon_ui
 * 那段的寫入範圍限縮在最近 6 小時內（BLOCKING-1(a)）。
 */
function persistReviewRounds(key: string, ticket: string, startedAt: string, stdoutPath: string, finishedAt: string | null): void {
  const counts = getReviewRoundCounts(ticket, startedAt)
  if (!counts) return
  persistReviewRoundsToMonDbGuarded(key, ticket, stdoutPath, finishedAt, counts)
}

export function scanPipelineRuns() {
  if (!existsSync(DISPATCHER_LOG_DIR)) { cachedRunning = scanRunningPipelineProcs(); return }
  cachedRunning = scanRunningPipelineProcs()
  // 2026-08-28（FAQ-4768 連點兩次事故）：bug run 的歸戶改用 stdout 路徑——
  // wrapper 命令列的位置參數本來就帶著這次 run 專屬的 stdout log 路徑
  // （RunningProc.extra），比「同票最新一次才可能 running」精確：同一張票
  // 短時間內被重複觸發兩條時，舊邏輯會把還活著的舊 run 誤結案成 done、把
  // 已死的新 run 誤標成 running（實際踩過）。
  //
  // sqlite 讀取面退役後（2026-09-09），本函式只剩一個目的：把 bug pipeline
  // 的三位 reviewer／final-adversarial-reviewer 輪數餵給 mon_ui（見
  // persistReviewRounds）——demand pipeline 沒有對應的 mon_ui 寫入，因此只
  // 掃 bug 檔名。
  const runningBugPaths = new Set(cachedRunning.filter(r => r.kind === 'bug').map(r => r.extra))
  const files = readdirSync(DISPATCHER_LOG_DIR)
  const bugStarts = new Map<string, string[]>()
  for (const f of files) {
    const m = BUG_RE.exec(f)
    if (m) bugStarts.set(m[1], [...(bugStarts.get(m[1]) ?? []), fileTsToIso(m[2])].sort())
  }
  for (const f of files) {
    const m = BUG_RE.exec(f)
    if (!m) continue
    const [, ticket, ts] = m
    const key = f.replace(/\.stdout\.log$/, '')
    const stdoutPath = join(DISPATCHER_LOG_DIR, f)
    const startedAt = fileTsToIso(ts)
    if (!runningBugPaths.has(stdoutPath)) {
      try {
        // 優先用 post-run-notify.log 的權威分類（見 readClassification 註解）
        // 推算真正的結束時間；找不到 log 行才退回 stdout 檔案 mtime。
        const nextStart = bugStarts.get(ticket)?.find(t => t > startedAt) ?? null
        const cls = readClassification(ticket, startedAt, nextStart)
        const finishedAt = cls
          ? cls.classification === 'timeout'
            // timeout 的 stdout 在被砍斷時通常什麼都沒 flush 到，檔案 mtime
            // 只落在行程「開始」附近（open 時建立），拿來當結束時間會把耗時
            // 算成接近 0；改用「開始時間 + 設定的 timeout 上限」還原真實耗時。
            ? new Date(new Date(startedAt).getTime() + CREATE_MR_TIMEOUT_SECONDS * 1000).toISOString()
            : cls.loggedAt
          : statSync(stdoutPath).mtime.toISOString()
        // run 剛結束這一刻的最後一次掃描：transcript 可能在行程結束前一瞬間
        // 才寫下最後幾筆派工事件（例如最後一輪 reviewer 或 Step 6.5），確保
        // 這些也被算進去再持久化一次——之後 pending 就此不再增長，這是最後
        // 機會。
        persistReviewRounds(key, ticket, startedAt, stdoutPath, finishedAt)
      } catch {}
    } else {
      // 執行中的 bug run：跟 finish 分支共用同一個 persistReviewRounds（只
      // 增不減，值沒變就不寫），run 結束前每個 tick 都有機會把最新輪數落地。
      // finishedAt 傳 null：這個分支只有 ps 快照命中的執行中 run 才會走到
      // （天然有界，見 isRoundsMonDbEligible 註解），不受 BLOCKING-1(a) 的
      // 6 小時窗限制。
      persistReviewRounds(key, ticket, startedAt, stdoutPath, null)
    }
  }
  reconcileStaleOutcomesToMonDbGuarded()
}

/**
 * mon_ui 側的 tracker 遲到補跑修正（W6，a7-D39 缺口補位）：候選發現直接查
 * mysql、不依賴上面 sqlite 迴圈的結果——sqlite collector 退役後照常運作。
 * 兩側各自獨立掃描與寫入，過渡期同一張票兩邊各 spawn 一次 tracker.sh（6h 窗
 * ＋mysql 側 30s sweep 節流自限，退役後自然消失）。與 sqlite 側的三個刻意
 * 差異（裸值域、不覆蓋 finished_at、只碰 tier 2）見 mon-db.ts W6 區段檔頭。
 *
 * 結構比照 persistReviewRoundsToMonDbGuarded：flag 關閉零副作用；
 * getMonitorPool() 的同步 throw（MON_DB_* 缺漏）不炸呼叫端；fire-and-forget
 * 不拖 collector tick——tracker spawn 用 readTrackerStatusAsync（非 *Sync*，
 * 不佔 event loop），以參數注入避免 mon-db.ts 反向 import 本檔成環。
 */
export function reconcileStaleOutcomesToMonDbGuarded(): void {
  if (!isMonitorDbEnabled()) return
  try {
    const pool = getMonitorPool()
    void reconcileStaleOutcomesToMonDb(pool, readTrackerStatusAsync).catch(err => {
      console.warn(`mon-db: tracker reconcile 例外：${err}`)
    })
  } catch (err) {
    console.warn(`mon-db: tracker reconcile 掛載失敗（可能是 MON_DB_* 環境變數缺漏）：${err}`)
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
  // 審查輪數（2026-09-02，見 getReviewRoundCounts）：review 筆帶三位 reviewer
  // 的完整輪數（三位全被派工過才算一輪，全員 min）、final-review 筆帶
  // final-adversarial-reviewer 累計派工次數；0 或無值不帶這個欄位。與既有
  // detail 語意分開，detail 不因此改變。
  rounds?: number
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
  'final-adversarial-reviewer': 'final-review',
  'drive-uploader': 'solution',
  'drive-uploader-mr': 'solution',
  'mr-pusher': 'exit',
}
const BUG_STAGE_ORDER = ['analytics', 'grounding', 'analysis-notes', 'worktree', 'fixer', 'review', 'final-review', 'solution', 'exit']

export type CurrentBugStage = { stageKey: string; agent: string; since: string; reviewRound?: number }

// Step 6 三重平行審查的三位 reviewer——審查被否決會回 Step 5 fixer 重做，
// 再重新派工這三位，派工次數即「第幾輪」。
// 註：三位計數不一定同步前進——create-mr.md Step 6 合議規則（2026-09-02 查證
// HEAD deb1f79 line 266）：「任一位缺契約尾行 → 該位重派 1 次」是只重派那一位
// 的選擇性重派，只有 Step 6.5 FAILED 回 Step 5 重做後才是「三位全部重新派工」
// （line 300）。輪數語意（使用者 2026-09-02 裁定，取代同日稍早的 max 上界版）：
// **精確輪次＝三位全部都被派工過才算一輪**，即 rounds = 三位計數的 min（缺席
// 者計 0，必須遍歷本集合、不能只看有記錄的 key）。選擇性重派單獨一位不進位；
// 例：{A:2, B:2, C:1} → 1 輪。
const REVIEW_AGENTS = new Set(['solution-reviewer', 'adversarial-solution-reviewer', 'tdd-fidelity-reviewer'])

/** 精確完整輪次：REVIEW_AGENTS 全員計數的 min（缺席=0）。見上方語意註解。 */
function fullReviewRounds(counts: Map<string, number>): number {
  let min = Infinity
  for (const a of REVIEW_AGENTS) min = Math.min(min, counts.get(a) ?? 0)
  return Number.isFinite(min) ? min : 0
}
// Step 6.5 最終對抗性驗證——與三位 reviewer 是完全獨立的計數（見
// getReviewRoundCounts），不混入 reviewCounts。
const FINAL_REVIEW_AGENT = 'final-adversarial-reviewer'

// path 找到才快取（找不到不快取：spawn 後 transcript 建檔可能比第一次查詢晚幾秒）
const transcriptPathCache = new Map<string, string>()
// 逐檔增量掃描狀態：只讀新 append 的部分，pending = 已派工未回結果的 tool_use；
// reviewCounts = 三位 reviewer 各自累計被派工次數（不論有沒有回結果），只增不減，
// 用來推定審查跑到第幾輪；finalReviewCount = final-adversarial-reviewer 累計
// 被派工次數，獨立計數。
type TranscriptScanState = {
  offset: number
  carry: string
  pending: Map<string, { agent: string; ts: string }>
  reviewCounts: Map<string, number>
  finalReviewCount: number
}
const transcriptScanState = new Map<string, TranscriptScanState>()

function findPipelineTranscript(ticket: string, runStartedAt: string): string | null {
  const cacheKey = `${ticket}|${runStartedAt}`
  const hit = transcriptPathCache.get(cacheKey)
  if (hit) return hit
  try {
    const runStart = Date.parse(runStartedAt)
    // 2026-08-28（FAQ-4768 連點事故）：同一張票短時間內兩條 run 會有兩份
    // prompt 相同、mtime 都 >= runStart 的 transcript——舊版取「readdir 順序
    // 第一個命中」可能把死掉那條的 transcript 綁給活著的 run，階段推定從此
    // 全空。改成收集全部命中後取 mtime 最新的：活著的 run 的 transcript 持續
    // append、mtime 必然最新；單一 run 的正常情況行為不變。
    let best: { path: string; mtimeMs: number } | null = null
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
      if (head.includes(`/create-mr:create-mr ${ticket}`) && (!best || st.mtime.getTime() > best.mtimeMs)) {
        best = { path: p, mtimeMs: st.mtime.getTime() }
      }
    }
    if (best) {
      transcriptPathCache.set(cacheKey, best.path)
      return best.path
    }
  } catch {}
  return null
}

/**
 * 增量掃描單一 transcript 檔案，更新並回傳其累積掃描狀態（pending 派工、三位
 * reviewer 輪數、final-adversarial-reviewer 派工次數）。inferCurrentBugStage
 * 與 getReviewRoundCounts 共用這份邏輯與同一個 transcriptScanState 快取——
 * 呼叫順序不影響正確性，狀態只增不減、offset 只前進。
 */
function scanTranscriptState(path: string): TranscriptScanState | null {
  let st
  try { st = statSync(path) } catch { return null }
  if (st.size > 100 * 1024 * 1024) return null // 異常肥大就放棄推定，不拖垮輪詢
  let state = transcriptScanState.get(path)
  if (!state) { state = { offset: 0, carry: '', pending: new Map(), reviewCounts: new Map(), finalReviewCount: 0 }; transcriptScanState.set(path, state) }
  if (st.size < state.offset) { state.offset = 0; state.carry = ''; state.pending.clear(); state.reviewCounts.clear(); state.finalReviewCount = 0 } // 檔案被截斷重置
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
              if (REVIEW_AGENTS.has(b.input.subagent_type)) {
                state.reviewCounts.set(b.input.subagent_type, (state.reviewCounts.get(b.input.subagent_type) ?? 0) + 1)
              } else if (b.input.subagent_type === FINAL_REVIEW_AGENT) {
                state.finalReviewCount += 1
              }
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
  return state
}

export function inferCurrentBugStage(ticket: string, runStartedAt: string): CurrentBugStage | null {
  const path = findPipelineTranscript(ticket, runStartedAt)
  if (!path) return null
  const state = scanTranscriptState(path)
  if (!state) return null
  // 未回結果的派工＝此刻正在跑；平行派工（Step 2 兩位 / Step 6 三位）取
  // pipeline 順序最深的一個當代表（同屬一個階段時結果相同）。
  let best: CurrentBugStage | null = null
  for (const { agent, ts } of state.pending.values()) {
    const key = agent === 'setup-worktree.sh' ? 'worktree' : BUG_AGENT_STAGE[agent]
    if (!key) continue
    if (!best || BUG_STAGE_ORDER.indexOf(key) > BUG_STAGE_ORDER.indexOf(best.stageKey)) best = { stageKey: key, agent, since: ts || runStartedAt }
  }
  if (best?.stageKey === 'review') {
    // 精確輪次語意（見 REVIEW_AGENTS 註解）：顯示已完成的完整輪數。輪次進行
    // 中（三位還沒全部派到）不進位——當前是誰在跑由 detail 的 agent 名補足。
    best.reviewRound = fullReviewRounds(state.reviewCounts)
  }
  return best
}

/**
 * 三位 reviewer 目前完整輪數（見 REVIEW_AGENTS 註解：三位全被派工過才算一輪，
 * 取全員 min）與 final-adversarial-reviewer 累計派工次數——供 collector tick 與
 * /api/pipelines/run 持久化/回傳，讓 run 結束、pending 清空、階段檢核表的
 * detail 消失後，這頁仍看得到審查跑了幾輪。找不到 transcript（run 還沒起、
 * 或非 bug pipeline）回 null。
 */
export function getReviewRoundCounts(ticket: string, runStartedAt: string): { reviewRounds: number; finalReviewRounds: number } | null {
  const path = findPipelineTranscript(ticket, runStartedAt)
  if (!path) return null
  const state = scanTranscriptState(path)
  if (!state) return null
  return {
    reviewRounds: fullReviewRounds(state.reviewCounts),
    finalReviewRounds: state.finalReviewCount,
  }
}

/**
 * 每個 stage 的 started_at 沿用「前一個已完成 stage 的 finished_at」（沒有
 * 前一個就用 run.started_at）——這是本來就沒有更細粒度時間戳可用時最合理的
 * 估計，不是精確量測；跟 finished_at（真實檔案 mtime）性質不同，UI 顯示時
 * 要能分辨。
 */
/** worker 執行的票在該台機器上的階段產物檔 mtime 原始資料（task 1，
 * 2026-09-04）——見 telegram-dispatcher/lib/pipeline-runner/local-stage-files.ts
 * 的 LocalStageFiles（同形狀，兩邊各自獨立宣告，兩個 repo 沒有 import 關係）。
 * server.ts 用 lib/cluster-state.ts 的 fetchRemoteStageFiles() 向 worker 拿到
 * 這份資料後傳進 computeBugStages。 */
export type RemoteStageFiles = {
  debugFiles: Record<string, string | null>
  worktreeBootstrapLog: string | null
}

/** worker 執行的票「目前正在跑哪個 stage／哪位 agent」的即時探測結果
 * （task 2，2026-09-04）——與 lib/cluster-state.ts 的 RemoteCurrentStageResult
 * 同形狀。`undefined`＝呼叫端沒有嘗試探測（等同舊行為，不顯示 running 細節）；
 * `{ ok: false }`＝探測過但打不通/逾時（fail-closed：一樣不顯示 running 細節，
 * 但語意上是「不知道」而非「確定沒有」——呼叫端據此另外顯示「無法確認」，見
 * server.ts buildPipelineRunPayload 的 liveProgressUnavailableReason）；
 * `{ ok: true, stage }`＝探測成功，`stage` 是實際推定結果（可能為 null，代表
 * 此刻沒有任何 agent 在跑，例如兩個 Step 之間的空檔）。 */
export type RemoteCurrentStage = { ok: true; stage: CurrentBugStage | null } | { ok: false }

/**
 * remoteFiles（task 1，2026-09-04）：省略／undefined 時完全比照舊行為，直接
 * 掃 head 本機的 Debug/worktrees 路徑（run.host 是 head 自己執行的票）。帶值
 * 時改用 worker 回報的 mtime 原始資料組裝同一份階段檢核表——head 沒有這些
 * 檔案的本機路徑可掃（worker 執行時 Debug/worktrees 只落在 worker 本地檔案
 * 系統），見 lib/cluster-state.ts fetchRemoteStageFiles() 呼叫處。
 *
 * remoteCurrentStage（task 2，2026-09-04）：`remoteFiles` 模式下（worker 執行
 * 的票）本機讀不到 transcript，改由呼叫端先打 worker 的
 * `GET /jobs/:ticket/current-stage`（見 lib/cluster-state.ts
 * fetchRemoteCurrentStage()）取得探測結果，傳進本參數——本函式據此標出
 * running 那一列，不再對 remoteFiles 模式整段跳過（原本是已知限制，留待下一
 * 輪，現已補上）。`remoteFiles` 省略時（本機執行）本參數不生效，一律用本機
 * inferCurrentBugStage()。
 */
export function computeBugStages(
  ticket: string,
  runStartedAt: string,
  tracker: { status: string; completedAt: string | null } | null,
  running = false,
  remoteFiles?: RemoteStageFiles,
  remoteCurrentStage?: RemoteCurrentStage,
): BugStage[] {
  const dir = join(DEBUG_DIR, ticket)
  // Debug/{ticket} 產物跨同一張票的多次執行共用（重試不會清掉上一輪留下的
  // 檔案）。只認「這次 run 開始之後才更新」的 mtime，避免「重試」後新 run
  // 才剛開始，卻讀到上一輪留下的舊檔案，誤判成本輪已完成、甚至讓
  // finished_at 早於 started_at 顯示出負數耗時。
  const rawAt = (file: string) => (remoteFiles ? (remoteFiles.debugFiles[file] ?? null) : fileMtimeIso(join(dir, `${ticket}-${file}`)))
  const at = (file: string) => {
    const m = rawAt(file)
    return m && m >= runStartedAt ? m : null
  }
  const worktreeBootstrapRawAt = () =>
    remoteFiles ? remoteFiles.worktreeBootstrapLog : fileMtimeIso(join('/Users/user/aladdin/worktrees', ticket, 'bootstrap.log'))
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
    { key: 'worktree', label: 'Step 4 隔離環境（worktree + bootstrap）', finishedAt: (() => { const m = worktreeBootstrapRawAt(); return m && m >= runStartedAt ? m : null })(), reused: !!worktreeBootstrapRawAt() },
    { key: 'review', label: 'Step 6 三重平行審查', finishedAt: reviewMtimes.length === reviewFiles.length ? reviewMtimes.sort().slice(-1)[0]! : null, reused: reviewFiles.every(f => rawAt(f) !== null) },
    // Step 6.5（2026-09-02 create-mr 新增）：三位 reviewer 全 PASSED 後的最終
    // 對抗性驗證。注意 'adversarial-review.md' 是本檔名的子字串——at() 用精確
    // 檔名拼接所以安全；勿改成 includes/endsWith/glob 比對，會互相誤命中。
    { key: 'final-review', label: 'Step 6.5 最終對抗性驗證', finishedAt: at('final-adversarial-review.md'), reused: !!rawAt('final-adversarial-review.md') },
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
  //
  // remoteFiles 模式（worker 執行的票，task 2）：transcript
  // （~/.claude/projects/...）只在執行機本地，head 這裡天生讀不到，改用呼叫端
  // 傳入的 remoteCurrentStage（worker 探測結果）——`undefined` 或 `{ok:false}`
  // 都視為「沒有可用的 running 細節」，fail-closed 不顯示任何 running 列，不是
  // 顯示假資料；呼叫端另外用 `ok:false` 去顯示「無法確認目前進度」的提示（見
  // server.ts buildPipelineRunPayload 的 liveProgressUnavailableReason）。
  if (running) {
    const cur = remoteFiles ? (remoteCurrentStage?.ok === true ? remoteCurrentStage.stage : null) : inferCurrentBugStage(ticket, runStartedAt)
    if (cur) {
      if (cur.stageKey === 'fixer') {
        const idx = stages.findIndex(s => s.key === 'review')
        stages.splice(idx < 0 ? stages.length : idx, 0, { key: 'fixer', label: 'Step 5 TDD 修復（Fixer）', status: 'running', started_at: cur.since, finished_at: null, detail: cur.agent })
      } else {
        const s = stages.find(x => x.key === cur.stageKey)
        if (s) {
          s.status = 'running'; s.started_at = cur.since; s.finished_at = null
          s.detail = cur.reviewRound ? `${cur.agent}・第 ${cur.reviewRound} 輪` : cur.agent
        }
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

// classify-result.ts 的 NEEDS_NOTIFY／UNRESOLVED_OUTCOMES 加上 mysql 側 W6
// reconcile sweep（reconcileStaleOutcomesToMonDb）產生的「（人工判定）」
// 後綴——純字串判斷、不做任何 I/O，供列表頁一次算出「這一列要不要顯示重試
// 按鈕」。2026-09-09 起 `/api/pipelines/retry` 已拿掉 tracker 完成狀態閘門
// （tracker.md 退役，使用者核准：monitor 對任何狀態的票都能重試，只要「現在
// 真的沒在跑」），這裡的 retryable 純粹是列表頁的顯示提示，不再對應後端的
// 權限判斷——按鈕會不會出現看這裡，但按下去會不會成功只看那三關即時安全
// 檢查（本機 ps／併發上限／worker 查證），兩者故意脫鉤，不是漂移。
// 2026-09-08：補上 session_limit——classify-result.ts 的 Classification 全部
// 失敗分類是 failed/timeout/infra_failure/cli_failure/unknown_failure/
// session_limit，這裡原本漏了 session_limit，導致額度用盡的失敗列在畫面上
// 沒有重試按鈕（使用者回報）。
const RETRYABLE_OUTCOME_PREFIXES = new Set(['timeout', 'failed', 'infra_failure', 'cli_failure', 'unknown_failure', 'skipped', 'session_limit'])
export function isBugOutcomeRetryable(outcome: string | null): boolean {
  if (!outcome) return false
  return RETRYABLE_OUTCOME_PREFIXES.has(outcome.replace(/（.*）$/, '').trim())
}

// ---------- 2b) agent 摘要（純函式，供 server.ts 現讀檔案即時解析用） ----------
//
// telegram-dispatcher/lib/pipeline-runner/claude-exec.ts 帶 trace 選項時，每次
// claude -p 呼叫落地一份 logs/agent-traces/<ticket>/<startedAt>-<stage>.json：
// { ticket, stage, startedAt, endedAt, cwd, args, prompt, events | error }。
// events 是 claude -p --output-format json 的完整事件陣列（system init /
// assistant / user(tool_result) / result）。Bug pipeline 的
// <ticket>.<ts>.stdout.log 是同樣的事件物件（格式上 2026-08-26 前是單一 JSON
// 陣列、之後是 stream-json 的 JSONL，parseClaudeEvents 雙格式通吃）。
//
// sqlite 讀取面退役後（2026-09-09），本檔不再把這些事件摘要進背景收集迴圈
// （agent_runs 表已隨 sqlite 一併移除）——server.ts 改成收到請求時才現讀檔案、
// 呼叫 parseClaudeEvents/summarizeEvents 即時算一次（見 /api/agent-trace）。

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

/** service_status_log 落地：粒度比照 sqlite 退役前 recordStatusIfChanged 的
 * 既有語意（只在 up/down 翻轉時寫一筆，第一次觀測也算翻轉）——維護自己獨立
 * 的「上次成功落地進 DB 的狀態」（lastWrittenServiceStatus），只在 append 真
 * 的成功後才推進；失敗時保留舊值，讓下一輪同狀態仍會判定為「與上次落地的
 * 狀態不同」而重試，避免一次 append 失敗就永久遺失這次轉變。
 * 表沒有 pid/latencyMs/uptimeSeconds 欄，把 pid 與 detail 一併塞進
 * detail_json，latency/uptime 皆不存。 */
const lastWrittenServiceStatus = new Map<string, 'up' | 'down'>()

/** 測試專用：清空「上次成功落地進 DB 的狀態」追蹤，避免跨測試互相污染
 * （模組級狀態，同一個 bun test process 內所有測試共用）。 */
export function __resetServiceStatusTrackerForTest(): void {
  lastWrittenServiceStatus.clear()
}

export function appendServiceStatusIfChanged(
  id: string,
  status: 'up' | 'down',
  pid: number | null,
  detail: string | null,
  checkedAt: string,
  /** 測試用覆寫 spool 目錄；正式路徑不傳，落在 mon-db.ts 的 SPOOL_DIR。 */
  spoolDir?: string,
): void {
  if (!isMonitorDbEnabled()) return
  if (lastWrittenServiceStatus.get(id) === status) return
  try {
    appendStatusLogToSpool(
      {
        table: 'service_status_log',
        columns: ['service', 'host', 'ts', 'status', 'detail_json'],
        values: [id, RUNS_HOST, isoToMysqlDatetime3(checkedAt), status, JSON.stringify({ pid, detail })],
      },
      spoolDir,
    )
    // 只在 append 真的成功後才推進（見上方函式註解）。
    lastWrittenServiceStatus.set(id, status)
  } catch (err) {
    console.error(`mon-db: service_status_log spool 寫入失敗（service=${id}）: ${err}`)
  }
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
  appendServiceStatusIfChanged(s.id, status, pid, detail, res.checkedAt)
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

const HEARTBEAT_EVERY_MS = 60_000

/** (host,'tg-monitor') 心跳 tick：appendHeartbeatToSpool 內建 isMonitorDbEnabled()
 * 閘門（旗標關閉時直接 no-op，不建檔不做 I/O），這裡只負責 catch 失敗、
 * WARN 不炸宿主行程——心跳失敗不該影響 collector 的其他職責。 */
function heartbeatTick(): void {
  try {
    appendHeartbeatToSpool()
  } catch (err) {
    console.error(`mon-db: monitor_heartbeat spool 寫入失敗: ${err}`)
  }
}

export function startCollectors(opts: { probeEveryMs: number; ingestEveryMs: number }) {
  const tick = async () => {
    try {
      scanPipelineRuns()
    } catch (err) {
      console.error(`ingest tick failed: ${err}`)
    }
  }
  void tick()
  setInterval(tick, opts.ingestEveryMs)
  void probeAll()
  setInterval(() => void probeAll(), opts.probeEveryMs)
  heartbeatTick()
  setInterval(heartbeatTick, HEARTBEAT_EVERY_MS)
}
