// lib/status-log-spool.test.ts — Phase 4 工作包 B（service/webhook 探測落地 +
// (host,'tg-monitor') 心跳）結構性測試。
//
// 涵蓋範圍：
//   (a) MON_DB_ENABLED 關閉時完全不 append（service probe / webhook / 心跳
//       三條路徑），斷言用 readdirSync(dir).length === 0（不是「讀不到任何
//       行」，是「連檔都沒建」——即使實作意外先建空檔，這條斷言也會抓到）。
//   (b) 開啟時 args 形狀與 telegram-dispatcher 端 apply-entry.ts 的
//       case 'insertStatusLogRow' / 'upsertMonitorHeartbeat' 解析端逐欄相容
//       ——直接在本檔模擬該解析端的取用方式（唯讀查證後對齊，不 import 唯讀
//       檔案，跨 repo 沒有 import 關係）。
//   (c) 時間欄是絕對 ISO 字串（或轉出的 MySQL DATETIME(3)），不是相對時間
//       表達式。
//   (d) 非白名單 table 被拒（appendStatusLogToSpool 本身的守衛）。
//   (e) 降級路徑不吞狀態轉變：append 失敗時「上次成功落地的狀態」不推進，
//       下一輪同狀態的探測仍會重試（service / webhook 兩條路徑都測）。
//   (f) tg-monitor 側 STATUS_LOG_TABLES 白名單 ⊆ telegram-dispatcher 端
//       writes.ts 的白名單（靜態讀取對方原始碼比對，唯讀）。
//
// 另外測 run_id 信封欄位：總指揮裁定（errata）SpoolEntry.run_id 放寬為
// `string | null`，fn ∈ {insertStatusLogRow, upsertMonitorHeartbeat, ...}
// 允許 null——本檔驗證寫出的每一條都恰好是顯式 null（不是省略欄位、不是空
// 字串）。
import './test-tmp-db.ts' // 必須排在 ./ingest.ts 之前：把 sqlite 導向暫存檔（NB-7）
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendStatusLogToSpool, appendHeartbeatToSpool, closeSpoolForTest, STATUS_LOG_TABLES, type StatusLogTable } from './mon-db.ts'
import { appendServiceStatusIfChanged, __resetServiceStatusTrackerForTest } from './ingest.ts'
import { recordWebhookStatusIfChanged, __resetWebhookStatusTrackerForTest, type WebhookStatus } from './webhook-status.ts'

const DISPATCHER_WRITES_TS = '/Users/user/aladdin/telegram-dispatcher/lib/monitor-db/writes.ts'

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

/** 一個「同名檔案擋路」的目錄路徑：`getSpoolFd` 內的 `mkdirSync(dir,
 * {recursive:true})` 對一個祖先路徑是**檔案**（不是目錄）的路徑必炸
 * （ENOTDIR），藉此在不 mock 任何內部實作的情況下確定性地製造一次 append
 * 失敗，驗證「失敗時不推進上次落地狀態」（見 4 號小修：降級路徑吞狀態轉變）。 */
function makeUnwritableSpoolDir(parentDir: string): string {
  const blockingFile = join(parentDir, 'blocking-file')
  writeFileSync(blockingFile, 'x')
  return join(blockingFile, 'spool') // 父路徑本身是檔案，mkdirSync 必定拋出
}

function setFlag(v: string | undefined): () => void {
  const orig = process.env.MON_DB_ENABLED
  if (v === undefined) delete process.env.MON_DB_ENABLED
  else process.env.MON_DB_ENABLED = v
  return () => {
    if (orig === undefined) delete process.env.MON_DB_ENABLED
    else process.env.MON_DB_ENABLED = orig
  }
}

describe('appendStatusLogToSpool（mon-db.ts）', () => {
  let dir: string
  let restoreFlag: () => void
  afterEach(() => {
    closeSpoolForTest()
    if (dir) rmSync(dir, { recursive: true, force: true })
    restoreFlag?.()
  })

  test('(a) MON_DB_ENABLED 關閉（深度防禦：函式自己也擋，不只靠呼叫端）→ 完全不 append，不建檔', () => {
    restoreFlag = setFlag(undefined)
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendStatusLogToSpool({ table: 'service_status_log', columns: ['service', 'host', 'ts', 'status', 'detail_json'], values: ['x', 'head', '2026-09-02 00:00:00.000', 'up', '{}'] }, dir)
    expect(readdirSync(dir).length).toBe(0)
  })

  test('MON_DB_ENABLED=1：白名單內的表 append 成功，run_id 顯式為 null（不是省略欄位），fn=insertStatusLogRow', () => {
    restoreFlag = setFlag('1')
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

  test('(f) tg-monitor 側白名單 ⊆ telegram-dispatcher/lib/monitor-db/writes.ts:652 的 STATUS_LOG_TABLES（靜態讀取，唯讀）', () => {
    const writesSrc = readFileSync(DISPATCHER_WRITES_TS, 'utf8')
    const m = /STATUS_LOG_TABLES\s*=\s*\[([^\]]+)\]/.exec(writesSrc)
    expect(m).not.toBeNull()
    const dispatcherTables = m![1]!
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    // dispatcher 端至少要有這三張（worker_status_log 是它的範圍，tg-monitor
    // 側不寫，但仍應在對方白名單內，否則對方的表清單本身就漏了）。
    expect(dispatcherTables).toEqual(expect.arrayContaining(['worker_status_log', 'service_status_log', 'tg_webhook_status_log']))
    for (const t of STATUS_LOG_TABLES) {
      expect(dispatcherTables).toContain(t)
    }
  })

  test('(d) 非白名單 table 被拒（例如 runs、worker_status_log 或打錯字）', () => {
    restoreFlag = setFlag('1')
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    expect(() => appendStatusLogToSpool({ table: 'runs' as StatusLogTable, columns: [], values: [] }, dir)).toThrow()
    expect(() => appendStatusLogToSpool({ table: 'worker_status_log' as StatusLogTable, columns: [], values: [] }, dir)).toThrow()
    expect(() => appendStatusLogToSpool({ table: 'service_status_log; DROP TABLE runs' as StatusLogTable, columns: [], values: [] }, dir)).toThrow()
    // 被拒時完全不寫檔（跟 cancel 旗標 run_id 為空時的行為一致：拒絕在寫入前就發生）。
    expect(readSpoolLines(dir)).toEqual([])
  })

  test('(b)(c) args 形狀與 dispatcher 端 apply-entry.ts 的 case insertStatusLogRow 解析端逐欄相容；columns/values 一一對應', () => {
    restoreFlag = setFlag('1')
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
    expect(parsed.columns.length).toBe(parsed.values.length)
  })

  test('連續兩次 append 的 seq 遞增（與 appendCancelFlagToSpool 共用同一份 seq/fd）', () => {
    restoreFlag = setFlag('1')
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendStatusLogToSpool({ table: 'service_status_log', columns: ['service', 'host', 'ts', 'status', 'detail_json'], values: ['a', 'head', '2026-09-02 00:00:00.000', 'up', '{}'] }, dir)
    appendStatusLogToSpool({ table: 'service_status_log', columns: ['service', 'host', 'ts', 'status', 'detail_json'], values: ['b', 'head', '2026-09-02 00:01:00.000', 'down', '{}'] }, dir)
    const lines = readSpoolLines(dir)
    expect(lines.map(l => l.seq)).toEqual([1, 2])
  })
})

describe('appendServiceStatusIfChanged（lib/ingest.ts；service probe 落地）', () => {
  let dir: string
  let restoreFlag: () => void
  afterEach(() => {
    closeSpoolForTest()
    __resetServiceStatusTrackerForTest()
    if (dir) rmSync(dir, { recursive: true, force: true })
    restoreFlag?.()
  })

  test('(a) MON_DB_ENABLED 未設（關閉）→ 完全不 append，不建檔', () => {
    restoreFlag = setFlag(undefined)
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged('tg-dispatch-server', 'up', 12345, null, '2026-09-02T00:00:00.000Z', dir)
    expect(readdirSync(dir).length).toBe(0)
  })

  test('(a) MON_DB_ENABLED=0 → 完全不 append，不建檔', () => {
    restoreFlag = setFlag('0')
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged('tg-dispatch-server', 'up', 12345, null, '2026-09-02T00:00:00.000Z', dir)
    expect(readdirSync(dir).length).toBe(0)
  })

  test('MON_DB_ENABLED=1，同狀態第二次呼叫（未翻轉）→ 不重複 append（粒度：只在翻轉時落地，比照 sqlite recordStatusIfChanged）', () => {
    restoreFlag = setFlag('1')
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged('tg-dispatch-server', 'up', 12345, null, '2026-09-02T00:00:00.000Z', dir)
    appendServiceStatusIfChanged('tg-dispatch-server', 'up', 12345, null, '2026-09-02T00:00:05.000Z', dir)
    expect(readSpoolLines(dir).length).toBe(1)
  })

  test('MON_DB_ENABLED=1 且狀態翻轉 → append 一列，欄位與值對齊 service_status_log 的 schema，columns/values 對應', () => {
    restoreFlag = setFlag('1')
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged('tg-dispatch-server', 'down', null, 'connection refused', '2026-09-02T03:04:05.678Z', dir)
    const [entry] = readSpoolLines(dir)
    expect(entry.run_id).toBeNull()
    const parsed = simulateApplyEntryInsertStatusLogRow(entry)
    expect(parsed.table).toBe('service_status_log')
    expect(parsed.columns).toEqual(['service', 'host', 'ts', 'status', 'detail_json'])
    expect(parsed.columns.length).toBe(parsed.values.length)
    const [service, host, ts, status, detailJson] = parsed.values as [string, string, string, string, string]
    expect(service).toBe('tg-dispatch-server')
    expect(host).toBe('head')
    // (c) 時間欄是寫入當下算好的絕對值：ISO → MySQL DATETIME(3)，非相對時間表達式。
    expect(ts).toBe('2026-09-02 03:04:05.678')
    expect(status).toBe('down')
    expect(JSON.parse(detailJson)).toEqual({ pid: null, detail: 'connection refused' })
  })

  test('(e) append 失敗（spool 目錄不可建）→ 狀態不推進，下一輪同狀態的探測仍會重試落地', () => {
    restoreFlag = setFlag('1')
    const parent = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    const badDir = makeUnwritableSpoolDir(parent)

    // 第一次：注定失敗（spool 目錄底下有檔案擋路），錯誤被吞（不拋出到呼叫端）。
    expect(() => appendServiceStatusIfChanged('svc-retry', 'up', 111, null, '2026-09-02T00:00:00.000Z', badDir)).not.toThrow()

    // 第二次：換一個真的能用的目錄，狀態仍是 'up'（跟第一次相同）——如果失敗
    // 時錯誤地推進了狀態，這裡會被誤判成「未翻轉」而不重試，這條斷言就會抓到。
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendServiceStatusIfChanged('svc-retry', 'up', 111, null, '2026-09-02T00:00:05.000Z', dir)
    expect(readSpoolLines(dir).length).toBe(1)

    rmSync(parent, { recursive: true, force: true })
  })
})

describe('recordWebhookStatusIfChanged（lib/webhook-status.ts；webhook 探測落地，新）', () => {
  let dir: string
  let restoreFlag: () => void
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
    restoreFlag?.()
  })

  test('(a) MON_DB_ENABLED 關閉 → 完全不 append，不建檔', () => {
    restoreFlag = setFlag(undefined)
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    recordWebhookStatusIfChanged(baseStatus, dir)
    expect(readdirSync(dir).length).toBe(0)
  })

  test('開啟後第一次觀測算翻轉 → 落一筆；緊接著同狀態的第二次觀測 → 不重複落地', () => {
    restoreFlag = setFlag('1')
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    recordWebhookStatusIfChanged(baseStatus, dir)
    recordWebhookStatusIfChanged({ ...baseStatus, checkedAt: '2026-09-02T00:00:30.000Z' }, dir)
    const lines = readSpoolLines(dir)
    expect(lines.length).toBe(1)
    const parsed = simulateApplyEntryInsertStatusLogRow(lines[0])
    expect(parsed.table).toBe('tg_webhook_status_log')
    expect(parsed.columns).toEqual(['ts', 'status', 'detail_json'])
    expect(parsed.columns.length).toBe(parsed.values.length)
    const [ts, status, detailJson] = parsed.values as [string, string, string]
    expect(ts).toBe('2026-09-02 00:00:00.000')
    expect(status).toBe('up')
    expect(JSON.parse(detailJson)).toMatchObject({ url: 'https://example.com/webhook', ipAddress: '1.2.3.4' })
  })

  test('狀態翻轉（up → down）→ 再落一筆', () => {
    restoreFlag = setFlag('1')
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

  test('(e) append 失敗（spool 目錄不可建）→ 狀態不推進，下一輪同狀態仍會重試落地', () => {
    restoreFlag = setFlag('1')
    const parent = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    const badDir = makeUnwritableSpoolDir(parent)

    expect(() => recordWebhookStatusIfChanged(baseStatus, badDir)).not.toThrow()

    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    recordWebhookStatusIfChanged({ ...baseStatus, checkedAt: '2026-09-02T00:00:05.000Z' }, dir)
    expect(readSpoolLines(dir).length).toBe(1)

    rmSync(parent, { recursive: true, force: true })
  })
})

describe('appendHeartbeatToSpool（mon-db.ts；(host,tg-monitor) 心跳，總指揮追加指示）', () => {
  let dir: string
  let restoreFlag: () => void
  afterEach(() => {
    closeSpoolForTest()
    if (dir) rmSync(dir, { recursive: true, force: true })
    restoreFlag?.()
  })

  test('(a) MON_DB_ENABLED 關閉 → 完全不 append，不建檔', () => {
    restoreFlag = setFlag(undefined)
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendHeartbeatToSpool(dir)
    expect(readdirSync(dir).length).toBe(0)
  })

  test('MON_DB_ENABLED=1：args 形狀與 dispatcher 端 apply-entry.ts 的 case upsertMonitorHeartbeat 解析端相容（args=[input]，非 tuple）', () => {
    restoreFlag = setFlag('1')
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendHeartbeatToSpool(dir)
    const lines = readSpoolLines(dir)
    expect(lines.length).toBe(1)
    const entry = lines[0]
    expect(entry.fn).toBe('upsertMonitorHeartbeat')
    // run_id 信封欄位：與 insertStatusLogRow 同一契約，顯式 null。
    expect('run_id' in entry).toBe(true)
    expect(entry.run_id).toBeNull()
    // apply-entry.ts 的 case 'upsertMonitorHeartbeat' 直接把 entry.args[0] 當
    // UpsertHeartbeatInput 用（單一物件，不是 insertStatusLogRow 那種 tuple）。
    const input = entry.args[0] as { writer: string; ts: string; spoolDepth: number | null; spoolOldestTs: string | null }
    expect(input.writer).toBe('tg-monitor')
    // ts 必須是絕對 ISO 字串（'Z' 結尾），不是 MySQL DATETIME(3) 格式——
    // upsertMonitorHeartbeat 內部才用 dt()（isoToMysqlDatetime3OrNull）在 SQL
    // 邊界轉換，這裡先轉成 MySQL 格式反而會讓對方的 ISO_UTC_RE 比對失敗。
    expect(input.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // tg-monitor 是「寫入者」不是「重放者」，游標檔由重放者獨佔（§6.5(c)），
    // 沒有管道知道自己的 backlog 深度，依指示給 null，不發明假數據。
    expect(input.spoolDepth).toBeNull()
    expect(input.spoolOldestTs).toBeNull()
  })

  test('連續兩次心跳的 seq 遞增（與 cancel / status log 共用同一份 seq/fd）', () => {
    restoreFlag = setFlag('1')
    dir = mkdtempSync(join(tmpdir(), 'status-log-spool-'))
    appendHeartbeatToSpool(dir)
    appendHeartbeatToSpool(dir)
    const lines = readSpoolLines(dir)
    expect(lines.map(l => l.seq)).toEqual([1, 2])
  })
})
