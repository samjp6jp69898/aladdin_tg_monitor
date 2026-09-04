// single-track-consistency.ts — Phase 9 單軌自洽性檢查的純函式判準（原型）。
//
// ⚠️ **這是設計核准前的原型，不是可上線的碼。**
// **預定落點：`tg-monitor/lib/read/single-track-consistency.ts`**（與
// `lib/read/gate-exemptions.ts` 同一個位置與同一個理由：純函式才能被單元測試
// 安全 import，`scripts/switch-readiness.ts` 本身 import 就會連 DB、印結果、
// `process.exit()`）。本檔暫放在 `telegram-dispatcher` 的 agent worktree 裡，
// 是因為指派本工項時給的 worktree 實際上是 telegram-dispatcher 的 worktree、
// 而 `tg-monitor` 沒有 worktree 可 commit（見設計稿 §0.1「工作環境與指派前提
// 的落差」）。搬過去時**不需要修改任何一行**：本檔不 import 任何 repo 內模組。
//
// ─────────────────────────────────────────────────────────────────────────
// 設計依據：`phase9-readiness.md` §3.1 方案 2 / 台帳 a7-D38（核定方向：
// 對照來源改為**檔案系統事實**，不再是「sqlite vs mysql」兩軌對照）。
//
// **對 a7-D38 的兩處具體修正**（證據見設計稿 §2.2，不是重新發明方向）：
//   1. D38 寫「`Debug/{ticket}/` 產物 vs `agent_runs.path`」。**實測 103/103 筆
//      `agent_runs.path` 全部在 `telegram-dispatcher/logs/` 底下，零筆在
//      `obsidian/Debug/`**。`agent_runs.path` 的兩個唯一來源是
//      `logs/agent-traces/<ticket>/*.json` 與 `logs/<key>.stdout.log`
//      （`tg-monitor/lib/ingest.ts:1100,1140`；寫入端
//      `telegram-dispatcher/lib/monitor-db/collectors/agent-runs-collector.ts:53-54`
//      的 `DEFAULT_TRACE_DIR`/`DEFAULT_DISPATCHER_LOG_DIR`）。
//      `obsidian/Debug/` 是 `ingest.ts:684` 的 `DEBUG_DIR`，只餵 **BugStage
//      階段檢核表**，與 `agent_runs` 沒有任何欄位關係。故本檔的 S2 對照的是
//      前兩者。
//   2. D38 只寫「有沒有漏收」。**單方向不夠**：漏收與幽靈列是兩種相反的退化，
//      而實測現況兩種都有（runs 漏收 0 筆、反向孤兒列 5 筆；agent_runs 漏收
//      5 筆。見設計稿 §2.2/§2.3）。
//      本檔因此把兩個方向分成**兩格**分開判、分開歸因（a7-D30：一次只注入
//      一個故障，兩個方向混在一格就無法歸因）。
//
// **時序競態的結構性解法（不用等待，硬規則「禁止用等待解決正確性問題」）**：
//   collector 與 pipeline 一直在跑，DB 快照與檔案系統列表不可能同一瞬間取得。
//   本檔**不 sleep、不重試、不設寬限秒數**，改用「檔名/legacy_key 內嵌的
//   startedAt」這個結構性事實決定每一筆該不該被要求：
//     - FS 有、DB 無：只有當 `startedAt < dbSnapshotAtMs` 才判漏收。
//       晚於 DB 快照時刻開始的 run，DB 快照**結構上不可能**看得到它。
//     - DB 有、FS 無：只有當 `started_at < fsSnapshotAtMs` 才判幽靈列。
//   兩個界線都是「快照時刻」這個確定值，不是容差窗，也不隨負載漂移。
// ─────────────────────────────────────────────────────────────────────────

export type RunKind = 'bug' | 'demand'

/**
 * bug pipeline 的 stdout log 檔名。
 * **逐字複製自 `tg-monitor/lib/ingest.ts:90` 的 `BUG_RE`**——那支是 sqlite
 * collector 認定「這是一次 run」的唯一定義，本檔的對照來源必須與它同一個定義，
 * 否則比的是兩組不同的東西。
 */
export const BUG_LOG_RE = /^([A-Z]+-\d+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.stdout\.log$/

/** demand pipeline 的 stdout log 檔名（`ingest.ts:91` 的 `DEMAND_RE`）。 */
export const DEMAND_LOG_RE = /^([A-Z]+-\d+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.demand-pipeline\.stdout\.log$/

/**
 * `YYYY-MM-DDTHH-MM-SS-mmmZ` → ISO。
 * 與 `ingest.ts:109` 的 `fileTsToIso`、`post-run-notify.ts:206` 的
 * `deriveStartedAtFromLegacyKey` 同一個變換（三處各自實作，值域相同）。
 */
export function fileTsToIso(token: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(token)
  if (!m) return null
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`
}

export interface FsRunLog {
  /** `runs.legacy_key` 應該長的樣子＝檔名去掉 `.stdout.log`。 */
  key: string
  ticket: string
  kind: RunKind
  /** 由檔名時間戳還原的 ISO 字串。 */
  startedAtIso: string
  startedAtMs: number
}

/** 解析單一檔名；不是 pipeline stdout log 就回 null（`post-run-notify.log`、
 * `tg-auto-sync-trigger.stdout.log` 這類非 run 檔案要被排除——實測若只用
 * 「結尾是 .stdout.log」會多撈到 `tg-auto-sync-trigger.stdout.log`）。 */
export function parseRunLogFilename(basename: string): FsRunLog | null {
  let kind: RunKind = 'demand'
  let m = DEMAND_LOG_RE.exec(basename)
  if (!m) {
    m = BUG_LOG_RE.exec(basename)
    kind = 'bug'
  }
  if (!m) return null
  const iso = fileTsToIso(m[2]!)
  if (iso === null) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return { key: basename.replace(/\.stdout\.log$/, ''), ticket: m[1]!, kind, startedAtIso: iso, startedAtMs: ms }
}

/** 一次解析整個目錄列表；順序不影響結果（回傳依 key 排序，讓輸出可重現）。 */
export function collectFsRunLogs(filenames: readonly string[]): FsRunLog[] {
  const out: FsRunLog[] = []
  for (const f of filenames) {
    const p = parseRunLogFilename(f)
    if (p) out.push(p)
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** `runs` 的最小投影（只放本檔判準真的用到的欄位）。 */
export interface DbRunRow {
  run_id: string
  host: string
  ticket: string
  kind: string
  /** `runs.legacy_key`；可能為 NULL（W1 之外的插入路徑不一定帶）。 */
  legacy_key: string | null
  stdout_path: string | null
  /** ISO 字串或 null。 */
  started_at: string | null
  lifecycle_rank: number
  /** 上一輪 run 的 `run_id`（auto-retry / stale-lock-reaper 重派時填）。 */
  retry_of_run_id?: string | null
  outcome?: string | null
}

export interface RunCoverageOptions {
  /**
   * 「這台機器產生的 run」對應的 host 值域。
   *
   * **為什麼要列舉而不是排除**（沿用 `switch-readiness.ts:232-238` 的
   * `judgeWriteSideField` 已核准的理由）：新來源出現時，排除法會把它當本機
   * ⇒ 靜默轉綠；列舉法最壞是樣本不足 ⇒ 紅燈，有人要解釋。
   *
   * 預設 `['head', 'unknown_pre_migration']`：
   *   - `head`＝live 寫入端（`mon-db.ts:43` 的 `RUNS_HOST`）。
   *   - `unknown_pre_migration`＝Phase 6 回填列的哨兵
   *     （`switch-readiness.ts:220` 的 `BACKFILL_HOST`）。回填列**必須**計入：
   *     head 的 `logs/` 底下絕大多數 stdout log 是監控 DB 啟用前的，它們在
   *     `runs` 裡只有回填列（實測 47/75）。漏掉它們的話 S1 會把 47 筆健康的
   *     歷史列全報成漏收。
   *   - worker（如 `landon2`）**不列入**：它的 `stdout_path` 是 **worker 本機**
   *     的路徑，head 的 `logs/` 底下不會有那個檔案（實測 11 筆 bug + 1 筆
   *     demand 皆如此）。把它算進來會產生 12 筆必然的假幽靈列。
   */
  localHosts?: readonly string[]
  /** DB 快照取得的時刻（epoch ms）。 */
  dbSnapshotAtMs: number
  /** 檔案系統列表取得的時刻（epoch ms）。 */
  fsSnapshotAtMs: number
}

export interface RunCoverageResult {
  ok: boolean
  /** FS 有、DB 沒有，且 startedAt 早於 DB 快照 ⇒ 真漏收。 */
  missingInDb: string[]
  /** FS 有、DB 沒有，但 startedAt 晚於 DB 快照 ⇒ 結構上不可能被看到，延後判。 */
  deferredNewerThanDbSnapshot: string[]
  /** DB 有、FS 沒有，且 started_at 早於 FS 快照 ⇒ 幽靈列（檔案被刪或路徑漂移）。 */
  ghostInDb: string[]
  /** DB 有、FS 沒有，但 started_at 晚於 FS 快照 ⇒ 列表拍完才開始的 run，延後判。 */
  deferredNewerThanFsSnapshot: string[]
  /** `started_at` 為 NULL 的本機列——沒有時間就無法用快照時刻歸因，單獨一格。 */
  undatedRows: string[]
  counted: { fs: number; db: number }
}

const DEFAULT_LOCAL_HOSTS = ['head', 'unknown_pre_migration'] as const

/**
 * **S1**：`DISPATCHER_LOG_DIR` 的 pipeline stdout log 清單 ⇔ `runs.legacy_key`。
 *
 * **這一格取代 C4**（`switch-readiness.ts:561`「sqlite 的每一筆 run 在 mysql
 * 都找得到」）。C4 拿 sqlite `pipeline_runs` 當左邊，而 sqlite 的
 * `pipeline_runs` 本來就是 `scanPipelineRuns()` 掃**同一個目錄**產生的
 * （`ingest.ts:539-563`）——**S1 只是把左邊換成 C4 左邊的上游**，少一層衍生，
 * 偵測力不減；而且 sqlite collector 退役後仍然成立（a7-D38 的整個論證）。
 *
 * 兩個方向分開回報、分開判（a7-D30）：
 *   - `missingInDb`：collector／寫入端漏收 ⇒ 畫面上看不到那次 run。
 *   - `ghostInDb`：DB 有列但檔案不在 ⇒ 列表點進去 404，或路徑欄寫錯。
 */
export function judgeRunCoverage(
  fsLogs: readonly FsRunLog[],
  dbRows: readonly DbRunRow[],
  opts: RunCoverageOptions,
): RunCoverageResult {
  const localHosts = new Set(opts.localHosts ?? DEFAULT_LOCAL_HOSTS)
  const local = dbRows.filter(r => localHosts.has(r.host))

  const dbKeys = new Set<string>()
  const undatedRows: string[] = []
  const dbKeyToStartedMs = new Map<string, number>()
  for (const r of local) {
    if (r.legacy_key === null) {
      // legacy_key 為 NULL 的列無法與檔名對位。這不是「忽略」：它進 undatedRows
      // 一起被列出來，因為對位不上本身就是要有人看的事。
      undatedRows.push(`${r.run_id}（legacy_key=NULL, host=${r.host}）`)
      continue
    }
    dbKeys.add(r.legacy_key)
    const ms = r.started_at === null ? Number.NaN : Date.parse(r.started_at)
    if (Number.isNaN(ms)) undatedRows.push(`${r.legacy_key}（started_at=${JSON.stringify(r.started_at)}, host=${r.host}）`)
    else dbKeyToStartedMs.set(r.legacy_key, ms)
  }

  const fsKeys = new Set(fsLogs.map(f => f.key))
  const missingInDb: string[] = []
  const deferredNewerThanDbSnapshot: string[] = []
  for (const f of fsLogs) {
    if (dbKeys.has(f.key)) continue
    if (f.startedAtMs >= opts.dbSnapshotAtMs) deferredNewerThanDbSnapshot.push(f.key)
    else missingInDb.push(f.key)
  }

  const ghostInDb: string[] = []
  const deferredNewerThanFsSnapshot: string[] = []
  for (const [key, startedMs] of dbKeyToStartedMs) {
    if (fsKeys.has(key)) continue
    if (startedMs >= opts.fsSnapshotAtMs) deferredNewerThanFsSnapshot.push(key)
    else ghostInDb.push(key)
  }

  const sorted = (a: string[]) => a.sort()
  return {
    ok: missingInDb.length === 0 && ghostInDb.length === 0 && undatedRows.length === 0,
    missingInDb: sorted(missingInDb),
    deferredNewerThanDbSnapshot: sorted(deferredNewerThanDbSnapshot),
    ghostInDb: sorted(ghostInDb),
    deferredNewerThanFsSnapshot: sorted(deferredNewerThanFsSnapshot),
    undatedRows: sorted(undatedRows),
    counted: { fs: fsLogs.length, db: local.length },
  }
}

// ─────────────────────────────────────────────────────────────────────────

export interface AgentRunPathSources {
  /** `telegram-dispatcher/logs`（`ingest.ts` 的 `DISPATCHER_LOG_DIR`）。 */
  dispatcherLogDir: string
  /** `telegram-dispatcher/logs/agent-traces`（`ingest.ts` 的 `AGENT_TRACE_DIR`）。 */
  agentTraceDir: string
}

/**
 * 一個檔案系統路徑是否為 `agent_runs.path` 的合法來源。
 *
 * 兩個來源，逐條對應 collector 的實際寫入點：
 *   1. `<agentTraceDir>/<ticket>/<name>.json` —— `ingest.ts:1100` 的
 *      `scanAgentTraces`（`kind='demand'`）。
 *   2. `<dispatcherLogDir>/<TICKET>.<ts>.stdout.log` —— `ingest.ts:1140` 的
 *      `ingestBugStdout`（`kind='bug'`、`stage='create-mr'`）。
 *      **demand 的 stdout（`.demand-pipeline.stdout.log`）不算**：
 *      `scanPipelineRuns` 只對 `kind === 'bug'` 呼叫 `ingestBugStdout`
 *      （`ingest.ts:596`、`:613`），寫入端亦同
 *      （`agent-runs-collector.ts` 的 `DEMAND_STDOUT_RE` 排除）。
 */
export function isAgentRunSourcePath(path: string, dirs: AgentRunPathSources): boolean {
  const traces = dirs.agentTraceDir.replace(/\/$/, '')
  const logs = dirs.dispatcherLogDir.replace(/\/$/, '')
  if (path.startsWith(`${traces}/`)) {
    const rest = path.slice(traces.length + 1)
    return /^[^/]+\/[^/]+\.json$/.test(rest)
  }
  if (path.startsWith(`${logs}/`)) {
    const base = path.slice(logs.length + 1)
    if (base.includes('/')) return false
    return BUG_LOG_RE.test(base)
  }
  return false
}

export interface AgentRunRow {
  path: string
  host: string
  /** `agent_runs.finished_at`（讀取層對映成 `ended_at`）。null＝骨架列。 */
  ended_at: string | null
  is_error: number
}

export interface AgentRunCoverageResult {
  ok: boolean
  /** 檔案在、DB 沒有這一筆 path。 */
  missingInDb: string[]
  /** DB 有、檔案已不在（trace 被清、worktree 清理搬走）。 */
  ghostInDb: string[]
  /** DB 有、但 path 不符合任何一個合法來源形狀 ⇒ 寫入端在寫它不該寫的東西。 */
  foreignPaths: string[]
  counted: { fs: number; db: number }
}

/**
 * **S2**：agent trace / bug stdout 檔案清單 ⇔ `agent_runs.path`。
 *
 * **這一格取代 C6 的第一半**（`switch-readiness.ts:666`「sqlite 的每一筆
 * agent_run 在 mysql 都找得到」）。同 S1 的論證：sqlite 側的 `agent_runs`
 * 也是掃同一批檔案產生的，換成直接對檔案是往上游走一層。
 *
 * **C6 的第二半（逐欄相等）沒有單軌對應，會被砍掉**——欄位值（token 數、
 * cost、model）只能從檔案內容重新解析才驗得出來，而那等於在擋門裡再寫一份
 * collector（第二份實作＝第二份會漂移的真相）。**留下的替代偵測力是 S8
 * （骨架列年齡上界，`switch-readiness.ts:701` 現有的那一格本來就是單軌，
 * 直接留用）**。設計稿 §3.4 明列這是**偵測力的淨損失**，不假裝等價。
 *
 * `ghostInDb` **不判 FAIL、只列出**：`cleanup-worktree.ts` 會搬走 run 結束後
 * 的產物、transcript 也會被清（`phase9-readiness.md` §9.3 已知例外），
 * 「檔案不在了」是這批路徑的正常結局，與 S1 的 `runs`（log 檔長期保留）不同。
 */
export function judgeAgentRunCoverage(
  fsPaths: readonly string[],
  dbRows: readonly AgentRunRow[],
  dirs: AgentRunPathSources,
  opts: { localHosts?: readonly string[] } = {},
): AgentRunCoverageResult {
  const localHosts = new Set(opts.localHosts ?? ['head'])
  const local = dbRows.filter(r => localHosts.has(r.host))
  const dbPaths = new Set(local.map(r => r.path))
  const fsSet = new Set(fsPaths.filter(p => isAgentRunSourcePath(p, dirs)))

  const missingInDb = [...fsSet].filter(p => !dbPaths.has(p)).sort()
  const ghostInDb = [...dbPaths].filter(p => !fsSet.has(p) && isAgentRunSourcePath(p, dirs)).sort()
  const foreignPaths = [...dbPaths].filter(p => !isAgentRunSourcePath(p, dirs)).sort()

  return {
    // ghostInDb 刻意不進 ok：見上面 doc comment 的理由。
    ok: missingInDb.length === 0 && foreignPaths.length === 0,
    missingInDb,
    ghostInDb,
    foreignPaths,
    counted: { fs: fsSet.size, db: local.length },
  }
}

// ─────────────────────────────────────────────────────────────────────────

/**
 * `legacy_key` 內嵌時間戳 → `runs.started_at` 的容差。
 *
 * **這個量與 C5 的 `STARTED_AT_TOLERANCE_MS`（`switch-readiness.ts:78`）
 * 是同一個物理量，不是新的一條。** 證明：
 *   - C5 量的是 `mysql.runs.started_at − sqlite.pipeline_runs.started_at`。
 *   - 而 sqlite 的 `pipeline_runs.started_at` **就是** log 檔名時間戳
 *     （`ingest.ts:562` `const startedAt = fileTsToIso(ts)`）。
 *   - `legacy_key` 也**就是** log 檔名（去掉 `.stdout.log`，
 *     `spawn-create-mr.ts:322-323,356`）。
 *   ⇒ 兩者相減的是同一對時戳：檔名鑄出的那一刻 vs W1 寫 `runs` 的
 *     `new Date()`（`spawn-create-mr.ts:430/445`）。
 *
 * 所以本判準**直接沿用 C5 已核准的常數與論證**（單向、上界 2000ms 涵蓋負載下
 * 的建檔＋sidecar＋spawn 抖動），不新增第二條需要各自論證的容差——這與 a7-D36
 * 「`finished_at` 不得與 D6 共用常數」不衝突：那條拒絕合併的是**兩個不同機制**
 * （「建檔→spawn」vs「log 行→DB 寫入」），這裡是**同一個機制的單軌量法**。
 *
 * **附帶收穫**：C5 的 Δ 分布長期卡在 n=2（`phase9-readiness.md` §2.2，只有
 * 兩筆兩軌都有的配對）。本判準不需要 sqlite，**當下就能拿到 n=36**
 * （2026-09-04 實測：head 24 筆 Δ∈[0,14]ms、landon2 12 筆 Δ∈[0,42]ms、
 * 回填列 47 筆 Δ≡0 by construction），方向 100% 為非負，與 D6 的因果論證一致。
 * 退役 sqlite 之後樣本仍會繼續累積——**它是 §2.3 那個「等 7 天樣本」的
 * 常數收斂問題的替代來源**。
 */
export const KEY_TO_STARTED_AT_TOLERANCE_MS = 2000

export interface LegacyKeyCoherenceResult {
  ok: boolean
  /** `legacy_key` 與 `stdout_path` 的 basename 對不起來。 */
  keyPathMismatch: string[]
  /** `legacy_key` 內嵌的時間戳與 `started_at` 方向錯或逾容差。 */
  keyStartedAtMismatch: string[]
  /** 本輪實測到的最大 Δ（毫秒）；無樣本時為 null。逐輪印出，供常數收斂。 */
  observedMaxDeltaMs: number | null
  /** 同一個 host 底下 `legacy_key` 重複（`idx_legacy_key` **不是** UNIQUE）。 */
  duplicateKeys: string[]
  /** `lifecycle_rank >= 30` 但 `stdout_path` / `started_at` 為 NULL 的孤兒列。 */
  orphanRows: string[]
  checked: number
}

/**
 * **S4**：`runs` 單列內部的三個欄位互為可逆推導，必須自洽。
 *
 * `legacy_key`、`stdout_path`、`started_at` 三者在寫入端出自**同一個 `base`**
 * （`spawn-create-mr.ts:322-324` 的 `base` / `stdoutPath`、`:356` 的
 * `legacyKey = base`；demand 同構於 `spawn-demand-pipeline.ts:104-105,127`），
 * 補列路徑則是從 `stdout_path` 反推
 * （`post-run-notify.ts:181` 的 `deriveLegacyKeyFromStdoutPath` 與 `:206` 的
 * `deriveStartedAtFromLegacyKey`）。**所以它們對得起來是 by construction，
 * 對不起來就代表有第三個寫入端用了不同的鑄法。**
 *
 * **這一格是新的，沒有舊 C 判準對應**——兩軌時代這種欄內矛盾會被
 * 「sqlite 也是同一個檔名推的」掩蓋掉（兩軌一起錯，逐欄比仍相等）。
 * 它抓到的實際問題見設計稿 §2.4：`tg-monitor/lib/mon-db.ts:270` 的
 * `deriveLegacyKey` 產出的是**冒號 ISO**（`FAQ-3098.2026-09-03T01:34:41.015Z`），
 * 與寫入端的**破折號 token**（`FAQ-3098.2026-09-03T01-34-41-015Z`）不同，
 * 而該檔 `:257-259` 的註解明文宣稱兩者「必須逐位元組相同」。
 *
 * `orphanRows` 對應實測到的 4 筆 W4B cancel 插入列（`cancel_resolved_by='marker'`、
 * `stdout_path`/`started_at` 皆 NULL）——它們被 `RUNS_LIST_WHERE`
 * （`lib/read/mysql.ts` 的 `r.started_at IS NOT NULL`）擋在畫面外，**所以兩軌
 * 對照永遠看不到它們**。單軌檢查直接查表就看得到。
 */
export function judgeLegacyKeyCoherence(
  dbRows: readonly DbRunRow[],
  opts: { localHosts?: readonly string[] } = {},
): LegacyKeyCoherenceResult {
  const localHosts = new Set(opts.localHosts ?? DEFAULT_LOCAL_HOSTS)
  const local = dbRows.filter(r => localHosts.has(r.host))

  const keyPathMismatch: string[] = []
  const keyStartedAtMismatch: string[] = []
  const orphanRows: string[] = []
  const seen = new Map<string, number>()
  const duplicateKeys: string[] = []
  let observedMaxDeltaMs: number | null = null

  for (const r of local) {
    if (r.legacy_key !== null) {
      const dupKey = `${r.host}|${r.legacy_key}`
      const n = (seen.get(dupKey) ?? 0) + 1
      seen.set(dupKey, n)
      if (n === 2) duplicateKeys.push(dupKey)
    }

    if (r.lifecycle_rank >= 30 && (r.stdout_path === null || r.started_at === null)) {
      orphanRows.push(`${r.run_id}（legacy_key=${JSON.stringify(r.legacy_key)}, stdout_path=${JSON.stringify(r.stdout_path)}, started_at=${JSON.stringify(r.started_at)}）`)
      continue
    }

    if (r.legacy_key === null || r.stdout_path === null) continue

    const base = r.stdout_path.split('/').pop() ?? ''
    if (`${r.legacy_key}.stdout.log` !== base) {
      keyPathMismatch.push(`${r.run_id}: legacy_key=${r.legacy_key} basename=${base}`)
    }

    if (r.started_at !== null) {
      const token = r.legacy_key.startsWith(`${r.ticket}.`)
        ? r.legacy_key.slice(r.ticket.length + 1).replace(/\.demand-pipeline$/, '')
        : null
      const iso = token === null ? null : fileTsToIso(token)
      if (iso === null) {
        keyStartedAtMismatch.push(`${r.run_id}: legacy_key=${r.legacy_key} 無法還原時間戳`)
      } else {
        // Δ = started_at − 檔名時間戳。**單向**：檔名先鑄、W1 後寫，負差代表
        // 對錯列或時鐘倒退，一律 FAIL 不給容差（同 D6 的立場）。
        const d = Date.parse(r.started_at) - Date.parse(iso)
        if (Number.isFinite(d)) observedMaxDeltaMs = observedMaxDeltaMs === null ? d : Math.max(observedMaxDeltaMs, d)
        if (!Number.isFinite(d) || d < 0 || d > KEY_TO_STARTED_AT_TOLERANCE_MS) {
          keyStartedAtMismatch.push(`${r.run_id}: legacy_key 時間戳=${iso} started_at=${r.started_at} Δ=${d}ms`)
        }
      }
    }
  }

  return {
    ok: keyPathMismatch.length === 0 && keyStartedAtMismatch.length === 0 && duplicateKeys.length === 0 && orphanRows.length === 0,
    keyPathMismatch: keyPathMismatch.sort(),
    keyStartedAtMismatch: keyStartedAtMismatch.sort(),
    observedMaxDeltaMs,
    duplicateKeys: duplicateKeys.sort(),
    orphanRows: orphanRows.sort(),
    checked: local.length,
  }
}

// ─────────────────────────────────────────────────────────────────────────

export interface RetryLineageResult {
  ok: boolean
  /** `retry_of_run_id` 指向的 run 不在表裡。 */
  dangling: string[]
  /** 父子 ticket 不同 ⇒ 血緣被接到別張票上。 */
  ticketMismatch: string[]
  /** 父的 `started_at` 不早於子 ⇒ 順序倒置（或兩者無法定序）。 */
  notLaterThanParent: string[]
  /** 自我參照 / 成環。 */
  cycles: string[]
  /** 同一個父被兩個以上的子指向 ⇒ 一次失敗被重試了兩次。 */
  forkedParents: string[]
  /** 父的 outcome 不在會觸發重試的值域內（只列出，不判紅——手動重試值域不封閉）。 */
  unexpectedParentOutcome: string[]
  counted: { withLineage: number; total: number }
}

/**
 * **S6**：`retry_of_run_id` 血緣自洽（`phase9-readiness.md` §1.3 缺口 2 的
 * 「resume/retry 血緣」判準）。
 *
 * **這一格是新的，沒有舊 C 判準對應**——`retry_of_run_id` 是監控 DB 獨有的欄位，
 * sqlite 的 `pipeline_runs` 根本沒有這個概念（`lib/db.ts` 的建表語句無此欄），
 * 所以兩軌對照**在定義上就不可能**檢查它。這正是 a7-D38「拿衍生物比衍生物」
 * 會漏掉的盲區之一：新軌獨有的欄位，舊軌無從對照。
 *
 * **血緣在寫入端是怎麼產生的**（讀碼，非推測）：
 *   - auto-retry：`post-run-notify.ts:444` 的 `executeAutoRetry` 只在
 *     `classification === 'timeout'` 被 `planAutoRetry` 放行，走
 *     `submitCreateMr(ticket, { resume: true })`；該函式
 *     （`spawn-create-mr.ts:670`）取 `process.env.MON_RUN_ID`——post-run-notify
 *     是 wrapper EXIT trap 的子行程，繼承的正是**上一輪 run 的 run_id**。
 *   - stale-lock-reaper：`stale-lock-reaper.ts:182` 顯式帶 `retryOf`
 *     （常駐行程的 `MON_RUN_ID` 恆空，見該檔註解）。
 *   - **resume 不會覆用舊列**：`spawnCreateMrNow` 每次都重鑄
 *     `timestamp`/`base`/`stdoutPath`（`spawn-create-mr.ts:322-324`），
 *     `resume` 只是 wrapper 的第三個位置參數（`:358-360`）。
 *     ⇒ **一次 resume ＝ 一個新 log 檔 ＋ 一列新 `runs`**，S1 的對位不受影響。
 *
 * 各子項的失敗方向都是「叫」而不是「靜默歸類」：
 *   - `dangling`：父列不存在。**這是退役後才會浮現的形狀**——保留期到了之後
 *     舊列若被清掉，血緣鏈會斷在半途，而現存沒有任何檢查會叫。
 *   - `forkedParents`：一個父被兩個子指向 ＝ 同一次失敗觸發了兩次重試。
 *     `planAutoRetry` 的 `runningTickets.includes(ticket)` 防禦自稱
 *     「不應該發生」（`post-run-notify.ts:433`），這一格是它的事後可觀測版本。
 *   - `unexpectedParentOutcome` **只列不判紅**：tg-monitor 的
 *     `/api/pipelines/retry` 可以對任何終態手動重試，值域不封閉
 *     （同 `KNOWN_OUTCOME_SOURCES` 的 WARN 處置）。
 */
export function judgeRetryLineage(
  dbRows: readonly DbRunRow[],
  opts: { autoRetryParentOutcomes?: readonly string[] } = {},
): RetryLineageResult {
  const byId = new Map(dbRows.map(r => [r.run_id, r]))
  const autoOutcomes = new Set(
    opts.autoRetryParentOutcomes ?? ['timeout', 'infra_failure', 'unknown_failure', 'failed', 'cancelled'],
  )

  const dangling: string[] = []
  const ticketMismatch: string[] = []
  const notLaterThanParent: string[] = []
  const cycles: string[] = []
  const forkedParents: string[] = []
  const unexpectedParentOutcome: string[] = []
  const childCount = new Map<string, number>()
  let withLineage = 0

  for (const r of dbRows) {
    const parentId = r.retry_of_run_id ?? null
    if (parentId === null) continue
    withLineage++

    if (parentId === r.run_id) { cycles.push(`${r.run_id} 自我參照`); continue }
    const parent = byId.get(parentId)
    if (!parent) { dangling.push(`${r.run_id}（ticket=${r.ticket}）→ ${parentId}（不存在）`); continue }
    childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1)

    if (parent.ticket !== r.ticket) ticketMismatch.push(`${r.run_id}（${r.ticket}）→ ${parentId}（${parent.ticket}）`)

    const cs = r.started_at === null ? null : Date.parse(r.started_at)
    const ps = parent.started_at === null ? null : Date.parse(parent.started_at)
    if (cs === null || ps === null || Number.isNaN(cs) || Number.isNaN(ps) || !(cs > ps)) {
      notLaterThanParent.push(`${r.run_id} started_at=${JSON.stringify(r.started_at)} 不晚於父 ${parentId} started_at=${JSON.stringify(parent.started_at)}`)
    }
    if (parent.outcome !== undefined && parent.outcome !== null && !autoOutcomes.has(parent.outcome)) {
      unexpectedParentOutcome.push(`${r.run_id} → 父 ${parentId} outcome=${parent.outcome}`)
    }
  }

  // 成環偵測（自我參照已在上面單獨處理）：沿 retry_of_run_id 往上走，
  // 走過的節點再度出現就是環。表小，逐節點走足夠。
  for (const r of dbRows) {
    // 自我參照（retry_of_run_id === run_id）已在上面的迴圈單獨記過一筆，
    // 這裡跳過它，避免同一個缺陷被計兩次（D30：一個故障一個歸因）。
    if ((r.retry_of_run_id ?? null) === r.run_id) continue
    const seen = new Set<string>([r.run_id])
    let cur = r.retry_of_run_id ?? null
    while (cur !== null) {
      if (seen.has(cur)) { cycles.push(`${r.run_id} 的血緣鏈成環於 ${cur}`); break }
      seen.add(cur)
      cur = byId.get(cur)?.retry_of_run_id ?? null
    }
  }

  for (const [pid, n] of childCount) if (n > 1) forkedParents.push(`${pid} 被 ${n} 個 run 指為 retry 來源`)

  return {
    ok:
      dangling.length === 0 && ticketMismatch.length === 0 && notLaterThanParent.length === 0 &&
      cycles.length === 0 && forkedParents.length === 0,
    dangling: dangling.sort(),
    ticketMismatch: ticketMismatch.sort(),
    notLaterThanParent: notLaterThanParent.sort(),
    cycles: [...new Set(cycles)].sort(),
    forkedParents: forkedParents.sort(),
    unexpectedParentOutcome: unexpectedParentOutcome.sort(),
    counted: { withLineage, total: dbRows.length },
  }
}
