// lib/mon-db.ts — mon_ui 監控 DB 最小寫入模組（cancel 旗標 + rounds 兩欄）。
//
// 依據 plan-db-as-truth-v3.2.md 裁定 3（BL-E3）＋【G:BL-G2】＋
// impl-errata-g2.md MJ-H1 指揮官裁定，與 telegram-dispatcher 端的
// lib/monitor-db/{env,pool,mysql-datetime,writes,cancel-resolve}.ts 是同一套
// 演算法的兩份獨立實作——**這不是疏漏，是既有慣例**：tg-monitor 是獨立 git
// repo，與 telegram-dispatcher 沒有 import 關係（見 lib/ingest.ts 既有的
// CREATE_MR_TIMEOUT_SECONDS 註解：「兩個 repo 各自獨立、沒有 import 關係，
// 這裡只能複製常數，改動時要同步調整」）。本檔複製的是這兩條寫入路徑用得到
// 的最小子集：mon_ui pool、五段 run_id 解析、W4a/W4b 兩段寫、cancel 旗標寫入
// 失敗時的 spool 落地；rounds 兩欄（review_rounds/final_review_rounds，
// migration 004 就位，Phase 8 讀取面 a4 消費）則是 tg-monitor 獨有、
// telegram-dispatcher 端沒有對應實作——rounds 只在 tg-monitor 這一側算得出來
// （transcript 掃描），沒有「兩份獨立實作」的同步負擔。**cancel 相關改動仍要
// 兩邊同步**（尤其：SQL 文字、cancel_resolved_by 值域、legacy_key 格式）。
//
// 職責邊界（§2.2 mon_ui 授權）：唯讀九張表（本檔完全不碰）＋ `runs` 的
// cancel 欄位級 INSERT/UPDATE ＋ rounds 兩欄的 UPDATE。`outcome` /
// `outcome_tier` 不在本檔任何 SQL 的欄位清單內。
//
// 全部功能都在 isMonitorDbEnabled() 之後才會被呼叫——旗標關閉時本檔的任何
// 函式都不會被呼叫到（見 lib/ingest.ts cancelPipeline / persistReviewRounds
// 的守衛，以及 persistReviewRoundsToMonDb 自己的深度防禦），import 本身
// 零副作用（不建 pool，不做任何 I/O）。
import { createPool, type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DISPATCHER_LOG_DIR } from './services.ts'

// ─────────────────────────────────────────────────────────────────────────
// 開關與環境（複製 telegram-dispatcher/lib/monitor-db/env.ts 的語意）
// ─────────────────────────────────────────────────────────────────────────

/** '1' 才是開啟；未設 / '' / '0' 全部視為關閉（與 MON_DB_ENABLED 的既有約定一致）。 */
export function isMonitorDbEnabled(): boolean {
  return process.env.MON_DB_ENABLED === '1'
}

/** head 行程固定身分（複製 telegram-dispatcher/lib/monitor-db/env.ts 的
 * MON_HOST 慣例：head 上沒有 CLUSTER_WORKER_NAME，固定為 'head'）。cancel
 * 只能取消本機（head）ps 快照命中的 pipeline，worker run 不在此範圍
 * （plan §6.4(4) 既有聲明）。 */
export const RUNS_HOST = 'head'

// ─────────────────────────────────────────────────────────────────────────
// pool（全案 tg-monitor 唯一的 createPool 呼叫點）
// ─────────────────────────────────────────────────────────────────────────

let poolSingleton: Pool | null = null

/** 惰性建池；只有在 isMonitorDbEnabled() 為 true 且真的需要連線時才呼叫。 */
export function getMonitorPool(): Pool {
  if (poolSingleton) return poolSingleton
  const host = process.env.MON_DB_HOST
  const portRaw = process.env.MON_DB_PORT
  const schema = process.env.MON_DB_SCHEMA
  const user = process.env.MON_DB_USER
  const password = process.env.MON_DB_PASSWORD
  const missing = [
    ['MON_DB_HOST', host],
    ['MON_DB_PORT', portRaw],
    ['MON_DB_SCHEMA', schema],
    ['MON_DB_USER', user],
    ['MON_DB_PASSWORD', password],
  ].filter(([, v]) => !v)
  if (missing.length > 0) {
    throw new Error(`mon-db: 缺少必要環境變數：${missing.map(([k]) => k).join(', ')}`)
  }
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`mon-db: MON_DB_PORT 不是合法埠號：${portRaw}`)
  }
  poolSingleton = createPool({
    host,
    port,
    database: schema,
    user,
    password,
    timezone: 'Z',
    dateStrings: ['DATE', 'DATETIME'],
    // 與 telegram-dispatcher/lib/monitor-db/pool.ts 同語意：移除 mysql2 預設
    // 開啟的 CLIENT_FOUND_ROWS，讓形狀 B 的 UPDATE 改讀 info 字串三態語意。
    flags: ['-FOUND_ROWS'],
    connectTimeout: 500,
    enableKeepAlive: true,
    waitForConnections: false,
    // §4.6 pool 表 tg-monitor 那一列：4。
    connectionLimit: 4,
  })
  return poolSingleton
}

// ─────────────────────────────────────────────────────────────────────────
// ISO ↔ MySQL DATETIME(3)（複製 telegram-dispatcher/lib/monitor-db/mysql-datetime.ts）
// ─────────────────────────────────────────────────────────────────────────

const ISO_UTC_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/

/** `'2026-08-26T03:23:44.751Z'` → `'2026-08-26 03:23:44.751'`。 */
export function isoToMysqlDatetime3(iso: string): string {
  const m = ISO_UTC_RE.exec(iso)
  if (!m) throw new Error(`isoToMysqlDatetime3: 不是合法的 UTC ISO 字串（必須以 'Z' 結尾）：${iso}`)
  const ms = (m[3] ?? '000').padEnd(3, '0').slice(0, 3)
  return `${m[1]} ${m[2]}.${ms}`
}

// ─────────────────────────────────────────────────────────────────────────
// 五段 run_id 解析（複製 telegram-dispatcher/lib/monitor-db/cancel-resolve.ts，
// 次序見該檔檔頭：R1 → R3 → R2 → R4 → R5，errata MJ-H1 裁定凌駕 v3.2 原文）
// ─────────────────────────────────────────────────────────────────────────

export type RunKind = 'bug' | 'demand'
export type CancelResolvedBy = 'pid_match' | 'marker' | 'legacy_key' | 'latest_running' | 'placeholder'

export interface CancelResolveTarget {
  pid: number
  pidSet: number[]
}

export interface MarkerSnapshot {
  runId: string | null
  kind: RunKind | null
}

export interface ResolveRunIdInput {
  kind: RunKind
  ticket: string
  target: CancelResolveTarget
  legacyKey: string | null
  stdoutPath: string | null
  marker: MarkerSnapshot
}

export interface ResolveRunIdResult {
  runId: string
  resolvedBy: CancelResolvedBy
  markerMismatch: boolean
}

interface MonitorDbExecutor {
  execute<T = ResultSetHeader>(sql: string, params?: unknown[]): Promise<[T, unknown]>
}

function buildInPlaceholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

function buildR1PidMatchSql(pidCount: number): string {
  return `
SELECT run_id FROM runs
 WHERE host = ? AND ticket = ? AND kind = ? AND lifecycle_rank = 30 AND outcome IS NULL
   AND pid IN (${buildInPlaceholders(Math.max(pidCount, 1))})
`.trim()
}

const R3_LEGACY_KEY_SQL = `
SELECT run_id FROM runs
 WHERE host = ? AND ticket = ? AND kind = ? AND lifecycle_rank = 30 AND outcome IS NULL
   AND (legacy_key = ? OR stdout_path = ?)
`.trim()

const R4_LATEST_RUNNING_SQL = `
SELECT run_id FROM runs
 WHERE host = ? AND ticket = ? AND kind = ? AND lifecycle_rank = 30 AND outcome IS NULL
 ORDER BY started_at DESC, created_at DESC LIMIT 1
`.trim()

async function selectSingleRunId(pool: MonitorDbExecutor, sql: string, params: unknown[]): Promise<string | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(sql, params)
  const r = rows as unknown as Array<{ run_id: string }>
  if (r.length !== 1) return null
  return r[0]!.run_id
}

async function resolveR1(pool: MonitorDbExecutor, input: ResolveRunIdInput): Promise<string | null> {
  const pidSet = input.target.pidSet.length > 0 ? input.target.pidSet : [input.target.pid]
  return selectSingleRunId(pool, buildR1PidMatchSql(pidSet.length), [RUNS_HOST, input.ticket, input.kind, ...pidSet])
}

async function resolveR3(pool: MonitorDbExecutor, input: ResolveRunIdInput): Promise<string | null> {
  if (!input.legacyKey && !input.stdoutPath) return null
  return selectSingleRunId(pool, R3_LEGACY_KEY_SQL, [RUNS_HOST, input.ticket, input.kind, input.legacyKey ?? null, input.stdoutPath ?? null])
}

function resolveR2(input: ResolveRunIdInput): { runId: string; mismatch: boolean } | null {
  const { marker, kind } = input
  if (!marker.runId) return null
  if (marker.kind !== null && marker.kind !== kind) return { runId: marker.runId, mismatch: true }
  return { runId: marker.runId, mismatch: false }
}

async function resolveR4(pool: MonitorDbExecutor, input: ResolveRunIdInput): Promise<string | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(R4_LATEST_RUNNING_SQL, [RUNS_HOST, input.ticket, input.kind])
  const r = rows as unknown as Array<{ run_id: string }>
  return r.length > 0 ? r[0]!.run_id : null
}

/**
 * 五段解析主體。永遠有結果，殺不殺完全不受這裡影響（呼叫端 cancelPipeline
 * 的殺行程流程不依賴這裡的結果）。WARN 級告警以 console.warn 落地。
 */
export async function resolveRunId(pool: MonitorDbExecutor, input: ResolveRunIdInput): Promise<ResolveRunIdResult> {
  const r1 = await resolveR1(pool, input)
  if (r1) return { runId: r1, resolvedBy: 'pid_match', markerMismatch: false }

  const r3 = await resolveR3(pool, input)
  if (r3) return { runId: r3, resolvedBy: 'legacy_key', markerMismatch: false }

  const r2 = resolveR2(input)
  if (r2 && !r2.mismatch) return { runId: r2.runId, resolvedBy: 'marker', markerMismatch: false }
  const markerMismatch = r2?.mismatch === true
  if (markerMismatch) {
    console.warn(
      `cancel_marker_mismatch: ticket=${input.ticket} kind=${input.kind} markerRunId=${r2!.runId} markerKind=${input.marker.kind}` +
        `（marker 的 kind 與請求不一致，降級到下一段，見 impl-errata-g2.md MJ-H1）`,
    )
  }

  const r4 = await resolveR4(pool, input)
  if (r4) {
    console.warn(`cancel_runid_fallback: ticket=${input.ticket} kind=${input.kind} runId=${r4}（R1/R2/R3 皆未命中，採用最新 running 列）`)
    return { runId: r4, resolvedBy: 'latest_running', markerMismatch }
  }

  const placeholder = crypto.randomUUID()
  console.warn(`cancel_runid_placeholder: ticket=${input.ticket} kind=${input.kind} runId=${placeholder}（R1–R4 全部落空，鑄孤兒佔位列）`)
  return { runId: placeholder, resolvedBy: 'placeholder', markerMismatch }
}

export interface LocalOnlyResolveResult {
  runId: string
  resolvedBy: CancelResolvedBy
  markerMismatch: boolean
}

/**
 * §6.4(2) 步驟 4 逾時／DB 不可達退路的 run_id 定案：「runId = runIdLocal ??
 * mintUuidV4()」——這裡把 runIdLocal 精確定義成「通過 R2 kind 自我驗證的
 * marker runId」（同 resolveRunId 內部的 R2/R5，但完全不碰 DB，因為會走到
 * 這裡正是因為 DB 卡住或逾時）。回傳值仍落在 cancel_resolved_by 的合法值域
 * 內，讓落 spool 的條目可稽核。
 */
export function resolveRunIdLocalOnly(kind: RunKind, marker: MarkerSnapshot): LocalOnlyResolveResult {
  const r2 = resolveR2({ kind, ticket: '', target: { pid: 0, pidSet: [] }, legacyKey: null, stdoutPath: null, marker })
  if (r2 && !r2.mismatch) return { runId: r2.runId, resolvedBy: 'marker', markerMismatch: false }
  if (r2?.mismatch) {
    console.warn(
      `cancel_marker_mismatch: kind=${kind} markerRunId=${r2.runId} markerKind=${marker.kind}` +
        `（逾時/DB 不可達退路下的本機自我驗證失敗，改鑄 placeholder，見 impl-errata-g2.md MJ-H1）`,
    )
  }
  const placeholder = crypto.randomUUID()
  console.warn(`cancel_runid_placeholder: kind=${kind} runId=${placeholder}（逾時/DB 不可達退路，本機也無可用 marker）`)
  return { runId: placeholder, resolvedBy: 'placeholder', markerMismatch: r2?.mismatch === true }
}

// ─────────────────────────────────────────────────────────────────────────
// legacy_key（ps 反推側）：格式 `<ticket>.<ISO>`（v3 §10.2），與 spawn 端由
// stdoutPath 算出的那份必須逐位元組相同——兩者共同輸入是同一個 stdout log
// 檔名，本函式從檔名反推。
// ─────────────────────────────────────────────────────────────────────────

const STDOUT_LOG_RE = /^([A-Z]+-\d+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(?:demand-pipeline\.)?stdout\.log$/

function fileTsToIso(t: string): string {
  return t.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
}

/** 由 wrapper 的 stdout log 絕對路徑反推 legacy_key；反推失敗回 null（往下一段降級，非硬錯誤）。 */
export function deriveLegacyKey(stdoutPath: string): string | null {
  const base = stdoutPath.split('/').pop() ?? ''
  const m = STDOUT_LOG_RE.exec(base)
  if (!m) return null
  return `${m[1]}.${fileTsToIso(m[2]!)}`
}

// ─────────────────────────────────────────────────────────────────────────
// active-pipeline marker（本機檔案，無 DB）：讀 telegram-dispatcher 的
// logs/active-pipelines/<ticket>。相容兩種格式：
//   - 新格式（JSON）：{"startedAt":"<ISO>","runId":"<uuid>","kind":"bug|demand"}
//   - 舊格式（純 ISO 字串）：沒有 runId，R2 視為不可用（回 null，非 mismatch）。
// 讀取邏輯是本檔自己的獨立實作，不 import telegram-dispatcher 的
// active-pipeline-marker.ts（跨 repo 沒有 import 關係，且該檔屬於另一位
// Phase 2 負責人的所有權範圍，本檔只唯讀它產出的檔案內容）。
// ─────────────────────────────────────────────────────────────────────────

export const ACTIVE_MARKER_DIR = join(DISPATCHER_LOG_DIR, 'active-pipelines')

// 與 telegram-dispatcher/lib/pipeline-runner/active-pipeline-marker.ts 的
// UUID_RE 逐位元組相同（該檔是這份標記格式的權威定義來源，本檔唯讀其產出）。
const MARKER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function readActiveMarker(kind: RunKind, ticket: string, dir: string = ACTIVE_MARKER_DIR): MarkerSnapshot {
  const path = join(dir, ticket)
  if (!existsSync(path)) return { runId: null, kind: null }
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const parsed = JSON.parse(raw) as { runId?: unknown; kind?: unknown }
    const runId = typeof parsed.runId === 'string' && MARKER_UUID_RE.test(parsed.runId) ? parsed.runId : null
    const markerKind = parsed.kind === 'bug' || parsed.kind === 'demand' ? parsed.kind : null
    return { runId, kind: markerKind }
  } catch {
    // 舊格式（純 ISO 字串）或壞檔：JSON.parse 失敗 → 沒有 runId 可用。
    return { runId: null, kind: null }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// W4a/W4b（複製 telegram-dispatcher/lib/monitor-db/writes.ts 的 writeCancelFlag）
// ─────────────────────────────────────────────────────────────────────────

const W4A_SQL = `
UPDATE runs
   SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
       cancel_resolved_by  = COALESCE(cancel_resolved_by,  ?)
 WHERE run_id = ? AND host = ?
`.trim()

const W4B_INSERT_SQL = `
INSERT INTO runs (run_id, host, ticket, kind, lifecycle_rank, cancel_requested_at, cancel_resolved_by, legacy_key, created_at)
VALUES (?, ?, ?, ?, 10, ?, ?, ?, NOW(3))
`.trim()

const UPDATE_INFO_RE = /^Rows matched:\s*(\d+)\s+Changed:\s*(\d+)\s+Warnings:\s*(\d+)$/

function parseMatched(info: string | undefined | null): number | null {
  if (!info) return null
  const m = UPDATE_INFO_RE.exec(info.trim())
  return m ? Number(m[1]) : null
}

function isDupEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ER_DUP_ENTRY'
}

export interface WriteCancelFlagInput {
  runId: string
  ticket: string
  kind: RunKind
  cancelRequestedAt: string
  resolvedBy: CancelResolvedBy
  legacyKey?: string | null
}

export interface WriteCancelFlagResult {
  ok: boolean
}

/** W4a 先試守衛式 UPDATE；matched=0 才用 W4b 建最小佔位列；ER_DUP_ENTRY 再試一次 W4a。 */
export async function writeCancelFlag(pool: MonitorDbExecutor, input: WriteCancelFlagInput): Promise<WriteCancelFlagResult> {
  const cancelRequestedAt = isoToMysqlDatetime3(input.cancelRequestedAt)
  const updateParams = [cancelRequestedAt, input.resolvedBy, input.runId, RUNS_HOST]

  const [header1] = await pool.execute<ResultSetHeader>(W4A_SQL, updateParams)
  const matched1 = parseMatched((header1 as ResultSetHeader).info)
  if (matched1 !== null && matched1 > 0) return { ok: true }

  try {
    await pool.execute(W4B_INSERT_SQL, [input.runId, RUNS_HOST, input.ticket, input.kind, cancelRequestedAt, input.resolvedBy, input.legacyKey ?? null])
    return { ok: true }
  } catch (err) {
    if (!isDupEntry(err)) throw err
    const [header2] = await pool.execute<ResultSetHeader>(W4A_SQL, updateParams)
    const matched2 = parseMatched((header2 as ResultSetHeader).info)
    return { ok: matched2 !== null && matched2 > 0 }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Rounds 寫入（Phase 8 讀取面 a4 唯一的 rounds 資料來源；本節是唯一的寫入端，
// 2026-09-02 新增）。與 cancel 不同：沒有殺行程語境、沒有 pid/marker 可用，
// 對位只能靠 legacy_key/stdout_path（與 cancel R3 同一組查詢欄位，共用
// idx_legacy_key、idx_host_stdout_path 兩個既有索引），且不篩 lifecycle_rank/
// outcome——rounds 在 run 執行中與剛結束的最後一次掃描都要能寫入，兩種狀態的
// 列都得對得到。對不到 → 呼叫端 skip，不猜、不鑄新列（rounds 沒有「一定要有
// 一列」的硬約束，不同於 cancel 的 R4/R5 placeholder 退路）。
// ─────────────────────────────────────────────────────────────────────────

// kind 寫死 'bug'（不是參數）：rounds 只可能算得出 bug pipeline 的
// counts——getReviewRoundCounts 靠 transcript 裡的 `/create-mr:create-mr
// <ticket>` prompt 標記找 session，demand pipeline 沒有這個標記，
// findPipelineTranscript 對 demand run 恆回 null，呼叫端（ingest.ts 的
// persistReviewRounds）在 `if (!counts) return` 那一行就已經把 demand 濾掉，
// 走不到這裡。加回這個篩選對齊 cancel 的 R3（同一組欄位），零成本。
const ROUNDS_RESOLVE_SQL = `
SELECT run_id FROM runs
 WHERE host = ? AND ticket = ? AND kind = 'bug' AND (legacy_key = ? OR stdout_path = ?)
`.trim()

/** 由 legacy_key/stdout_path 對位 mon_ui 的 run_id；0 或 >1 列命中一律回
 * null（歧義不猜）。呼叫端負責 cache（見 persistReviewRoundsToMonDb，key 含
 * runStartedAt）。 */
export async function resolveRunIdForRounds(
  pool: MonitorDbExecutor,
  ticket: string,
  legacyKey: string | null,
  stdoutPath: string | null,
): Promise<string | null> {
  if (!legacyKey && !stdoutPath) return null
  return selectSingleRunId(pool, ROUNDS_RESOLVE_SQL, [RUNS_HOST, ticket, legacyKey ?? null, stdoutPath ?? null])
}

const WRITE_ROUNDS_SQL = `
UPDATE runs
   SET review_rounds = ?, final_review_rounds = ?
 WHERE run_id = ? AND host = ?
   AND (review_rounds IS NULL OR review_rounds <= ?)
   AND (final_review_rounds IS NULL OR final_review_rounds <= ?)
`.trim()

export interface WriteRunRoundsInput {
  runId: string
  reviewRounds: number
  finalReviewRounds: number
}

export interface WriteRunRoundsResult {
  ok: boolean
}

/**
 * 單調不回退守衛全在 WHERE：任一欄新值比既有值小就不 matched，整段 UPDATE
 * no-op（ok=false）——兩欄綁在同一次 UPDATE 要嘛都寫要嘛都不寫，tg-monitor
 * 每次算出的兩個值本就是同一次 transcript 掃描的產物，沒有「只有一欄有進展」
 * 時仍要求另一欄單獨寫入的情境。與 sqlite 側 bumpReviewRounds（逐欄 CASE
 * WHEN、可各自獨立前進）語意不同，是刻意的差異，不是疏漏。
 */
export async function writeRunRounds(pool: MonitorDbExecutor, input: WriteRunRoundsInput): Promise<WriteRunRoundsResult> {
  const [header] = await pool.execute<ResultSetHeader>(WRITE_ROUNDS_SQL, [
    input.reviewRounds,
    input.finalReviewRounds,
    input.runId,
    RUNS_HOST,
    input.reviewRounds,
    input.finalReviewRounds,
  ])
  const matched = parseMatched((header as ResultSetHeader).info)
  return { ok: matched !== null && matched > 0 }
}

const ROUNDS_DB_BUDGET_MS = 1000

// migration 004 檔頭載明的 A 包對位慣例：「pipeline 執行期負向快取每 30 秒
// 失效重試」——找不到 run_id 不是永久放棄（mon_ui 那一列可能稍晚才由
// telegram-dispatcher 寫入，下一輪還是要重試），但也不能讓每 3 秒一次的
// ingest tick 對同一個對不到的 key 每次都重打一次 SELECT；改成「同一個 key
// 30 秒內只嘗試一次」的 TTL 負向快取（對抗審查 BLOCKING-1(b)）。
const ROUNDS_RUN_ID_MISS_TTL_MS = 30_000

// 與 cancel 共用同一個 4 連線 mon_ui pool（connectionLimit:4、
// waitForConnections:false，見 getMonitorPool），rounds 這條背景路徑最多同時
// 佔用這麼多連線，搶不到名額的呼叫直接放棄（不排隊），下一輪 ingest tick 自
// 然重試——避免一次 tick 對很多 run 同時發起查詢時把 cancel 擠掉連線（對抗
// 審查 BLOCKING-1(d)）。
const ROUNDS_MAX_CONCURRENT_DB_OPS = 2

export interface PersistRunRoundsInput {
  /** pipeline_runs.key（`<ticket>.<file-ts>`），同時是本函式內部各 cache 的鍵。 */
  key: string
  ticket: string
  /** BUG_RE 命中的 stdout log 絕對路徑；deriveLegacyKey 由此反推 legacy_key，
   * 對不到 legacy_key 時原始路徑仍可直接拿去比對 stdout_path。 */
  stdoutPath: string
  reviewRounds: number
  finalReviewRounds: number
}

// mon_ui 側「上次成功寫入」的輪數，與 ingest.ts 的 sqlite 側 lastPersistedRounds
// 各自獨立追蹤——同一教訓見 ingest.ts 的 lastWrittenServiceStatus 註解：只在
// 這一側真的寫成功後才推進這一側的 cache，任一邊失敗都不影響另一邊的重試。
const lastWrittenRounds = new Map<string, { review: number; final: number }>()
// run_id 只 cache 命中；找不到不 cache（mon_ui 那一列可能是 telegram-dispatcher
// 稍晚才寫入，不能一次找不到就永久放棄，下一輪自然重試——用下面的 TTL 負向
// 快取節流重試頻率，而不是完全不重試）。
const roundsRunIdCache = new Map<string, string>()
// key → 上次「對不到 run_id」的嘗試時間（epoch ms）。TTL 負向快取，見上方常數註解。
const roundsRunIdMissCache = new Map<string, number>()
// key → 是否已經為「目前這一串連續失敗」印過 WARN；成功一次就清掉，讓下一次
// 失敗重新印一次——不是永久靜音，只是同一串連續失敗不重複洗版（對抗審查
// BLOCKING-1(c)）。
const roundsWarnedKeys = new Set<string>()
// 對不到 run_id 的行程內計數（不落 DB、不告警風暴）。
let roundsUnresolvedCount = 0
// 目前同時在跑的 mon_ui rounds DB 操作數，見 ROUNDS_MAX_CONCURRENT_DB_OPS。
let roundsInFlightCount = 0

export function getRoundsUnresolvedCountForTest(): number {
  return roundsUnresolvedCount
}

/** 測試專用：清空本節所有 cache／計數，避免跨測試互相污染（模組級狀態）。 */
export function __resetRoundsMonDbStateForTest(): void {
  lastWrittenRounds.clear()
  roundsRunIdCache.clear()
  roundsRunIdMissCache.clear()
  roundsWarnedKeys.clear()
  roundsUnresolvedCount = 0
  roundsInFlightCount = 0
}

/**
 * 掛在 ingest.ts persistReviewRounds 既有 tick 之後：值有進展才寫、run_id
 * 對位失敗只 skip+計數（帶 TTL 負向快取節流）、有界並發（避免與 cancel 搶
 * mon_ui 連線）、整段套 budgetMs 預算（比照 cancelPipeline 的 Promise.race
 * 慣例，避免 mysql2 對已建立但對端卡死連線沒有 per-query 逾時的已知限制拖住
 * collector tick）。budgetMs / missTtlMs 皆可覆寫，測試可用極小值或 0 確定性
 * 驗證逾時／TTL 分支，不需要真的等待。
 *
 * 失敗/逾時只 WARN（同一 key 連續失敗只印一次）——不落 spool（與 cancel 旗標
 * 不同）：rounds 每個 ingest tick 都會重算，下一輪自然重試，自癒；沒有「這次
 * 沒寫就永久遺失」的風險，落 spool 反而多一套要重放的機制，不成比例。
 */
export async function persistReviewRoundsToMonDb(
  pool: MonitorDbExecutor,
  input: PersistRunRoundsInput,
  budgetMs: number = ROUNDS_DB_BUDGET_MS,
  missTtlMs: number = ROUNDS_RUN_ID_MISS_TTL_MS,
): Promise<{ wrote: boolean }> {
  // 深度防禦：呼叫端（ingest.ts）已在旗標關閉時完全不建 pool、不呼叫到這裡，
  // 這裡自己再擋一次，比照 appendStatusLogToSpool 的慣例。
  if (!isMonitorDbEnabled()) return { wrote: false }
  const last = lastWrittenRounds.get(input.key)
  if (last && input.reviewRounds <= last.review && input.finalReviewRounds <= last.final) return { wrote: false }

  // 有界並發（BLOCKING-1(d)）：名額用滿就直接放棄，不排隊——下一輪 ingest
  // tick 自然重試，不留下未完成的佇列（本函式從不主動累積待辦）。
  if (roundsInFlightCount >= ROUNDS_MAX_CONCURRENT_DB_OPS) return { wrote: false }
  roundsInFlightCount++
  try {
    const attempt = (async (): Promise<WriteRunRoundsResult> => {
      let runId = roundsRunIdCache.get(input.key)
      if (runId === undefined) {
        const now = Date.now()
        const lastMiss = roundsRunIdMissCache.get(input.key)
        if (lastMiss !== undefined && now - lastMiss < missTtlMs) {
          // TTL 負向快取命中：距離上次對不到還沒滿 missTtlMs，不重打 SELECT。
          return { ok: false }
        }
        const legacyKey = deriveLegacyKey(input.stdoutPath)
        const resolved = await resolveRunIdForRounds(pool, input.ticket, legacyKey, input.stdoutPath)
        if (resolved === null) {
          roundsRunIdMissCache.set(input.key, now)
          roundsUnresolvedCount += 1
          return { ok: false }
        }
        runId = resolved
        roundsRunIdCache.set(input.key, runId)
        roundsRunIdMissCache.delete(input.key)
      }
      return writeRunRounds(pool, { runId, reviewRounds: input.reviewRounds, finalReviewRounds: input.finalReviewRounds })
    })()

    let budgetTimer: ReturnType<typeof setTimeout>
    const budget = new Promise<WriteRunRoundsResult>(resolve => {
      budgetTimer = setTimeout(() => resolve({ ok: false }), budgetMs)
    })
    // attempt 若晚於 budget 完成，讓它繼續在背景跑完（不取消，mysql2 沒有內建
    // query cancel）；race 只決定這次呼叫要不要等它推進 cache。
    const raced = await Promise.race([attempt.catch((): WriteRunRoundsResult => ({ ok: false })), budget])
    clearTimeout(budgetTimer!) // NB-2：attempt 先贏的話，budget 那顆計時器已經沒用了，清掉不留空轉的 timer。

    if (raced.ok) {
      lastWrittenRounds.set(input.key, { review: input.reviewRounds, final: input.finalReviewRounds })
      roundsWarnedKeys.delete(input.key)
      return { wrote: true }
    }
    if (!roundsWarnedKeys.has(input.key)) {
      roundsWarnedKeys.add(input.key)
      console.warn(`mon-db: rounds 寫入未成功（ticket=${input.ticket} key=${input.key}），下一輪自然重試（同一 run 連續失敗只印這一次，成功或狀態改變後才會再印）`)
    }
    return { wrote: false }
  } finally {
    roundsInFlightCount--
  }
}

// ─────────────────────────────────────────────────────────────────────────
// spool 落地（複製 telegram-dispatcher/lib/monitor-db/spool/writer.ts 的最小
// 子集：只支援 tg-monitor 這一種 writer 身分、只支援單條 append，不做輪替。
// §6.5(a) 的目錄/檔名格式與硬規則（run_id 不得為空）逐字遵守，讓 head 上的
// 重放者（telegram-dispatcher/server.ts，唯一的重放者，§6.5(d)）能原封不動
// 重放這個檔。
// ─────────────────────────────────────────────────────────────────────────

export const SPOOL_DIR = join(DISPATCHER_LOG_DIR, 'spool')

let spoolFd: number | null = null
let spoolFilePath: string | null = null
let spoolDirUsed: string | null = null
let spoolSeq = 0

function getSpoolFd(dir: string): { fd: number; filePath: string } {
  // 測試用不同 dir 覆寫時，捨棄舊 fd 重開（正式路徑 dir 永遠是 SPOOL_DIR，
  // 這個分支不會在生產流程觸發）。
  if (spoolFd !== null && spoolFilePath !== null && spoolDirUsed === dir) return { fd: spoolFd, filePath: spoolFilePath }
  if (spoolFd !== null) {
    try {
      closeSync(spoolFd)
    } catch {}
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const startEpochMs = Date.now()
  const filePath = join(dir, `tg-monitor.${process.pid}.${startEpochMs}.jsonl`)
  const fd = openSync(filePath, 'a', 0o600)
  spoolFd = fd
  spoolFilePath = filePath
  spoolDirUsed = dir
  spoolSeq = 0
  return { fd, filePath }
}

export interface CancelSpoolEntryArgs {
  runId: string
  host: string
  ticket: string
  kind: RunKind
  cancelRequestedAt: string
  resolvedBy: CancelResolvedBy
  legacyKey: string | null
}

/**
 * cancel 旗標整段（解析＋寫入）逾時或失敗時的退路：把已鑄定的 run_id 連同
 * 旗標內容 append 進本機 spool 檔，交給 head 上的重放者（不是本檔）重放。
 * 【G:MJ-G2】run_id 不得為空——呼叫端必須先完成 resolveRunId 才能走這裡。
 */
export function appendCancelFlagToSpool(args: CancelSpoolEntryArgs, dir: string = SPOOL_DIR): void {
  if (!args.runId) throw new Error('appendCancelFlagToSpool: run_id 不得為空（§6.5(a) 硬規則 / 【G:MJ-G2】）')
  const { fd } = getSpoolFd(dir)
  spoolSeq += 1
  const record = {
    seq: spoolSeq,
    ts: new Date().toISOString(),
    host: args.host,
    run_id: args.runId,
    fn: 'writeCancelFlag',
    args: [
      {
        runId: args.runId,
        ticket: args.ticket,
        kind: args.kind,
        cancelRequestedAt: args.cancelRequestedAt,
        resolvedBy: args.resolvedBy,
        legacyKey: args.legacyKey,
      },
    ],
  }
  const payload = `${JSON.stringify(record)}\n`
  writeSync(fd, payload)
  fsyncSync(fd) // 每次 append 後 fsync（cancel 是低頻路徑，不受 §6.5(a2) 批次 fsync 的熱路徑考量約束）。
}

// ─────────────────────────────────────────────────────────────────────────
// 狀態探測落地（service probe / webhook probe → *_status_log，Phase 4 工作包
// B 新增）。與 appendCancelFlagToSpool 共用同一份 spool fd/seq（同一個 writer
// 身分 'tg-monitor'，一個行程一個檔——fn 欄位區分條目種類）。
//
// run_id 信封欄位：這兩張表（service_status_log / tg_webhook_status_log）
// 在資料模型上不對應任何一次 pipeline run（見
// telegram-dispatcher/deploy/monitor-db/migrations/001-init.sql 的欄位定義，
// 兩表都沒有 run_id 欄）。原始 SpoolEntry.run_id 型別非空、writer.ts 對空字串
// 硬性 throw（MJ-G2），無法比照 cancel 旗標塞入真實 run_id。
// 總指揮裁定（errata，已記錄，不在本檔重複）：SpoolEntry.run_id 契約放寬為
// `string | null`——fn 目標為 runs/agent_runs 者仍必須非空（MJ-G2 原意不變），
// fn ∈ {insertStatusLogRow, upsertMonitorHeartbeat, upsertFileOffset,
// insertMcpUsage, insertTgUnknownSender} 允許 run_id 為 null（列身分本在
// args 內，不靠信封層的 run_id）。本函式對應的 fn 恆為
// 'insertStatusLogRow'，故 run_id 一律顯式寫 null——不是省略欄位，是保持
// SpoolEntry 形狀完整、值為 null。
// ─────────────────────────────────────────────────────────────────────────

/** tg-monitor 這一側只寫這兩張表（worker_status_log 屬於 cluster-head/worker
 * 探測，不在本工作包範圍內，見 plan-db-as-truth-v3.md §11.1）。 */
export const STATUS_LOG_TABLES = ['service_status_log', 'tg_webhook_status_log'] as const
export type StatusLogTable = (typeof STATUS_LOG_TABLES)[number]

export interface StatusLogSpoolEntryArgs {
  table: StatusLogTable
  /** 欄位名，不含 id（auto_increment）。呼叫端負責與實際表結構對齊
   * （見 001-init.sql）；本函式只把白名單之外的表名擋下。 */
  columns: string[]
  /** 與 columns 一一對應的值。時間欄一律由呼叫端先轉成絕對值（
   * isoToMysqlDatetime3），不得是相對時間或執行時求值的表達式（§6.5(a) 硬
   * 規則）。 */
  values: unknown[]
}

/**
 * append 一列 *_status_log 進 spool，交給 head 上的重放者（
 * telegram-dispatcher/server.ts）以 insertStatusLogRow 落庫。
 * args 的形狀比照 telegram-dispatcher/lib/monitor-db/apply-entry.ts 的
 * packStatusLogArgs 慣例：`[[table, columns, values]]`（三個位置參數包成一個
 * tuple）。
 */
export function appendStatusLogToSpool(args: StatusLogSpoolEntryArgs, dir: string = SPOOL_DIR): void {
  // 深度防禦：不只靠呼叫端（ingest.ts / webhook-status.ts）先檢查旗標——本函式
  // 自己也擋一次，任何未來新增的呼叫端就算漏掉外層 isMonitorDbEnabled() 檢查，
  // 也不會在旗標關閉時建出 spool 檔或做任何 I/O。
  if (!isMonitorDbEnabled()) return
  if (!STATUS_LOG_TABLES.includes(args.table)) {
    throw new Error(`appendStatusLogToSpool: 不在白名單內的表名：${args.table}`)
  }
  const { fd } = getSpoolFd(dir)
  spoolSeq += 1
  const record = {
    seq: spoolSeq,
    ts: new Date().toISOString(),
    host: RUNS_HOST,
    run_id: null,
    fn: 'insertStatusLogRow',
    args: [[args.table, args.columns, args.values]],
  }
  const payload = `${JSON.stringify(record)}\n`
  writeSync(fd, payload)
  fsyncSync(fd) // 低頻路徑（探測 tick），不受 §6.5(a2) 批次 fsync 的熱路徑考量約束，比照 appendCancelFlagToSpool 逐次 fsync。
}

// ─────────────────────────────────────────────────────────────────────────
// (host,'tg-monitor') 心跳（實機驗證發現 monitor_heartbeat 恆空後補上，總指揮
// 追加指示）。fn='upsertMonitorHeartbeat'，唯讀查證
// telegram-dispatcher/lib/monitor-db/writes.ts:343-366 的 upsertMonitorHeartbeat
// 與 lib/monitor-db/apply-entry.ts:86-88 的對應 case 後對齊：
//   - args 慣例是 `[input]`（單一物件，不是 insertStatusLogRow 那種
//     `[[table, columns, values]]` tuple）——apply-entry.ts:87 直接把
//     `entry.args[0]` 當 `UpsertHeartbeatInput` 用。
//   - `input.ts` 必須是「絕對 ISO 字串」，不是 MySQL DATETIME(3) 字串：
//     upsertMonitorHeartbeat 內部用 `dt()`（= isoToMysqlDatetime3OrNull，見
//     mysql-datetime.ts:41-43）在 SQL 邊界才轉換，若這裡先轉成
//     'YYYY-MM-DD HH:MM:SS.mmm' 格式，dispatcher 端的 ISO_UTC_RE 會比對失敗、
//     dt() 直接 throw——這與 insertStatusLogRow（呼叫端自己組 SQL 值、沒有
//     dt() 轉換）的慣例不同，不可誤用同一套轉換時機。
//   - `host` 欄不在 UpsertHeartbeatInput 裡：upsertMonitorHeartbeat 內部固定用
//     重放者行程（head 上的 telegram-dispatcher/server.ts）的 MON_HOST，不是
//     呼叫端傳入的值，本函式因此不需要（也不能）在 args 裡帶 host。
//   - `spoolDepth`/`spoolOldestTs`：tg-monitor 是「寫入者」不是「重放者」，
//     §6.5(c) 明文「游標檔由重放者獨佔，寫入者永不碰它」——tg-monitor 沒有
//     任何管道知道自己這一份 spool 檔已被重放到哪個 offset，因此無法算出有意
//     義的 backlog 深度。依總指揮指示「取不到就 null/0」，本函式一律傳 null，
//     不發明假數據。
// ─────────────────────────────────────────────────────────────────────────

/**
 * append 一條 (host,'tg-monitor') 心跳進 spool，交給 head 上的重放者以
 * upsertMonitorHeartbeat 落庫。與 appendStatusLogToSpool 同樣有內建的
 * isMonitorDbEnabled() 深度防禦；呼叫端（lib/ingest.ts 的 60 秒 interval）
 * 仍需自行 try/catch，本函式失敗時直接 throw，不吞例外。
 */
export function appendHeartbeatToSpool(dir: string = SPOOL_DIR): void {
  if (!isMonitorDbEnabled()) return
  const nowIso = new Date().toISOString()
  const { fd } = getSpoolFd(dir)
  spoolSeq += 1
  const record = {
    seq: spoolSeq,
    ts: nowIso,
    host: RUNS_HOST,
    run_id: null,
    fn: 'upsertMonitorHeartbeat',
    args: [{ writer: 'tg-monitor', ts: nowIso, spoolDepth: null, spoolOldestTs: null }],
  }
  const payload = `${JSON.stringify(record)}\n`
  writeSync(fd, payload)
  fsyncSync(fd) // 低頻路徑（60 秒一次），逐次 fsync，比照 appendCancelFlagToSpool / appendStatusLogToSpool。
}

/** 測試 / 行程結束時關閉 spool fd（正式路徑不需要主動呼叫，行程結束時 OS 會回收）。 */
export function closeSpoolForTest(): void {
  if (spoolFd !== null) {
    try {
      closeSync(spoolFd)
    } catch {}
  }
  spoolFd = null
  spoolFilePath = null
  spoolDirUsed = null
  spoolSeq = 0
}
