// lib/mon-db.test.ts — mon_ui 最小寫入模組（cancel 旗標 + rounds 兩欄）結構性測試。
//
// 不打真實 mon-mysql（沒有 mysql2 real client），注入假 pool（同 telegram-
// dispatcher/lib/monitor-db/cancel-resolve.test.ts 的手法）。cancel 相關測試
// 驗證 tg-monitor 這一份「複製過來的演算法」與 telegram-dispatcher 端的
// lib/monitor-db/cancel-resolve.ts 行為一致（次序、R2 自我驗證、markerMismatch），
// 不是重新驗證 MySQL 語意本身；rounds 相關測試（resolveRunIdForRounds /
// writeRunRounds / persistReviewRoundsToMonDb）是 tg-monitor 獨有邏輯，沒有
// telegram-dispatcher 對應實作可比對，直接驗證本檔自己的行為契約。
import { afterEach, describe, expect, test } from 'bun:test'
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

  test('對不到 run_id → skip（wrote=false）、計數 +1、不猜不鑄新列；下一輪重新嘗試解析（不永久放棄）', async () => {
    restoreFlag = setMonDbFlag('1')
    const pool = new FakeRoundsFullPool() // resolveRows 空 → 永遠對不到
    const before = getRoundsUnresolvedCountForTest()

    const r1 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-2.a', ticket: 'FAQ-2', stdoutPath: '/logs/FAQ-2.a.stdout.log', reviewRounds: 1, finalReviewRounds: 0 })
    expect(r1.wrote).toBe(false)
    expect(getRoundsUnresolvedCountForTest()).toBe(before + 1)
    expect(pool.calls.map(c => c.kind)).toEqual(['resolve']) // 對不到就不會有 write

    // 下一輪（值又進展了）再試一次仍然對不到 → 計數再 +1（沒有把「對不到」錯誤 cache 成永久放棄）。
    const r2 = await persistReviewRoundsToMonDb(pool, { key: 'FAQ-2.a', ticket: 'FAQ-2', stdoutPath: '/logs/FAQ-2.a.stdout.log', reviewRounds: 2, finalReviewRounds: 0 })
    expect(r2.wrote).toBe(false)
    expect(getRoundsUnresolvedCountForTest()).toBe(before + 2)
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

  // 註：budgetMs 逾時分支（Promise.race 對 setTimeout）不在此檔用真實延遲測試
  // ——「禁 sleep」硬規則明文「測試碼不得靠等待時間成立」，逾時競態若要確定性
  // 驗證，需要真的讓一條路徑比另一條慢，等同於靠等待時間成立，不划算也不合規。
  // 這裡只驗證邏輯分支本身（成功/失敗兩種 raced.ok 結果都會正確處理 cache），
  // Promise.race + setTimeout 的機制與 cancelPipeline 已驗證過的 writeCancelFlag
  // 完全同構，不重複驗證同一個機制。
})
