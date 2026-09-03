// SQLite 事件庫（bun:sqlite，Bun 內建，不需額外套件）。
// 存三類東西：稽核事件（誰對哪個服務做了什麼）、服務狀態變化（up/down 序列）、
// 檔案讀取位移（讓 ingest 重啟後能接著讀，不重複寫入）。

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.TG_MONITOR_DB ?? new URL('../data/monitor.sqlite', import.meta.url).pathname
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,           -- request | auth_failure
  identity TEXT,
  source_ip TEXT,
  method TEXT,
  path TEXT,
  tool TEXT,
  result TEXT,
  agrabah_identifier TEXT,
  duration_ms INTEGER,
  reason TEXT,                   -- auth_failure 的失敗原因
  raw TEXT NOT NULL,
  UNIQUE(service, raw)           -- 同一行 JSON 不重複匯入（輪替 / 重讀保險）
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_service_ts ON events(service, ts);
CREATE INDEX IF NOT EXISTS idx_events_identity_ts ON events(identity, ts);

CREATE TABLE IF NOT EXISTS status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  ts TEXT NOT NULL,
  status TEXT NOT NULL,          -- up | down
  pid INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_status_service_ts ON status_log(service, ts);

CREATE TABLE IF NOT EXISTS file_offsets (
  path TEXT PRIMARY KEY,
  inode INTEGER NOT NULL,
  offset INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  key TEXT PRIMARY KEY,          -- <ticket>.<ts> 即 log 檔 base 名
  kind TEXT NOT NULL,            -- bug | demand
  ticket TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stdout_path TEXT,
  stderr_path TEXT,
  finished_at TEXT,
  outcome TEXT
);
`)
db.exec(`
CREATE TABLE IF NOT EXISTS agent_runs (
  path TEXT PRIMARY KEY,         -- trace JSON 路徑（bug pipeline 則是 stdout.log 路徑）
  ticket TEXT NOT NULL,
  kind TEXT NOT NULL,            -- bug | demand
  stage TEXT NOT NULL,           -- spec-gate | repo-scope | draft-A | review-* | synthesize | classify | create-mr
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER,
  cost_usd REAL,
  num_turns INTEGER,
  tool_calls INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0,
  result_preview TEXT,
  file_mtime TEXT NOT NULL       -- 檔案 mtime，變了才重新解析
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_ticket ON agent_runs(ticket, started_at);
`)
// 既有 DB 補欄位（ALTER 失敗 = 已存在）
try { db.exec('ALTER TABLE pipeline_runs ADD COLUMN cancelled_at TEXT') } catch {}
// 「發起人」欄位：當時透過 Telegram 認領觸發這次 run 的人，讀 telegram-dispatcher
// 寫的 <key>.triggered-by.json sidecar（見 ingest.ts scanPipelineRuns）——跟
// Notion「當前指派」是兩件事，指派會在流程跑完後轉派給別人（見 2026-08-27
// 使用者釐清），不能拿來當「誰觸發」的代理值。沒有 sidecar（人工終端機跑
// /create-mr、自動重試、tg-monitor 手動重試按鈕）就留空，不用 Notion 當前指派
// 頂替——那正是要修掉的誤導來源。
try { db.exec('ALTER TABLE pipeline_runs ADD COLUMN triggered_by TEXT') } catch {}
// 審查輪數持久化（2026-09-02）：Step 6 三位 reviewer 累計輪數（取三者最大值）
// 與 Step 6.5 final-adversarial-reviewer 累計派工次數，各自獨立一欄——執行中
// 從 session transcript 即時推定（見 ingest.ts getReviewRoundCounts），run
// 結束後 pending 清空、階段檢核表的 detail 也跟著消失，這兩欄是唯一在畫面上
// 還留得住輪數的地方。
try { db.exec('ALTER TABLE pipeline_runs ADD COLUMN review_rounds INTEGER') } catch {}
try { db.exec('ALTER TABLE pipeline_runs ADD COLUMN final_review_rounds INTEGER') } catch {}

export type EventRow = {
  id: number
  service: string
  ts: string
  event: string
  identity: string | null
  source_ip: string | null
  method: string | null
  path: string | null
  tool: string | null
  result: string | null
  agrabah_identifier: string | null
  duration_ms: number | null
  reason: string | null
}

const insertEventStmt = db.prepare(`
  INSERT OR IGNORE INTO events
    (service, ts, event, identity, source_ip, method, path, tool, result, agrabah_identifier, duration_ms, reason, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export function insertAuditLine(service: string, raw: string): boolean {
  let j: any
  try {
    j = JSON.parse(raw)
  } catch {
    return false
  }
  if (!j || typeof j !== 'object' || !j.ts) return false
  const r = insertEventStmt.run(
    service,
    String(j.ts),
    String(j.event ?? 'request'),
    j.identity ?? null,
    j.sourceIp ?? null,
    j.method ?? null,
    j.path ?? null,
    j.tool ?? null,
    j.result ?? null,
    j.agrabahIdentifier ?? null,
    typeof j.durationMs === 'number' ? j.durationMs : null,
    j.reason ?? null,
    raw,
  )
  return r.changes > 0
}

export const insertMany = db.transaction((service: string, lines: string[]) => {
  let n = 0
  for (const l of lines) if (insertAuditLine(service, l)) n++
  return n
})

const getOffsetStmt = db.prepare('SELECT inode, offset FROM file_offsets WHERE path = ?')
const setOffsetStmt = db.prepare(
  'INSERT INTO file_offsets (path, inode, offset) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, offset = excluded.offset',
)
export function getOffset(path: string): { inode: number; offset: number } | null {
  return (getOffsetStmt.get(path) as any) ?? null
}
export function setOffset(path: string, inode: number, offset: number) {
  setOffsetStmt.run(path, inode, offset)
}

const lastStatusStmt = db.prepare('SELECT status FROM status_log WHERE service = ? ORDER BY id DESC LIMIT 1')
const insertStatusStmt = db.prepare('INSERT INTO status_log (service, ts, status, pid, detail) VALUES (?, ?, ?, ?, ?)')
/** 只在狀態翻轉時寫一筆（第一次觀測也寫），回傳是否有寫入 */
export function recordStatusIfChanged(service: string, status: 'up' | 'down', pid: number | null, detail: string | null): boolean {
  const last = lastStatusStmt.get(service) as { status: string } | undefined
  if (last?.status === status) return false
  insertStatusStmt.run(service, new Date().toISOString(), status, pid, detail)
  return true
}

const upsertRunStmt = db.prepare(`
  INSERT INTO pipeline_runs (key, kind, ticket, started_at, stdout_path, stderr_path, triggered_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO NOTHING
`)
const finishRunStmt = db.prepare("UPDATE pipeline_runs SET finished_at = ?, outcome = CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' ELSE ? END WHERE key = ? AND finished_at IS NULL")
const markCancelledStmt = db.prepare('UPDATE pipeline_runs SET cancelled_at = ? WHERE kind = ? AND ticket = ? AND finished_at IS NULL')
export function markCancelled(kind: string, ticket: string) {
  markCancelledStmt.run(new Date().toISOString(), kind, ticket)
}
export function upsertRun(key: string, kind: string, ticket: string, startedAt: string, stdoutPath: string, stderrPath: string, triggeredBy: string | null = null) {
  upsertRunStmt.run(key, kind, ticket, startedAt, stdoutPath, stderrPath, triggeredBy)
}
export function finishRun(key: string, finishedAt: string, outcome: string) {
  finishRunStmt.run(finishedAt, outcome, key)
}
// 2026-08-28：重複觸發事故（FAQ-4768 連點兩次）後新增——以 stdout 路徑歸戶
// 發現某 run 的行程其實還活著、但列已被先前「同票最新一次才可能 running」的
// 舊邏輯誤結案時，把終態清掉讓它回到執行中。
const reopenRunStmt = db.prepare('UPDATE pipeline_runs SET finished_at = NULL, outcome = NULL WHERE key = ? AND finished_at IS NOT NULL')
export function reopenRun(key: string) {
  reopenRunStmt.run(key)
}

// 只增不減：新值沒超過既有值就不動該欄位（冪等，容忍同一輪被重複呼叫多次）。
// null 代表「這次沒有新資訊」，跳過該欄位、不會把既有值蓋成 null。
const bumpReviewRoundsStmt = db.prepare(`
  UPDATE pipeline_runs SET
    review_rounds = CASE WHEN @review_rounds IS NOT NULL AND (review_rounds IS NULL OR review_rounds < @review_rounds) THEN @review_rounds ELSE review_rounds END,
    final_review_rounds = CASE WHEN @final_review_rounds IS NOT NULL AND (final_review_rounds IS NULL OR final_review_rounds < @final_review_rounds) THEN @final_review_rounds ELSE final_review_rounds END
  WHERE key = @key
`)
export function bumpReviewRounds(key: string, reviewRounds: number | null, finalReviewRounds: number | null) {
  // bun:sqlite 具名參數：綁定物件的 key 要帶 @ 前綴（同 upsertAgentRun 的既有
  // 註記）。裸 key 不是錯誤而是**靜默綁 NULL**：@x IS NOT NULL 恆 false、
  // WHERE key=NULL 恆不中 → changes=0 的完美 no-op——本函式因此從 2026-09-02
  // 誕生起一次都沒寫進去過（53 列全 NULL），UI 即時輪數走 getReviewRoundCounts
  // 現算所以畫面一直是好的，直到 b5 的雙軌逐欄擋門照出來（2026-09-03 修）。
  // 這一類坑由 db.named-binding.test.ts 的綁定形式掃描釘住，不只釘本函式。
  bumpReviewRoundsStmt.run({ '@key': key, '@review_rounds': reviewRounds, '@final_review_rounds': finalReviewRounds } as never)
}

const agentMtimeStmt = db.prepare('SELECT file_mtime FROM agent_runs WHERE path = ?')
const upsertAgentStmt = db.prepare(`
  INSERT INTO agent_runs (path, ticket, kind, stage, started_at, ended_at, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, num_turns, tool_calls, is_error, result_preview, file_mtime)
  VALUES (@path, @ticket, @kind, @stage, @started_at, @ended_at, @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_create_tokens, @cost_usd, @num_turns, @tool_calls, @is_error, @result_preview, @file_mtime)
  ON CONFLICT(path) DO UPDATE SET ended_at=excluded.ended_at, model=excluded.model, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
    cache_read_tokens=excluded.cache_read_tokens, cache_create_tokens=excluded.cache_create_tokens, cost_usd=excluded.cost_usd, num_turns=excluded.num_turns,
    tool_calls=excluded.tool_calls, is_error=excluded.is_error, result_preview=excluded.result_preview, file_mtime=excluded.file_mtime
`)
export function agentRunMtime(path: string): string | null {
  return (agentMtimeStmt.get(path) as any)?.file_mtime ?? null
}
export function upsertAgentRun(row: Record<string, unknown>) {
  // bun:sqlite 具名參數：綁定物件的 key 要帶 @ 前綴
  const bound: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) bound[`@${k}`] = v ?? null
  upsertAgentStmt.run(bound as any)
}
