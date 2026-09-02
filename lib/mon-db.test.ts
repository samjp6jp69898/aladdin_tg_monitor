// lib/mon-db.test.ts — mon_ui 最小寫入模組（cancel 旗標 + rounds 兩欄）結構性測試。
//
// 不打真實 mon-mysql（沒有 mysql2 real client），注入假 pool（同 telegram-
// dispatcher/lib/monitor-db/cancel-resolve.test.ts 的手法）。cancel 相關測試
// 驗證 tg-monitor 這一份「複製過來的演算法」與 telegram-dispatcher 端的
// lib/monitor-db/cancel-resolve.ts 行為一致（次序、R2 自我驗證、markerMismatch），
// 不是重新驗證 MySQL 語意本身；rounds 相關測試（resolveRunIdForRounds /
// writeRunRounds / persistReviewRoundsToMonDb）是 tg-monitor 獨有邏輯，沒有
// telegram-dispatcher 對應實作可比對，直接驗證本檔自己的行為契約。
import './test-tmp-db.ts' // 必須排在 ./ingest.ts 之前：把 sqlite 導向暫存檔（NB-7）
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCancelFlagToSpool,
  closeSpoolForTest,
  deriveLegacyKey,
  isoToMysqlDatetime3,
  readActiveMarker,
  resolveRunId,
  writeCancelFlag,
  resolveRunIdForRounds,
  writeRunRounds,
  persistReviewRoundsToMonDb,
  getRoundsUnresolvedCountForTest,
  __resetRoundsMonDbStateForTest,
  type ResolveRunIdInput,
} from './mon-db.ts'
// 注意 import 順序：./test-tmp-db.ts 必須在本行之前（ingest.ts → db.ts 會在
// import 當下開 sqlite）。
import { persistReviewRoundsToMonDbGuarded, isRoundsMonDbEligible } from './ingest.ts'

// ---------- resolveRunId：假 pool，比對邏輯與 cancel-resolve.ts 相同 ----------

interface FakeRow {
  run_id: string
  host: string
  ticket: string
  kind: string
  lifecycle_rank: number
  outcome: string | null
  pid: number | null
  legacy_key: string | null
  stdout_path: string | null
  started_at: string | null
  created_at: string
}

function sqlEq(a: unknown, b: unknown): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && a === b
}

class FakePool {
  rows: FakeRow[] = []
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    if (sql.includes('pid IN')) {
      const [host, ticket, kind, ...pids] = params as [string, string, string, ...number[]]
      const matched = this.rows.filter(
        r => r.host === host && r.ticket === ticket && r.kind === kind && r.lifecycle_rank === 30 && r.outcome === null && r.pid !== null && pids.includes(r.pid),
      )
      return [matched.map(r => ({ run_id: r.run_id })), []]
    }
    if (sql.includes('legacy_key = ?')) {
      const [host, ticket, kind, legacyKey, stdoutPath] = params as [string, string, string, string | null, string | null]
      const matched = this.rows.filter(
        r =>
          r.host === host &&
          r.ticket === ticket &&
          r.kind === kind &&
          r.lifecycle_rank === 30 &&
          r.outcome === null &&
          (sqlEq(r.legacy_key, legacyKey) || sqlEq(r.stdout_path, stdoutPath)),
      )
      return [matched.map(r => ({ run_id: r.run_id })), []]
    }
    if (sql.includes('ORDER BY started_at DESC')) {
      const [host, ticket, kind] = params as [string, string, string]
      const matched = this.rows
        .filter(r => r.host === host && r.ticket === ticket && r.kind === kind && r.lifecycle_rank === 30 && r.outcome === null)
        .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '') || b.created_at.localeCompare(a.created_at))
      return [matched.length > 0 ? [{ run_id: matched[0]!.run_id }] : [], []]
    }
    // writeCancelFlag 的 UPDATE/INSERT 走另一個假 executor（FakeWritePool），不會到這裡。
    throw new Error(`FakePool: 未預期的 SQL：${sql}`)
  }
}

function makeRow(overrides: Partial<FakeRow> & { run_id: string }): FakeRow {
  return {
    host: 'head',
    ticket: 'FAQ-1',
    kind: 'bug',
    lifecycle_rank: 30,
    outcome: null,
    pid: null,
    legacy_key: null,
    stdout_path: null,
    started_at: null,
    created_at: '2026-09-02 00:00:00.000',
    ...overrides,
  }
}

function baseInput(overrides: Partial<ResolveRunIdInput> = {}): ResolveRunIdInput {
  return {
    kind: 'bug',
    ticket: 'FAQ-1',
    target: { pid: 100, pidSet: [100] },
    legacyKey: null,
    stdoutPath: null,
    marker: { runId: null, kind: null },
    ...overrides,
  }
}

describe('resolveRunId（tg-monitor 端複製品）— 與 telegram-dispatcher 的 cancel-resolve.ts 同次序', () => {
  test('R1 命中 → pid_match', async () => {
    const pool = new FakePool()
    pool.rows.push(makeRow({ run_id: 'run-old', pid: 100 }))
    const result = await resolveRunId(pool, baseInput())
    expect(result).toEqual({ runId: 'run-old', resolvedBy: 'pid_match', markerMismatch: false })
  })

  test('MJ-H1：同票 auto-retry 交疊 + R1 失效 → R3（legacy_key）優先於已被覆寫的 R2 marker', async () => {
    const pool = new FakePool()
    pool.rows.push(makeRow({ run_id: 'run-old-uuid', ticket: 'FAQ-99', pid: null, legacy_key: 'FAQ-99.2026-09-02T10:00:00.000Z' }))
    pool.rows.push(makeRow({ run_id: 'run-new-uuid', ticket: 'FAQ-99', pid: 200, legacy_key: 'FAQ-99.2026-09-02T12:00:00.000Z' }))

    const input = baseInput({
      ticket: 'FAQ-99',
      target: { pid: 9999, pidSet: [9999] },
      legacyKey: 'FAQ-99.2026-09-02T10:00:00.000Z',
      marker: { runId: 'run-new-uuid', kind: 'bug' }, // marker 已被 auto-retry 覆寫
    })

    const result = await resolveRunId(pool, input)
    expect(result.runId).toBe('run-old-uuid')
    expect(result.resolvedBy).toBe('legacy_key')
    expect(result.markerMismatch).toBe(false)
  })

  test('R2 命中但 kind 不一致 → mismatch，降級到 R4', async () => {
    const pool = new FakePool()
    pool.rows.push(makeRow({ run_id: 'run-latest', started_at: '2026-09-02T00:05:00.000Z', created_at: '2026-09-02 00:05:00.000' }))
    const result = await resolveRunId(pool, baseInput({ marker: { runId: 'run-marker', kind: 'demand' } }))
    expect(result).toEqual({ runId: 'run-latest', resolvedBy: 'latest_running', markerMismatch: true })
  })

  test('全部落空 → placeholder（合法 UUID）', async () => {
    const pool = new FakePool()
    const result = await resolveRunId(pool, baseInput())
    expect(result.resolvedBy).toBe('placeholder')
    expect(result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})

// ---------- deriveLegacyKey ----------

describe('deriveLegacyKey', () => {
  test('由 bug pipeline 的 stdout log 絕對路徑反推 <ticket>.<ISO>', () => {
    const key = deriveLegacyKey('/Users/user/aladdin/telegram-dispatcher/logs/FAQ-1234.2026-09-02T10-00-00-000Z.stdout.log')
    expect(key).toBe('FAQ-1234.2026-09-02T10:00:00.000Z')
  })

  test('demand pipeline 的檔名格式也能反推', () => {
    const key = deriveLegacyKey('/Users/user/aladdin/telegram-dispatcher/logs/FAQ-5678.2026-09-02T11-30-00-000Z.demand-pipeline.stdout.log')
    expect(key).toBe('FAQ-5678.2026-09-02T11:30:00.000Z')
  })

  test('格式對不上 → null（呼叫端降級到下一段，不是硬錯誤）', () => {
    expect(deriveLegacyKey('/some/random/path.log')).toBeNull()
  })
})

// ---------- readActiveMarker（暫存目錄，不碰真實 telegram-dispatcher/logs） ----------

describe('readActiveMarker', () => {
  let dir: string
  test('新格式 JSON：kind 一致才回傳 runId', () => {
    dir = mkdtempSync(join(tmpdir(), 'mon-db-marker-'))
    writeFileSync(join(dir, 'FAQ-1'), JSON.stringify({ startedAt: '2026-09-02T00:00:00.000Z', runId: '11111111-1111-4111-8111-111111111111', kind: 'bug' }))
    const marker = readActiveMarker('bug', 'FAQ-1', dir)
    expect(marker).toEqual({ runId: '11111111-1111-4111-8111-111111111111', kind: 'bug' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('舊格式（純 ISO 字串）→ runId/kind 皆 null（不可用，非 mismatch）', () => {
    dir = mkdtempSync(join(tmpdir(), 'mon-db-marker-'))
    writeFileSync(join(dir, 'FAQ-2'), '2026-09-02T00:00:00.000Z')
    const marker = readActiveMarker('bug', 'FAQ-2', dir)
    expect(marker).toEqual({ runId: null, kind: null })
    rmSync(dir, { recursive: true, force: true })
  })

  test('檔案不存在 → runId/kind 皆 null', () => {
    dir = mkdtempSync(join(tmpdir(), 'mon-db-marker-'))
    const marker = readActiveMarker('bug', 'FAQ-NOPE', dir)
    expect(marker).toEqual({ runId: null, kind: null })
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------- appendCancelFlagToSpool ----------

describe('appendCancelFlagToSpool', () => {
  let dir: string
  afterEach(() => {
    closeSpoolForTest()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('寫出的每一行都是合法 JSON，且 run_id 非空、fn=writeCancelFlag', () => {
    dir = mkdtempSync(join(tmpdir(), 'mon-db-spool-'))
    appendCancelFlagToSpool(
      { runId: 'run-1', host: 'head', ticket: 'FAQ-1', kind: 'bug', cancelRequestedAt: '2026-09-02T00:00:00.000Z', resolvedBy: 'pid_match', legacyKey: null },
      dir,
    )
    const files = require('node:fs').readdirSync(dir) as string[]
    const dataFile = files.find((f: string) => f.endsWith('.jsonl'))
    expect(dataFile).toBeDefined()
    const lines = readFileSync(join(dir, dataFile!), 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]!)
    expect(entry.run_id).toBe('run-1')
    expect(entry.fn).toBe('writeCancelFlag')
    expect(entry.seq).toBe(1)
  })

  test('run_id 為空字串時拒絕寫入（【G:MJ-G2】硬規則）', () => {
    dir = mkdtempSync(join(tmpdir(), 'mon-db-spool-'))
    expect(() =>
      appendCancelFlagToSpool(
        { runId: '', host: 'head', ticket: 'FAQ-1', kind: 'bug', cancelRequestedAt: '2026-09-02T00:00:00.000Z', resolvedBy: 'placeholder', legacyKey: null },
        dir,
      ),
    ).toThrow()
  })

  test('連續兩次 append 的 seq 遞增', () => {
    dir = mkdtempSync(join(tmpdir(), 'mon-db-spool-'))
    appendCancelFlagToSpool({ runId: 'run-1', host: 'head', ticket: 'FAQ-1', kind: 'bug', cancelRequestedAt: '2026-09-02T00:00:00.000Z', resolvedBy: 'pid_match', legacyKey: null }, dir)
    appendCancelFlagToSpool({ runId: 'run-2', host: 'head', ticket: 'FAQ-2', kind: 'bug', cancelRequestedAt: '2026-09-02T00:01:00.000Z', resolvedBy: 'marker', legacyKey: null }, dir)
    const files = require('node:fs').readdirSync(dir) as string[]
    const dataFile = files.find((f: string) => f.endsWith('.jsonl'))!
    const lines = readFileSync(join(dir, dataFile), 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!).seq).toBe(1)
    expect(JSON.parse(lines[1]!).seq).toBe(2)
  })
})

// ---------- writeCancelFlag（W4a/W4b，假 executor，比對 telegram-dispatcher 的 writes.ts 同語意） ----------

interface FakeWriteRow {
  run_id: string
  host: string
  ticket: string
  kind: string
  cancel_requested_at: string | null
  cancel_resolved_by: string | null
  legacy_key: string | null
}

class FakeWritePool {
  rows = new Map<string, FakeWriteRow>()
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    if (sql.startsWith('UPDATE runs')) {
      const [cancelRequestedAt, resolvedBy, runId, host] = params as [string, string, string, string]
      const row = this.rows.get(runId)
      if (!row || row.host !== host) return [{ info: 'Rows matched: 0  Changed: 0  Warnings: 0' }, []]
      row.cancel_requested_at = row.cancel_requested_at ?? cancelRequestedAt
      row.cancel_resolved_by = row.cancel_resolved_by ?? resolvedBy
      return [{ info: 'Rows matched: 1  Changed: 1  Warnings: 0' }, []]
    }
    if (sql.startsWith('INSERT INTO runs')) {
      const [runId, host, ticket, kind, cancelRequestedAt, resolvedBy, legacyKey] = params as [string, string, string, string, string, string, string | null]
      if (this.rows.has(runId)) {
        const err = new Error('dup') as Error & { code: string }
        err.code = 'ER_DUP_ENTRY'
        throw err
      }
      this.rows.set(runId, { run_id: runId, host, ticket, kind, cancel_requested_at: cancelRequestedAt, cancel_resolved_by: resolvedBy, legacy_key: legacyKey })
      return [{ affectedRows: 1 }, []]
    }
    throw new Error(`FakeWritePool: 未預期的 SQL：${sql}`)
  }
}

describe('writeCancelFlag（W4a → W4b）', () => {
  test('列不存在 → W4b 建佔位列', async () => {
    const pool = new FakeWritePool()
    const r = await writeCancelFlag(pool, { runId: 'run-1', ticket: 'FAQ-1', kind: 'bug', cancelRequestedAt: '2026-09-02T00:00:00.000Z', resolvedBy: 'placeholder', legacyKey: 'FAQ-1.x' })
    expect(r.ok).toBe(true)
    expect(pool.rows.get('run-1')!.cancel_requested_at).toBe('2026-09-02 00:00:00.000')
  })

  test('列已存在 → W4a 命中，冪等（COALESCE）', async () => {
    const pool = new FakeWritePool()
    await writeCancelFlag(pool, { runId: 'run-1', ticket: 'FAQ-1', kind: 'bug', cancelRequestedAt: '2026-09-02T00:00:00.000Z', resolvedBy: 'pid_match' })
    const r = await writeCancelFlag(pool, { runId: 'run-1', ticket: 'FAQ-1', kind: 'bug', cancelRequestedAt: '2026-09-02T00:05:00.000Z', resolvedBy: 'placeholder' })
    expect(r.ok).toBe(true)
    expect(pool.rows.get('run-1')!.cancel_resolved_by).toBe('pid_match') // 第一次寫的沒被覆蓋
  })
})

describe('isoToMysqlDatetime3', () => {
  test('轉換格式與 telegram-dispatcher 端一致', () => {
    expect(isoToMysqlDatetime3('2026-09-02T00:01:02.345Z')).toBe('2026-09-02 00:01:02.345')
  })
})

// ---------- resolveRunIdForRounds（legacy_key/stdout_path 對位，無 lifecycle 篩選） ----------

interface FakeRoundsRow {
  run_id: string
  host: string
  ticket: string
  legacy_key: string | null
  stdout_path: string | null
}

class FakeRoundsResolvePool {
  rows: FakeRoundsRow[] = []
  calls: unknown[][] = []
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push(params)
    if (!sql.includes('legacy_key = ? OR stdout_path = ?')) throw new Error(`FakeRoundsResolvePool: 未預期的 SQL：${sql}`)
    const [host, ticket, legacyKey, stdoutPath] = params as [string, string, string | null, string | null]
    const matched = this.rows.filter(r => r.host === host && r.ticket === ticket && (sqlEq(r.legacy_key, legacyKey) || sqlEq(r.stdout_path, stdoutPath)))
    return [matched.map(r => ({ run_id: r.run_id })), []]
  }
}

describe('resolveRunIdForRounds', () => {
  test('legacy_key 命中 → run_id', async () => {
    const pool = new FakeRoundsResolvePool()
    pool.rows.push({ run_id: 'run-1', host: 'head', ticket: 'FAQ-1', legacy_key: 'FAQ-1.2026-09-02T00:00:00.000Z', stdout_path: null })
    const runId = await resolveRunIdForRounds(pool, 'FAQ-1', 'FAQ-1.2026-09-02T00:00:00.000Z', null)
    expect(runId).toBe('run-1')
  })

  test('legacy_key 對不上但 stdout_path 對得上 → run_id（OR 語意）', async () => {
    const pool = new FakeRoundsResolvePool()
    pool.rows.push({ run_id: 'run-2', host: 'head', ticket: 'FAQ-1', legacy_key: null, stdout_path: '/logs/FAQ-1.2026-09-02T00-00-00-000Z.stdout.log' })
    const runId = await resolveRunIdForRounds(pool, 'FAQ-1', 'FAQ-1.2026-09-02T00:00:00.000Z', '/logs/FAQ-1.2026-09-02T00-00-00-000Z.stdout.log')
    expect(runId).toBe('run-2')
  })

  test('legacy_key、stdout_path 皆為 null → 不查詢，直接回 null', async () => {
    const pool = new FakeRoundsResolvePool()
    const runId = await resolveRunIdForRounds(pool, 'FAQ-1', null, null)
    expect(runId).toBeNull()
    expect(pool.calls.length).toBe(0)
  })

  test('找不到任何列 → null（不猜、不鑄新列）', async () => {
    const pool = new FakeRoundsResolvePool()
    const runId = await resolveRunIdForRounds(pool, 'FAQ-1', 'FAQ-1.no-such', null)
    expect(runId).toBeNull()
  })

  test('命中多列（歧義）→ null，不猜', async () => {
    const pool = new FakeRoundsResolvePool()
    pool.rows.push({ run_id: 'run-a', host: 'head', ticket: 'FAQ-1', legacy_key: 'k', stdout_path: null })
    pool.rows.push({ run_id: 'run-b', host: 'head', ticket: 'FAQ-1', legacy_key: 'k', stdout_path: null })
    const runId = await resolveRunIdForRounds(pool, 'FAQ-1', 'k', null)
    expect(runId).toBeNull()
  })

  test("SQL 形狀：篩 kind='bug'，與 cancel R3 對齊（NB-3）", async () => {
    class SqlCapturePool {
      lastSql = ''
      async execute(sql: string, _params: unknown[] = []): Promise<[unknown, unknown]> {
        this.lastSql = sql
        return [[], []]
      }
    }
    const pool = new SqlCapturePool()
    await resolveRunIdForRounds(pool, 'FAQ-1', 'k', null)
    expect(pool.lastSql).toContain("kind = 'bug'")
  })
})

// ---------- writeRunRounds（單調不回退守衛全在 WHERE） ----------

interface FakeRoundsWriteRow {
  run_id: string
  host: string
  review_rounds: number | null
  final_review_rounds: number | null
}

class FakeRoundsWritePool {
  rows = new Map<string, FakeRoundsWriteRow>()
  calls: { sql: string; params: unknown[] }[] = []
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push({ sql, params })
    if (!sql.startsWith('UPDATE runs')) throw new Error(`FakeRoundsWritePool: 未預期的 SQL：${sql}`)
    // 守衛 SQL 形狀斷言（測試檔直接檢查文字，確保 WHERE 子句真的把兩欄的
    // 單調不回退檢查都包進去，不是只在應用層做）。
    expect(sql).toContain('review_rounds = ?')
    expect(sql).toContain('final_review_rounds = ?')
    expect(sql).toContain('review_rounds IS NULL OR review_rounds <=')
    expect(sql).toContain('final_review_rounds IS NULL OR final_review_rounds <=')
    const [reviewRounds, finalReviewRounds, runId, host] = params as [number, number, string, string]
    const row = this.rows.get(runId)
    if (!row || row.host !== host) return [{ info: 'Rows matched: 0  Changed: 0  Warnings: 0' }, []]
    const reviewOk = row.review_rounds === null || row.review_rounds <= reviewRounds
    const finalOk = row.final_review_rounds === null || row.final_review_rounds <= finalReviewRounds
    if (!reviewOk || !finalOk) return [{ info: 'Rows matched: 0  Changed: 0  Warnings: 0' }, []]
    row.review_rounds = reviewRounds
    row.final_review_rounds = finalReviewRounds
    return [{ info: 'Rows matched: 1  Changed: 1  Warnings: 0' }, []]
  }
}

describe('writeRunRounds', () => {
  test('既有值皆為 NULL → 直寫，ok=true', async () => {
    const pool = new FakeRoundsWritePool()
    pool.rows.set('run-1', { run_id: 'run-1', host: 'head', review_rounds: null, final_review_rounds: null })
    const r = await writeRunRounds(pool, { runId: 'run-1', reviewRounds: 2, finalReviewRounds: 1 })
    expect(r.ok).toBe(true)
    expect(pool.rows.get('run-1')).toEqual({ run_id: 'run-1', host: 'head', review_rounds: 2, final_review_rounds: 1 })
  })

  test('新值皆大於既有值 → 更新，ok=true', async () => {
    const pool = new FakeRoundsWritePool()
    pool.rows.set('run-1', { run_id: 'run-1', host: 'head', review_rounds: 1, final_review_rounds: 0 })
    const r = await writeRunRounds(pool, { runId: 'run-1', reviewRounds: 2, finalReviewRounds: 1 })
    expect(r.ok).toBe(true)
    expect(pool.rows.get('run-1')!.review_rounds).toBe(2)
  })

  test('review_rounds 回退 → 整段不寫，ok=false（final_review_rounds 即使前進也不救）', async () => {
    const pool = new FakeRoundsWritePool()
    pool.rows.set('run-1', { run_id: 'run-1', host: 'head', review_rounds: 3, final_review_rounds: 0 })
    const r = await writeRunRounds(pool, { runId: 'run-1', reviewRounds: 1, finalReviewRounds: 5 })
    expect(r.ok).toBe(false)
    expect(pool.rows.get('run-1')).toEqual({ run_id: 'run-1', host: 'head', review_rounds: 3, final_review_rounds: 0 })
  })

  test('run_id 對不到列 → ok=false', async () => {
    const pool = new FakeRoundsWritePool()
    const r = await writeRunRounds(pool, { runId: 'run-nope', reviewRounds: 1, finalReviewRounds: 0 })
    expect(r.ok).toBe(false)
  })
})

// ---------- persistReviewRoundsToMonDb（cache + 1000ms 預算，budgetMs 可覆寫供測試） ----------

class FakeRoundsFullPool {
  resolveRows: FakeRoundsRow[] = []
  writeRows = new Map<string, FakeRoundsWriteRow>()
  calls: { kind: 'resolve' | 'write'; params: unknown[] }[] = []
  async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    if (sql.includes('legacy_key = ? OR stdout_path = ?')) {
      this.calls.push({ kind: 'resolve', params })
      const [host, ticket, legacyKey, stdoutPath] = params as [string, string, string | null, string | null]
      const matched = this.resolveRows.filter(r => r.host === host && r.ticket === ticket && (sqlEq(r.legacy_key, legacyKey) || sqlEq(r.stdout_path, stdoutPath)))
      return [matched.map(r => ({ run_id: r.run_id })), []]
    }
    if (sql.startsWith('UPDATE runs')) {
      this.calls.push({ kind: 'write', params })
      const [reviewRounds, finalReviewRounds, runId, host] = params as [number, number, string, string]
      const row = this.writeRows.get(runId)
      if (!row || row.host !== host) return [{ info: 'Rows matched: 0  Changed: 0  Warnings: 0' }, []]
      const reviewOk = row.review_rounds === null || row.review_rounds <= reviewRounds
      const finalOk = row.final_review_rounds === null || row.final_review_rounds <= finalReviewRounds
      if (!reviewOk || !finalOk) return [{ info: 'Rows matched: 0  Changed: 0  Warnings: 0' }, []]
      row.review_rounds = reviewRounds
      row.final_review_rounds = finalReviewRounds
      return [{ info: 'Rows matched: 1  Changed: 1  Warnings: 0' }, []]
    }
    throw new Error(`FakeRoundsFullPool: 未預期的 SQL：${sql}`)
  }
}

function setMonDbFlag(v: string | undefined): () => void {
  const orig = process.env.MON_DB_ENABLED
  if (v === undefined) delete process.env.MON_DB_ENABLED
  else process.env.MON_DB_ENABLED = v
  return () => {
    if (orig === undefined) delete process.env.MON_DB_ENABLED
    else process.env.MON_DB_ENABLED = orig
  }
}

describe('persistReviewRoundsToMonDb', () => {
  let restoreFlag: () => void
  afterEach(() => {
    __resetRoundsMonDbStateForTest()
    restoreFlag?.()
  })

  test('MON_DB_ENABLED 關閉（深度防禦）→ 零呼叫零副作用', async () => {
    restoreFlag = setMonDbFlag(undefined)
    const pool = new FakeRoundsFullPool()
    const r = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-1.a', ticket: 'FAQ-1', stdoutPath: '/logs/FAQ-1.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(r.wrote).toBe(false)
    expect(pool.calls.length).toBe(0)
  })

  test('值變化 → 對位 + 寫入，成功才推進 cache；同 key 再次相同/更小的值不再呼叫 pool', async () => {
    restoreFlag = setMonDbFlag('1')
    const pool = new FakeRoundsFullPool()
    pool.resolveRows.push({ run_id: 'run-1', host: 'head', ticket: 'FAQ-1', legacy_key: null, stdout_path: '/logs/FAQ-1.a.stdout.log' })
    pool.writeRows.set('run-1', { run_id: 'run-1', host: 'head', review_rounds: null, final_review_rounds: null })

    const r1 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-1.a', ticket: 'FAQ-1', stdoutPath: '/logs/FAQ-1.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(r1.wrote).toBe(true)
    expect(pool.calls.map(c => c.kind)).toEqual(['resolve', 'write'])
    expect(pool.writeRows.get('run-1')).toEqual({ run_id: 'run-1', host: 'head', review_rounds: 1, final_review_rounds: 0 })

    pool.calls = []
    const r2 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-1.a', ticket: 'FAQ-1', stdoutPath: '/logs/FAQ-1.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(r2.wrote).toBe(false)
    expect(pool.calls.length).toBe(0) // 值沒進展 → 不呼叫 pool，也不必重解 run_id

    pool.calls = []
    const r3 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-1.a', ticket: 'FAQ-1', stdoutPath: '/logs/FAQ-1.a.stdout.log', reviewRounds: 2, finalReviewRounds: 0 })
    expect(r3.wrote).toBe(true)
    // run_id 已 cache（上次成功解析過）→ 這次只有 write，不再 resolve。
    expect(pool.calls.map(c => c.kind)).toEqual(['write'])
  })

  test('對不到 run_id → skip（wrote=false）、計數 +1、不猜不鑄新列；TTL 期間內（預設 30 秒）不重複查詢（BLOCKING-1(b) TTL 負向快取）', async () => {
    restoreFlag = setMonDbFlag('1')
    const pool = new FakeRoundsFullPool() // resolveRows 空 → 永遠對不到
    const before = getRoundsUnresolvedCountForTest()

    const r1 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-2.a', ticket: 'FAQ-2', stdoutPath: '/logs/FAQ-2.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(r1.wrote).toBe(false)
    expect(getRoundsUnresolvedCountForTest()).toBe(before + 1)
    expect(pool.calls.map(c => c.kind)).toEqual(['resolve']) // 對不到就不會有 write

    // 下一輪（值又進展了）緊接著再試一次：兩次呼叫間隔只有幾毫秒的真實時間，
    // 遠小於預設 30 秒的 TTL 窗——這是靠「兩次呼叫本來就很快連續發生」這個
    // 事實成立，不是靠等待時間讓測試通過，不違反禁 sleep。
    pool.calls = []
    const r2 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-2.a', ticket: 'FAQ-2', stdoutPath: '/logs/FAQ-2.a.stdout.log', reviewRounds: 2, finalReviewRounds: 0 })
    expect(r2.wrote).toBe(false)
    expect(getRoundsUnresolvedCountForTest()).toBe(before + 1) // TTL 命中 → 沒有真的再查一次，計數不變
    expect(pool.calls.length).toBe(0) // 沒有打到 pool
  })

  test('missTtlMs=0（停用負向快取，測試專用覆寫）→ 每次都重新查詢，計數持續前進；證明「對不到」不是永久放棄，只是被 TTL 節流', async () => {
    restoreFlag = setMonDbFlag('1')
    const pool = new FakeRoundsFullPool() // resolveRows 空 → 永遠對不到
    const before = getRoundsUnresolvedCountForTest()

    const r1 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-2b.a', ticket: 'FAQ-2b', stdoutPath: '/logs/FAQ-2b.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 }, undefined, 0)
    expect(r1.wrote).toBe(false)
    expect(getRoundsUnresolvedCountForTest()).toBe(before + 1)

    const r2 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-2b.a', ticket: 'FAQ-2b', stdoutPath: '/logs/FAQ-2b.a.stdout.log', reviewRounds: 2, finalReviewRounds: 0 }, undefined, 0)
    expect(r2.wrote).toBe(false)
    expect(getRoundsUnresolvedCountForTest()).toBe(before + 2) // missTtlMs=0 → 每次都真的重查一次
  })

  test('write 失敗（單調守衛擋下）→ cache 不推進，下一輪同值仍會重試', async () => {
    restoreFlag = setMonDbFlag('1')
    const pool = new FakeRoundsFullPool()
    pool.resolveRows.push({ run_id: 'run-3', host: 'head', ticket: 'FAQ-3', legacy_key: null, stdout_path: '/logs/FAQ-3.a.stdout.log' })
    // mon_ui 既有值已經比本次算出的值大（例如另一輪已經寫過更大的值）→ UPDATE 會被 WHERE 擋下。
    pool.writeRows.set('run-3', { run_id: 'run-3', host: 'head', review_rounds: 9, final_review_rounds: 9 })

    const r1 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-3.a', ticket: 'FAQ-3', stdoutPath: '/logs/FAQ-3.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(r1.wrote).toBe(false)

    pool.calls = []
    // cache 沒推進（因為上次沒成功）→ 同樣的值這次還是會再打一次 pool，而不是被「值未變化」短路跳過。
    const r2 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-3.a', ticket: 'FAQ-3', stdoutPath: '/logs/FAQ-3.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(r2.wrote).toBe(false)
    expect(pool.calls.length).toBeGreaterThan(0) // 沒有被「值未變化」短路跳過
  })

  test('budgetMs 逾時分支：注入永不 resolve 的假 pool + budgetMs:0 → 確定性走 budget 分支，零等待（對抗審查 NB-1，之前誤判為不可測）', async () => {
    restoreFlag = setMonDbFlag('1')
    class NeverResolvePool {
      calls = 0
      async execute(): Promise<[unknown, unknown]> {
        this.calls++
        return new Promise(() => {}) // 永不 resolve——budget 分支必勝，與真實時間無關。
      }
    }
    const pool = new NeverResolvePool()
    const r = await persistReviewRoundsToMonDb(
      pool,
      { key: 'FAQ-4.a', ticket: 'FAQ-4', stdoutPath: '/logs/FAQ-4.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 },
      0, // budgetMs=0：budget 這顆 setTimeout(fn,0) 一定比永不 resolve 的 attempt 先觸發
    )
    expect(r.wrote).toBe(false)
    expect(pool.calls).toBe(1) // 有真的發起查詢（不是被別的短路擋掉）

    // cache 未推進：同 key 再打一次仍然會再查一次（不是被「值未變化」短路跳過）。
    const r2 = await persistReviewRoundsToMonDb(
      pool,
      { key: 'FAQ-4.a', ticket: 'FAQ-4', stdoutPath: '/logs/FAQ-4.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 },
      0,
    )
    expect(r2.wrote).toBe(false)
    expect(pool.calls).toBe(2)
  })

  test('有界並發（BLOCKING-1(d)）：ROUNDS_MAX_CONCURRENT_DB_OPS(=2) 個名額用滿後，第三路不打 pool、直接放棄，不排隊', async () => {
    restoreFlag = setMonDbFlag('1')
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve
    })
    // NB-4：這個假 pool **每一路都對得到 run_id、也寫得進去**（不像舊版一律回
    // 空列）。因此第三路的 `wrote===false` 只剩「被名額擋下」這一個成因——如果
    // 名額檢查被拿掉，它就會跟前兩路一樣寫成功，測試立刻紅（D30：一測一故障，
    // 這裡唯一注入的故障是 gate 把前兩路卡在 in-flight 狀態）。
    class GatedPool {
      calls: string[] = []
      async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
        if (sql.includes('legacy_key = ? OR stdout_path = ?')) {
          const ticket = (params as unknown[])[1] as string
          this.calls.push(`resolve:${ticket}`)
          await gate // 卡住直到測試主動釋放——不是靠等待時間，是靠外部控制的 deferred promise。
          return [[{ run_id: `run-${ticket}` }], []] // 對得到 run_id
        }
        if (sql.startsWith('UPDATE runs')) {
          const [, , runId] = params as [number, number, string, string]
          this.calls.push(`write:${runId}`)
          return [{ info: 'Rows matched: 1  Changed: 1  Warnings: 0' }, []] // 寫得進去
        }
        throw new Error(`GatedPool: 未預期的 SQL：${sql}`)
      }
    }
    const pool = new GatedPool()

    // 三路「同時」發起（不 await，讓它們各自跑到自己的第一個真正 await 為止）：
    // JS 對 async function 的呼叫在第一個 await 之前是同步執行的，所以呼叫完
    // 這三行之後，前兩路（名額內）已經同步執行到 `await gate`、pool.execute
    // 的 push 也已經真的發生；第三路的並發檢查同樣是同步判斷，此刻已經決定
    // 放棄——完全不需要任何 `await Promise.resolve()` 之類的額外等待。
    const p1 = persistReviewRoundsToMonDb(pool, { key: 'FAQ-c1', ticket: 'FAQ-c1', stdoutPath: '/logs/c1.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    const p2 = persistReviewRoundsToMonDb(pool, { key: 'FAQ-c2', ticket: 'FAQ-c2', stdoutPath: '/logs/c2.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    const p3 = persistReviewRoundsToMonDb(pool, { key: 'FAQ-c3', ticket: 'FAQ-c3', stdoutPath: '/logs/c3.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })

    expect(pool.calls.length).toBe(2) // 只有名額內的兩路真的打到 pool，第三路被同步擋下
    expect(pool.calls).toEqual(['resolve:FAQ-c1', 'resolve:FAQ-c2'])

    releaseGate()
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.wrote).toBe(true) // 名額內的兩路確實寫成功（證明假 pool 這條路是通的）
    expect(r2.wrote).toBe(true)
    expect(r3.wrote).toBe(false) // 唯一成因：名額被占滿。它從未打到 pool——
    expect(pool.calls).not.toContain('resolve:FAQ-c3')
    // 名額釋放後（roundsInFlightCount 遞減）新的一輪能再搶到名額——用第四路驗證不是永久卡死。
    const p4 = persistReviewRoundsToMonDb(pool, { key: 'FAQ-c4', ticket: 'FAQ-c4', stdoutPath: '/logs/c4.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(pool.calls).toContain('resolve:FAQ-c4')
    expect((await p4).wrote).toBe(true)
  })

  // ---------- BLOCKING-3 迴歸：取名額點必須晚於「不打 DB」的判斷 ----------
  //
  // 對抗審查第三輪抓到的缺陷：舊版把「取名額 + 上限檢查」放在 roundsRunIdCache
  // 與 TTL 負向快取判斷**之前**，釋放又在外層 await 之後的 finally。於是一次
  // ingest tick 裡，排在前面、TTL 命中而完全不打 DB 的 no-op run 會把 2 個名額
  // 佔滿（scanPipelineRuns 的迴圈全同步，微任務要整圈跑完才排空），排在後面
  // 真正可寫的 run 被同步擋掉；readdir 順序穩定 ⇒ 下一輪決定完全相同 ⇒ 確定性
  // 飢餓，受害者恰好是 finishedAt=null 的執行中 run（Phase 8 a4 最需要的資料）。
  test('BLOCKING-3：同一個同步批次裡，兩個 TTL 命中的 no-op 排在前面，也不會擋掉排在後面、真正可寫的 run', async () => {
    restoreFlag = setMonDbFlag('1')
    class Pool {
      resolvable = new Set<string>()
      calls: string[] = []
      async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
        if (sql.includes('legacy_key = ? OR stdout_path = ?')) {
          const ticket = (params as unknown[])[1] as string
          this.calls.push(`resolve:${ticket}`)
          return [this.resolvable.has(ticket) ? [{ run_id: `run-${ticket}` }] : [], []]
        }
        if (sql.startsWith('UPDATE runs')) {
          const [, , runId] = params as [number, number, string, string]
          this.calls.push(`write:${runId}`)
          return [{ info: 'Rows matched: 1  Changed: 1  Warnings: 0' }, []]
        }
        throw new Error(`Pool: 未預期的 SQL：${sql}`)
      }
    }
    const pool = new Pool()
    pool.resolvable.add('LIVE') // 只有 LIVE 這條在 mon_ui 有列（模擬旗標剛啟用的推廣視窗）

    // 先各打一次，讓 A、B 進入 TTL 負向快取（= 6 小時窗內、對不到 run_id 的近期 run）。
    await persistReviewRoundsToMonDb(pool, { key: 'A', ticket: 'A', stdoutPath: '/logs/A.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    await persistReviewRoundsToMonDb(pool, { key: 'B', ticket: 'B', stdoutPath: '/logs/B.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(pool.calls).toEqual(['resolve:A', 'resolve:B'])

    // 模擬下一個 tick 的同步迴圈：A、B（TTL 命中、完全不打 DB）排在 LIVE 前面。
    // 三行呼叫之間沒有任何 await——與 scanPipelineRuns 的全同步迴圈同形。
    pool.calls = []
    const pA = persistReviewRoundsToMonDb(pool, { key: 'A', ticket: 'A', stdoutPath: '/logs/A.stdout.log', reviewRounds: 2, finalReviewRounds: 0 })
    const pB = persistReviewRoundsToMonDb(pool, { key: 'B', ticket: 'B', stdoutPath: '/logs/B.stdout.log', reviewRounds: 2, finalReviewRounds: 0 })
    const pLive = persistReviewRoundsToMonDb(pool, { key: 'LIVE', ticket: 'LIVE', stdoutPath: '/logs/LIVE.stdout.log', reviewRounds: 2, finalReviewRounds: 0 })

    // LIVE 的 SELECT 必須在**同一個同步批次內**就已經發出（不是等到下一輪）。
    expect(pool.calls).toEqual(['resolve:LIVE'])

    const [rA, rB, rLive] = await Promise.all([pA, pB, pLive])
    expect(rA.wrote).toBe(false) // A、B 是 TTL no-op：不打 DB、也沒佔名額
    expect(rB.wrote).toBe(false)
    expect(rLive.wrote).toBe(true) // LIVE 在同一個 tick 內完成寫入
    expect(pool.calls).toEqual(['resolve:LIVE', 'write:run-LIVE'])
  })
})

// ---------- persistReviewRoundsToMonDbGuarded（ingest.ts）：BLOCKING-2 迴歸測試 ----------
//
// getMonitorPool()（mon-db.ts）在 MON_DB_HOST/PORT/SCHEMA/USER/PASSWORD 任一
// 缺漏時是**同步 throw**。對抗審查抓到：舊版呼叫端在 running 分支完全沒有
// try/catch 包住這段，一次「旗標開了、連線參數還沒補齊」的設定錯誤會讓
// scanPipelineRuns 的 for 迴圈當場中斷、reconcileStaleOutcomes 永遠不執行、
// scanAgentTraces 每個 tick 都被跳過——行程不死，但兩個與 rounds 完全無關的
// collector 職責會無聲停擺。這裡直接測最小可重現單元：不依賴真實 transcript
// /DISPATCHER_LOG_DIR（那些依賴會讓端到端測試變成非確定性），只驗證
// persistReviewRoundsToMonDbGuarded 本身「同步 throw 不會逃出函式」這件事。
describe('persistReviewRoundsToMonDbGuarded（ingest.ts）— BLOCKING-2：getMonitorPool() 同步 throw 不炸呼叫端', () => {
  // NB-3：`not.toThrow()` 本身非鑑別性（任何提前 return，甚至函式被改成 no-op
  // 都會通過）。用 console.warn spy 把「catch 分支真的被走到」釘死——訊息內容
  // 同時證明它是 getMonitorPool() 的環境變數同步 throw，不是別的路徑。
  // 附帶前提：getMonitorPool() 有 poolSingleton 快取，若日後有人在本檔加入「會
  // 成功建池」的測試且排在本測試之前，本測試會靜默退化成空測——屆時要改成在
  // 本測試裡先重置 singleton，或把本測試移到獨立檔案。
  test('MON_DB_ENABLED=1 但 MON_DB_HOST 缺漏 → getMonitorPool() 的同步 throw 被吞掉、只留 WARN，函式本身不拋出', () => {
    const restoreFlag = setMonDbFlag('1')
    const savedHost = process.env.MON_DB_HOST
    delete process.env.MON_DB_HOST // 保證 getMonitorPool() 走到 throw 分支（missing.length > 0）
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() =>
        persistReviewRoundsToMonDbGuarded('FAQ-9.a', 'FAQ-9', '/logs/FAQ-9.a.stdout.log', null, { reviewRounds: 1, finalReviewRounds: 0 }),
      ).not.toThrow()
      const messages = warnSpy.mock.calls.map((args: unknown[]) => String(args[0]))
      expect(messages.length).toBe(1)
      expect(messages[0]).toContain('rounds 掛載失敗')
      expect(messages[0]).toContain('MON_DB_HOST') // 確認是 getMonitorPool() 的缺漏環境變數 throw 被接住
    } finally {
      warnSpy.mockRestore()
      if (savedHost === undefined) delete process.env.MON_DB_HOST
      else process.env.MON_DB_HOST = savedHost
      restoreFlag()
    }
  })

  test('MON_DB_ENABLED 未設（關閉）→ 不會走到 getMonitorPool()，同樣不拋出（既有防線，順帶覆蓋）', () => {
    const restoreFlag = setMonDbFlag(undefined)
    try {
      expect(() =>
        persistReviewRoundsToMonDbGuarded('FAQ-10.a', 'FAQ-10', '/logs/FAQ-10.a.stdout.log', null, { reviewRounds: 1, finalReviewRounds: 0 }),
      ).not.toThrow()
    } finally {
      restoreFlag()
    }
  })
})

// ---------- isRoundsMonDbEligible（ingest.ts）：BLOCKING-1(a) 6 小時窗 ----------

describe('isRoundsMonDbEligible', () => {
  test('finishedAt=null（執行中）→ 永遠 true', () => {
    expect(isRoundsMonDbEligible(null)).toBe(true)
  })

  test('finishedAt 是 1 小時前 → true（在 6 小時窗內）', () => {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString()
    expect(isRoundsMonDbEligible(oneHourAgo)).toBe(true)
  })

  test('finishedAt 是 7 小時前 → false（超出 6 小時窗，歷史 run 不再每 tick 重試）', () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString()
    expect(isRoundsMonDbEligible(sevenHoursAgo)).toBe(false)
  })

  // NB-6：貼邊界的兩個案例（1 小時 / 7 小時離邊界太遠，測不到「窗到底切在哪」）。
  // 一分鐘的餘裕遠大於 `Date.now()` 在本測試內的漂移（微秒級），不靠等待成立。
  test('finishedAt 是 5 小時 59 分前 → true（貼著邊界的內側）', () => {
    const justInside = new Date(Date.now() - (6 * 3600 - 60) * 1000).toISOString()
    expect(isRoundsMonDbEligible(justInside)).toBe(true)
  })

  test('finishedAt 是 6 小時 1 分前 → false（貼著邊界的外側）', () => {
    const justOutside = new Date(Date.now() - (6 * 3600 + 60) * 1000).toISOString()
    expect(isRoundsMonDbEligible(justOutside)).toBe(false)
  })
})

// ---------- 6 小時窗的「接線」：不合格的 run 連 getMonitorPool() 都不碰 ----------
//
// NB-6 指出上面三條只驗了純函式本身，沒有任何測試把「不合格 → 不建 pool、不打
// DB」這條接線釘住。這裡用「MON_DB_HOST 缺漏」當探針：合格時會走到
// getMonitorPool() 並印出掛載失敗 WARN（上面的 BLOCKING-2 測試已證明），不合格
// 時必須**連那個 WARN 都沒有**——一次把「順序（窗判定在 getMonitorPool 之前）」
// 與「不合格真的什麼都不做」兩件事驗到。
describe('persistReviewRoundsToMonDbGuarded — 6 小時窗接線（NB-6 / NB-1）', () => {
  test('不合格（7 小時前結束）→ 完全不碰 getMonitorPool()，MON_DB_HOST 缺漏也不會有任何 WARN', () => {
    const restoreFlag = setMonDbFlag('1')
    const savedHost = process.env.MON_DB_HOST
    delete process.env.MON_DB_HOST
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString()
      persistReviewRoundsToMonDbGuarded('FAQ-11.a', 'FAQ-11', '/logs/FAQ-11.a.stdout.log', sevenHoursAgo, { reviewRounds: 1, finalReviewRounds: 0 })
      expect(warnSpy.mock.calls.length).toBe(0)
    } finally {
      warnSpy.mockRestore()
      if (savedHost === undefined) delete process.env.MON_DB_HOST
      else process.env.MON_DB_HOST = savedHost
      restoreFlag()
    }
  })

  test('NB-1：不合格時順手清掉該 key 在四個模組級容器裡的記錄（容器上界與 6 小時窗一致）', async () => {
    const restoreFlag = setMonDbFlag('1')
    try {
      __resetRoundsMonDbStateForTest()
      const pool = new FakeRoundsFullPool() // resolveRows 空 → 對不到 run_id
      const input = { key: 'FAQ-12.a', ticket: 'FAQ-12', stdoutPath: '/logs/FAQ-12.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 }

      // 先讓這個 key 進入 TTL 負向快取（roundsRunIdMissCache 有條目）。
      await persistReviewRoundsToMonDb(pool, input)
      pool.calls = []
      // 沒清掉的話，TTL 內第二次會直接 no-op、不打 pool（上面 TTL 測試已證明）。
      await persistReviewRoundsToMonDb(pool, { ...input, reviewRounds: 2 })
      expect(pool.calls.length).toBe(0)

      // 走一次「出窗」的 guarded 呼叫 → 記錄被清掉。
      const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString()
      persistReviewRoundsToMonDbGuarded(input.key, input.ticket, input.stdoutPath, sevenHoursAgo, { reviewRounds: 3, finalReviewRounds: 0 })

      pool.calls = []
      await persistReviewRoundsToMonDb(pool, { ...input, reviewRounds: 3 })
      expect(pool.calls.map(c => c.kind)).toEqual(['resolve']) // TTL 記錄已被清掉 → 真的重查一次
    } finally {
      __resetRoundsMonDbStateForTest()
      restoreFlag()
    }
  })
})
