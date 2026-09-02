// lib/status-log-spool.test.ts — Phase 4 工作包 B（service/webhook 探測落地）
// 結構性測試。
//
// 涵蓋範圍（依派工回報格式的四項）：
//   (a) MON_DB_ENABLED 關閉時完全不 append（service probe / webhook 兩條路徑）
//   (b) 開啟時 args 形狀與 telegram-dispatcher 端 apply-entry.ts 的
//       case 'insertStatusLogRow' 解析端逐欄相容——直接在本檔模擬該解析端的
//       取用方式（見 dispatcher 端 apply-entry.ts:101-109 的
//       `const [table, columns, values] = input as [...]`），不 import 該檔
//       （跨 repo 沒有 import 關係，唯讀檔案本來就不能改）。
//   (c) 時間欄是絕對 ISO 字串轉出的 MySQL DATETIME(3)，不是相對時間表達式。
//   (d) 非白名單 table 被拒（appendStatusLogToSpool 本身的守衛）。
//
// 另外測 run_id 信封欄位：總指揮裁定（errata）SpoolEntry.run_id 放寬為
// `string | null`，fn='insertStatusLogRow' 允許 null——本檔驗證寫出的每一條
// 都恰好是顯式 null（不是省略欄位、不是空字串）。
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendStatusLogToSpool, closeSpoolForTest, STATUS_LOG_TABLES, type StatusLogTable } from './mon-db.ts'
import { appendServiceStatusIfChanged } from './ingest.ts'
import { recordWebhookStatusIfChanged, __resetWebhookStatusTrackerForTest, type WebhookStatus } from './webhook-status.ts'

function readSpoolLines(dir: string): any[] {
  const files = readdirSync(dir)
  const dataFile = files.find(f => f.endsWith('.jsonl') && !f.endsWith('.dead.jsonl'))
  if (!dataFile) return []
  return readFileSync(join(dir, dataFile), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
}

/** 模擬 telegram-dispatcher/lib/monitor-db/apply-entry.ts 的
 * case 'insertStatusLogRow' 解析端（唯讀檔案，不 import，逐字對齊該邏輯）。 */
function simulateApplyEntryInsertStatusLogRow(entry: { fn: string; args: unknown[] }): { table: StatusLogTable; columns: string[]; values: unknown[] } {
  expect(entry.fn).toBe('insertStatusLogRow')
  const [table, columns, values] = entry.args[0] as [StatusLogTable, string[], unknown[]]
  return { table, columns, values }
}

describe('appendStatusLogToSpool（mon-db.ts）', () => {
  let dir: string
  afterEach(() => {
    closeSpoolForTest()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('白名單內的表：run_id 顯式為 null（不是省略欄位），fn=insertStatusLogRow', () => {
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendStatusLogToSpool({ table: 'service_status_log', columns: ['service', 'host', 'ts', 'status', 'detail_json'], values: ['tg-dispatch-server', 'head', '2026-09-02 00:00:00.000', 'up', '{}'] }, dir)
    const lines = readSpoolLines(dir)
    expect(lines.length).toBe(1)
    const entry = lines[0]
    expect(entry.fn).toBe('insertStatusLogRow')
    expect('run_id' in entry).toBe(true)
    expect(entry.run_id).toBeNull()
    expect(entry.seq).toBe(1)
  })

  test('STATUS_LOG_TABLES 白名單恰好是這兩張表（tg-monitor 這一側的範圍）', () => {
    expect(STATUS_LOG_TABLES).toEqual(['service_status_log', 'tg_webhook_status_log'])
  })

  test('非白名單 table 被拒（例如 runs、worker_status_log 或打錯字）', () => {
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    expect(() => appendStatusLogToSpool({ table: 'runs' as StatusLogTable, columns: [], values: [] }, dir)).toThrow()
    expect(() => appendStatusLogToSpool({ table: 'worker_status_log' as StatusLogTable, columns: [], values: [] }, dir)).toThrow()
    expect(() => appendStatusLogToSpool({ table: 'service_status_log; DROP TABLE runs' as StatusLogTable, columns: [], values: [] }, dir)).toThrow()
    // 被拒時完全不寫檔（跟 cancel 旗標 run_id 為空時的行為一致：拒絕在寫入前就發生）。
    expect(readSpoolLines(dir)).toEqual([])
  })

  test('args 形狀與 dispatcher 端 apply-entry.ts 的 case insertStatusLogRow 解析端逐欄相容', () => {
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendStatusLogToSpool(
      {
        table: 'tg_webhook_status_log',
        columns: ['ts', 'status', 'detail_json'],
        values: ['2026-09-02 00:00:00.000', 'down', JSON.stringify({ error: 'timeout' })],
      },
      dir,
    )
    const [entry] = readSpoolLines(dir)
    const parsed = simulateApplyEntryInsertStatusLogRow(entry)
    expect(parsed.table).toBe('tg_webhook_status_log')
    expect(parsed.columns).toEqual(['ts', 'status', 'detail_json'])
    expect(parsed.values).toEqual(['2026-09-02 00:00:00.000', 'down', JSON.stringify({ error: 'timeout' })])
  })

  test('連續兩次 append 的 seq 遞增（與 appendCancelFlagToSpool 共用同一份 seq/fd）', () => {
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendStatusLogToSpool({ table: 'service_status_log', columns: ['service', 'host', 'ts', 'status', 'detail_json'], values: ['a', 'head', '2026-09-02 00:00:00.000', 'up', '{}'] }, dir)
    appendStatusLogToSpool({ table: 'service_status_log', columns: ['service', 'host', 'ts', 'status', 'detail_json'], values: ['b', 'head', '2026-09-02 00:01:00.000', 'down', '{}'] }, dir)
    const lines = readSpoolLines(dir)
    expect(lines.map(l => l.seq)).toEqual([1, 2])
  })
})

describe('appendServiceStatusIfChanged（lib/ingest.ts；service probe 落地）', () => {
  let dir: string
  const origFlag = process.env.MON_DB_ENABLED
  afterEach(() => {
    closeSpoolForTest()
    if (dir) rmSync(dir, { recursive: true, force: true })
    if (origFlag === undefined) delete process.env.MON_DB_ENABLED
    else process.env.MON_DB_ENABLED = origFlag
  })

  test('(a) MON_DB_ENABLED 未設（關閉）→ 完全不 append，即使 changed=true', () => {
    delete process.env.MON_DB_ENABLED
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged(true, 'tg-dispatch-server', 'up', 12345, null, '2026-09-02T00:00:00.000Z', dir)
    expect(readSpoolLines(dir)).toEqual([])
  })

  test('(a) MON_DB_ENABLED=0 → 完全不 append', () => {
    process.env.MON_DB_ENABLED = '0'
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged(true, 'tg-dispatch-server', 'up', 12345, null, '2026-09-02T00:00:00.000Z', dir)
    expect(readSpoolLines(dir)).toEqual([])
  })

  test('MON_DB_ENABLED=1 但 changed=false（狀態未翻轉）→ 不 append（粒度：只在翻轉時落地，比照 sqlite recordStatusIfChanged）', () => {
    process.env.MON_DB_ENABLED = '1'
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged(false, 'tg-dispatch-server', 'up', 12345, null, '2026-09-02T00:00:00.000Z', dir)
    expect(readSpoolLines(dir)).toEqual([])
  })

  test('MON_DB_ENABLED=1 且 changed=true → append 一列，欄位與值對齊 service_status_log 的 schema', () => {
    process.env.MON_DB_ENABLED = '1'
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged(true, 'tg-dispatch-server', 'down', null, 'connection refused', '2026-09-02T03:04:05.678Z', dir)
    const [entry] = readSpoolLines(dir)
    expect(entry.run_id).toBeNull()
    const parsed = simulateApplyEntryInsertStatusLogRow(entry)
    expect(parsed.table).toBe('service_status_log')
    expect(parsed.columns).toEqual(['service', 'host', 'ts', 'status', 'detail_json'])
    const [service, host, ts, status, detailJson] = parsed.values as [string, string, string, string, string]
    expect(service).toBe('tg-dispatch-server')
    expect(host).toBe('head')
    // (c) 時間欄是寫入當下算好的絕對值：ISO → MySQL DATETIME(3)，非相對時間表達式。
    expect(ts).toBe('2026-09-02 03:04:05.678')
    expect(status).toBe('down')
    expect(JSON.parse(detailJson)).toEqual({ pid: null, detail: 'connection refused' })
  })
})

describe('recordWebhookStatusIfChanged（lib/webhook-status.ts；webhook 探測落地，新）', () => {
  let dir: string
  const origFlag = process.env.MON_DB_ENABLED
  const baseStatus: WebhookStatus = {
    ok: true,
    url: 'https://example.com/webhook',
    pendingUpdateCount: 0,
    lastErrorDate: null,
    lastErrorMessage: null,
    ipAddress: '1.2.3.4',
    maxConnections: 40,
    error: null,
    checkedAt: '2026-09-02T00:00:00.000Z',
  }
  afterEach(() => {
    closeSpoolForTest()
    __resetWebhookStatusTrackerForTest()
    if (dir) rmSync(dir, { recursive: true, force: true })
    if (origFlag === undefined) delete process.env.MON_DB_ENABLED
    else process.env.MON_DB_ENABLED = origFlag
  })

  test('(a) MON_DB_ENABLED 關閉 → 完全不 append', () => {
    delete process.env.MON_DB_ENABLED
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    recordWebhookStatusIfChanged(baseStatus, dir)
    expect(readSpoolLines(dir)).toEqual([])
  })

  test('開啟後第一次觀測算翻轉 → 落一筆；緊接著同狀態的第二次觀測 → 不重複落地', () => {
    process.env.MON_DB_ENABLED = '1'
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    recordWebhookStatusIfChanged(baseStatus, dir)
    recordWebhookStatusIfChanged({ ...baseStatus, checkedAt: '2026-09-02T00:00:30.000Z' }, dir)
    const lines = readSpoolLines(dir)
    expect(lines.length).toBe(1)
    const parsed = simulateApplyEntryInsertStatusLogRow(lines[0])
    expect(parsed.table).toBe('tg_webhook_status_log')
    expect(parsed.columns).toEqual(['ts', 'status', 'detail_json'])
    const [ts, status, detailJson] = parsed.values as [string, string, string]
    expect(ts).toBe('2026-09-02 00:00:00.000')
    expect(status).toBe('up')
    expect(JSON.parse(detailJson)).toMatchObject({ url: 'https://example.com/webhook', ipAddress: '1.2.3.4' })
  })

  test('狀態翻轉（up → down）→ 再落一筆', () => {
    process.env.MON_DB_ENABLED = '1'
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    recordWebhookStatusIfChanged(baseStatus, dir)
    recordWebhookStatusIfChanged({ ...baseStatus, ok: false, error: 'timeout', checkedAt: '2026-09-02T00:01:00.000Z' }, dir)
    const lines = readSpoolLines(dir)
    expect(lines.length).toBe(2)
    const second = simulateApplyEntryInsertStatusLogRow(lines[1])
    const [, status, detailJson] = second.values as [string, string, string]
    expect(status).toBe('down')
    expect(JSON.parse(detailJson)).toMatchObject({ error: 'timeout' })
  })
})
