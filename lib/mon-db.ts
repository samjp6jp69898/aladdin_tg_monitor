// lib/mon-db.ts — mon_ui 監控 DB 最小寫入模組（cancel 專用）。
//
// 依據 plan-db-as-truth-v3.2.md 裁定 3（BL-E3）＋【G:BL-G2】＋
// impl-errata-g2.md MJ-H1 指揮官裁定，與 telegram-dispatcher 端的
// lib/monitor-db/{env,pool,mysql-datetime,writes,cancel-resolve}.ts 是同一套
// 演算法的兩份獨立實作——**這不是疏漏，是既有慣例**：tg-monitor 是獨立 git
// repo，與 telegram-dispatcher 沒有 import 關係（見 lib/ingest.ts 既有的
// CREATE_MR_TIMEOUT_SECONDS 註解：「兩個 repo 各自獨立、沒有 import 關係，
// 這裡只能複製常數，改動時要同步調整」）。本檔複製的是「cancel 路徑」用得到
// 的最小子集：mon_ui pool、五段 run_id 解析、W4a/W4b 兩段寫、cancel 旗標寫入
// 失敗時的 spool 落地。**兩邊改動時要同步調整**（尤其：SQL 文字、
// cancel_resolved_by 值域、legacy_key 格式）。
//
// 職責邊界（§2.2 mon_ui 授權）：唯讀九張表（本檔完全不碰）＋ `runs` 的 cancel
// 欄位級 INSERT/UPDATE。`outcome` / `outcome_tier` 不在本檔任何 SQL 的欄位
// 清單內。
//
// 全部功能都在 isMonitorDbEnabled() 之後才會被呼叫——旗標關閉時本檔的任何
// 函式都不會被呼叫到（見 lib/ingest.ts cancelPipeline 的守衛），import 本身
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
