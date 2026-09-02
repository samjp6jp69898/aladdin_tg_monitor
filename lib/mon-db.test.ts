// lib/mon-db.test.ts — mon_ui 最小寫入模組（cancel 專用）結構性測試。
//
// 不打真實 mon-mysql（沒有 mysql2 real client），注入假 pool（同 telegram-
// dispatcher/lib/monitor-db/cancel-resolve.test.ts 的手法）。這裡的目的是
// 驗證 tg-monitor 這一份「複製過來的演算法」與 telegram-dispatcher 端的
// lib/monitor-db/cancel-resolve.ts 行為一致（次序、R2 自我驗證、markerMismatch），
// 不是重新驗證 MySQL 語意本身。
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
