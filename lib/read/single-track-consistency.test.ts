// single-track-consistency.test.ts — Phase 9 單軌自洽性判準的單元測試（原型）。
//
// 紀律（沿用本專案既有的兩條）：
//   - a7-D14「沒被觸發過的分支不算綠」：每一條判準都各有**至少一個真的會紅**
//     的負面案例，不是只驗綠燈。
//   - a7-D30「一次只注入一個故障」：每個 test 只注入一種缺陷，不混合，
//     否則無法歸因是哪個偵測器叫的。
// 純函式、不連 DB、不碰檔案系統，因此不需要 `lib/test-tmp-db.ts` 的守衛
// （`phase9-readiness.md` §9.6 的那條坑）。

import { test, expect, describe } from 'bun:test'
import {
  parseRunLogFilename, collectFsRunLogs, judgeRunCoverage,
  isAgentRunSourcePath, judgeAgentRunCoverage,
  judgeLegacyKeyCoherence, KEY_TO_STARTED_AT_TOLERANCE_MS, fileTsToIso,
  judgeRetryLineage,
  type DbRunRow, type AgentRunRow, type AgentRunPathSources,
} from './single-track-consistency.ts'

const LOGS = '/Users/user/aladdin/telegram-dispatcher/logs'
const TRACES = `${LOGS}/agent-traces`
const DIRS: AgentRunPathSources = { dispatcherLogDir: LOGS, agentTraceDir: TRACES }

const T = (iso: string) => Date.parse(iso)

function run(over: Partial<DbRunRow> = {}): DbRunRow {
  return {
    run_id: 'r-1', host: 'head', ticket: 'FAQ-4820', kind: 'bug',
    legacy_key: 'FAQ-4820.2026-09-04T01-31-38-135Z',
    stdout_path: `${LOGS}/FAQ-4820.2026-09-04T01-31-38-135Z.stdout.log`,
    started_at: '2026-09-04T01:31:38.142Z',
    lifecycle_rank: 100,
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────────────────
describe('檔名解析', () => {
  test('bug stdout log 認得出來，且 key 與 legacy_key 的鑄法一致', () => {
    const p = parseRunLogFilename('FAQ-4820.2026-09-04T01-31-38-135Z.stdout.log')
    expect(p).not.toBeNull()
    expect(p!.key).toBe('FAQ-4820.2026-09-04T01-31-38-135Z')
    expect(p!.kind).toBe('bug')
    expect(p!.startedAtIso).toBe('2026-09-04T01:31:38.135Z')
  })

  test('demand stdout log 的 key 保留 .demand-pipeline 後綴（寫入端 base 就是這樣）', () => {
    const p = parseRunLogFilename('ALDREQ-782.2026-09-04T01-06-36-737Z.demand-pipeline.stdout.log')
    expect(p!.key).toBe('ALDREQ-782.2026-09-04T01-06-36-737Z.demand-pipeline')
    expect(p!.kind).toBe('demand')
  })

  test('負面：非 run 的 .stdout.log 不得被當成 run（實測會多撈到這一支）', () => {
    // logs/ 底下真的有這個檔（2026-09-04 實測），只用「結尾是 .stdout.log」
    // 篩會把它算成一次漏收的 run。
    expect(parseRunLogFilename('tg-auto-sync-trigger.stdout.log')).toBeNull()
    expect(parseRunLogFilename('post-run-notify.log')).toBeNull()
    expect(parseRunLogFilename('FAQ-4820.2026-09-04T01-31-38-135Z.stderr.log')).toBeNull()
  })

  test('fileTsToIso 對不合形狀的 token 回 null，不硬湊', () => {
    expect(fileTsToIso('2026-09-04T01:31:38.135Z')).toBeNull()
    expect(fileTsToIso('2026-09-04T01-31-38-135Z')).toBe('2026-09-04T01:31:38.135Z')
  })

  test('collectFsRunLogs 只留 run 檔，且輸出順序與輸入順序無關', () => {
    const a = collectFsRunLogs(['b.log', 'FAQ-1.2026-09-04T00-00-00-001Z.stdout.log', 'FAQ-2.2026-09-04T00-00-00-002Z.stdout.log'])
    const b = collectFsRunLogs(['FAQ-2.2026-09-04T00-00-00-002Z.stdout.log', 'FAQ-1.2026-09-04T00-00-00-001Z.stdout.log', 'b.log'])
    expect(a.map(x => x.key)).toEqual(b.map(x => x.key))
    expect(a).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('S1 runs 覆蓋率（log 檔清單 ⇔ runs.legacy_key）', () => {
  const DB_SNAP = T('2026-09-04T03:00:00.000Z')
  const FS_SNAP = T('2026-09-04T03:00:01.000Z')
  const opts = { dbSnapshotAtMs: DB_SNAP, fsSnapshotAtMs: FS_SNAP }

  test('綠燈：檔案與 DB 一一對應', () => {
    const fs = collectFsRunLogs(['FAQ-4820.2026-09-04T01-31-38-135Z.stdout.log'])
    const r = judgeRunCoverage(fs, [run()], opts)
    expect(r.ok).toBe(true)
    expect(r.missingInDb).toEqual([])
    expect(r.ghostInDb).toEqual([])
  })

  test('負面 1：檔案在、DB 沒有 ⇒ missingInDb 判紅', () => {
    const fs = collectFsRunLogs([
      'FAQ-4820.2026-09-04T01-31-38-135Z.stdout.log',
      'FAQ-9999.2026-09-04T01-00-00-000Z.stdout.log',
    ])
    const r = judgeRunCoverage(fs, [run()], opts)
    expect(r.ok).toBe(false)
    expect(r.missingInDb).toEqual(['FAQ-9999.2026-09-04T01-00-00-000Z'])
    expect(r.ghostInDb).toEqual([])
  })

  test('負面 2：DB 有、檔案不在 ⇒ ghostInDb 判紅（與方向 1 分開歸因，D30）', () => {
    const fs = collectFsRunLogs(['FAQ-4820.2026-09-04T01-31-38-135Z.stdout.log'])
    const ghost = run({ run_id: 'r-2', ticket: 'FAQ-7777', legacy_key: 'FAQ-7777.2026-09-04T02-00-00-000Z', stdout_path: `${LOGS}/FAQ-7777.2026-09-04T02-00-00-000Z.stdout.log`, started_at: '2026-09-04T02:00:00.000Z' })
    const r = judgeRunCoverage(fs, [run(), ghost], opts)
    expect(r.ok).toBe(false)
    expect(r.ghostInDb).toEqual(['FAQ-7777.2026-09-04T02-00-00-000Z'])
    expect(r.missingInDb).toEqual([])
  })

  test('競態：晚於 DB 快照才開始的 run 不判漏收（延後，不是忽略）', () => {
    // 這正是 2026-09-04 實測踩到的形狀：FAQ-4767 於 02:04 開跑，
    // 落在「先拍 FS 清單、後查 DB」之間，舊式集合比對會報一筆假幽靈列。
    const fs = collectFsRunLogs([
      'FAQ-4820.2026-09-04T01-31-38-135Z.stdout.log',
      'FAQ-4767.2026-09-04T03-00-00-500Z.stdout.log', // 晚於 DB 快照
    ])
    const r = judgeRunCoverage(fs, [run()], opts)
    expect(r.ok).toBe(true)
    expect(r.missingInDb).toEqual([])
    expect(r.deferredNewerThanDbSnapshot).toEqual(['FAQ-4767.2026-09-04T03-00-00-500Z'])
  })

  test('競態的另一邊：晚於 FS 快照才開始的 DB 列不判幽靈', () => {
    const fs = collectFsRunLogs(['FAQ-4820.2026-09-04T01-31-38-135Z.stdout.log'])
    const newer = run({ run_id: 'r-3', ticket: 'FAQ-4767', legacy_key: 'FAQ-4767.2026-09-04T03-00-05-000Z', stdout_path: `${LOGS}/FAQ-4767.2026-09-04T03-00-05-000Z.stdout.log`, started_at: '2026-09-04T03:00:05.000Z', lifecycle_rank: 30 })
    const r = judgeRunCoverage(fs, [run(), newer], opts)
    expect(r.ok).toBe(true)
    expect(r.deferredNewerThanFsSnapshot).toEqual(['FAQ-4767.2026-09-04T03-00-05-000Z'])
  })

  test('回填列必須計入 localHosts，否則歷史列全被誤報成漏收', () => {
    const fs = collectFsRunLogs(['FAQ-1391.2026-08-26T03-10-18-375Z.stdout.log'])
    const backfilled = run({ run_id: 'r-b', host: 'unknown_pre_migration', ticket: 'FAQ-1391', legacy_key: 'FAQ-1391.2026-08-26T03-10-18-375Z', stdout_path: `${LOGS}/FAQ-1391.2026-08-26T03-10-18-375Z.stdout.log`, started_at: '2026-08-26T03:10:18.375Z' })
    expect(judgeRunCoverage(fs, [backfilled], opts).ok).toBe(true)
    // 負面對照（D20）：把回填 host 拿掉，同一組資料就會紅——證明這一格真的在看 host。
    const narrowed = judgeRunCoverage(fs, [backfilled], { ...opts, localHosts: ['head'] })
    expect(narrowed.ok).toBe(false)
    expect(narrowed.missingInDb).toEqual(['FAQ-1391.2026-08-26T03-10-18-375Z'])
  })

  test('worker 列預設不計入：它的 stdout_path 是 worker 本機路徑，head 沒有那個檔', () => {
    const fs = collectFsRunLogs([])
    const workerRow = run({ run_id: 'r-w', host: 'landon2', ticket: 'FAQ-4767', legacy_key: 'FAQ-4767.2026-09-03T03-10-24-980Z', started_at: '2026-09-03T03:10:24.982Z' })
    const r = judgeRunCoverage(fs, [workerRow], opts)
    expect(r.ok).toBe(true)
    expect(r.ghostInDb).toEqual([])
    expect(r.counted.db).toBe(0)
  })

  test('負面 3：started_at 為 NULL 的本機列進 undatedRows 並判紅（實測的 4 筆 W4B cancel 列）', () => {
    const orphan = run({ run_id: '40bf03dd-9cb0-494e-b97f-33b30b180b31', ticket: 'FAQ-3098', legacy_key: 'FAQ-3098.2026-09-03T01:34:41.015Z', stdout_path: null, started_at: null })
    const r = judgeRunCoverage(collectFsRunLogs([]), [orphan], opts)
    expect(r.ok).toBe(false)
    expect(r.undatedRows).toHaveLength(1)
    expect(r.undatedRows[0]).toContain('FAQ-3098.2026-09-03T01:34:41.015Z')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('S2 agent_runs 覆蓋率（trace/stdout 檔清單 ⇔ agent_runs.path）', () => {
  const ar = (path: string, over: Partial<AgentRunRow> = {}): AgentRunRow => ({ path, host: 'head', ended_at: '2026-09-04T02:00:00.000Z', is_error: 0, ...over })

  test('合法來源判別子：兩條來源各一，其餘一律排除', () => {
    expect(isAgentRunSourcePath(`${TRACES}/ALDREQ-782/2026-09-04T01-47-18-880Z-classify.json`, DIRS)).toBe(true)
    expect(isAgentRunSourcePath(`${LOGS}/FAQ-4820.2026-09-04T01-31-38-135Z.stdout.log`, DIRS)).toBe(true)
    // demand 的 stdout 不進 agent_runs（scanPipelineRuns 只對 kind==='bug' 呼叫 ingestBugStdout）
    expect(isAgentRunSourcePath(`${LOGS}/ALDREQ-782.2026-09-04T01-06-36-737Z.demand-pipeline.stdout.log`, DIRS)).toBe(false)
    // a7-D38 原文寫的 Debug/ 產物：實測 0/103 筆，不是合法來源
    expect(isAgentRunSourcePath('/Users/user/aladdin/obsidian/Debug/FAQ-4820/FAQ-4820-analysis.md', DIRS)).toBe(false)
    // trace 目錄但少一層 ticket
    expect(isAgentRunSourcePath(`${TRACES}/loose.json`, DIRS)).toBe(false)
    expect(isAgentRunSourcePath(`${LOGS}/post-run-notify.log`, DIRS)).toBe(false)
  })

  test('綠燈：檔案與 DB 對得起來', () => {
    const p = `${TRACES}/ALDREQ-782/2026-09-04T01-47-18-880Z-classify.json`
    expect(judgeAgentRunCoverage([p], [ar(p)], DIRS).ok).toBe(true)
  })

  test('負面 1：檔案在、DB 沒有 ⇒ missingInDb 判紅', () => {
    const p1 = `${TRACES}/ALDREQ-782/a.json`
    const p2 = `${TRACES}/ALDREQ-782/b.json`
    const r = judgeAgentRunCoverage([p1, p2], [ar(p1)], DIRS)
    expect(r.ok).toBe(false)
    expect(r.missingInDb).toEqual([p2])
  })

  test('負面 2：DB 的 path 不在任何合法來源形狀內 ⇒ foreignPaths 判紅', () => {
    const bogus = '/Users/user/aladdin/obsidian/Debug/FAQ-4820/FAQ-4820-analysis.md'
    const r = judgeAgentRunCoverage([], [ar(bogus)], DIRS)
    expect(r.ok).toBe(false)
    expect(r.foreignPaths).toEqual([bogus])
  })

  test('ghostInDb 只列不判紅：trace 被清是這批路徑的正常結局', () => {
    const gone = `${TRACES}/FAQ-1391/2026-08-26T03-10-18-375Z-tracer.json`
    const r = judgeAgentRunCoverage([], [ar(gone)], DIRS)
    expect(r.ok).toBe(true)
    expect(r.ghostInDb).toEqual([gone])
  })

  test('worker 的 agent_runs 列預設不計入（同 S1 的單一機器前提）', () => {
    const p = `${TRACES}/FAQ-4767/x.json`
    const r = judgeAgentRunCoverage([], [ar(p, { host: 'landon2' })], DIRS)
    expect(r.counted.db).toBe(0)
    expect(r.ghostInDb).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('S4 runs 單列欄位自洽（legacy_key ⇔ stdout_path ⇔ started_at）', () => {
  test('綠燈：實測的真實一列（FAQ-4820，Δ=7ms）', () => {
    const r = judgeLegacyKeyCoherence([run()])
    expect(r.ok).toBe(true)
    expect(r.observedMaxDeltaMs).toBe(7)
  })

  test('負面 1：legacy_key 與 stdout_path basename 對不起來', () => {
    const r = judgeLegacyKeyCoherence([run({ legacy_key: 'FAQ-4820.2026-09-04T01:31:38.135Z' })])
    expect(r.ok).toBe(false)
    expect(r.keyPathMismatch).toHaveLength(1)
  })

  test('負面 2：Δ 為負（started_at 早於檔名時間戳）⇒ 判紅、不給容差', () => {
    const r = judgeLegacyKeyCoherence([run({ started_at: '2026-09-04T01:31:38.100Z' })])
    expect(r.ok).toBe(false)
    expect(r.keyStartedAtMismatch).toHaveLength(1)
    expect(r.keyStartedAtMismatch[0]).toContain('Δ=-35ms')
  })

  test('負面 3：Δ 逾上界 ⇒ 判紅；剛好在界上 ⇒ 放行（邊界兩側都驗）', () => {
    const at = new Date(T('2026-09-04T01:31:38.135Z') + KEY_TO_STARTED_AT_TOLERANCE_MS).toISOString()
    expect(judgeLegacyKeyCoherence([run({ started_at: at })]).ok).toBe(true)
    const over = new Date(T('2026-09-04T01:31:38.135Z') + KEY_TO_STARTED_AT_TOLERANCE_MS + 1).toISOString()
    expect(judgeLegacyKeyCoherence([run({ started_at: over })]).ok).toBe(false)
  })

  test('負面 4：同 host 的 legacy_key 重複（idx_legacy_key 不是 UNIQUE，撞得起來）', () => {
    const r = judgeLegacyKeyCoherence([run(), run({ run_id: 'r-dup' })])
    expect(r.ok).toBe(false)
    expect(r.duplicateKeys).toEqual(['head|FAQ-4820.2026-09-04T01-31-38-135Z'])
  })

  test('負面 5：lifecycle_rank>=30 但 stdout_path/started_at 為 NULL 的孤兒列', () => {
    // 實測的 4 筆之一：cancel 五段解析走到 R2（marker），marker 帶的 run_id 在
    // runs 裡不存在 ⇒ W4A UPDATE matched=0 ⇒ W4B INSERT 鑄出這一列。
    // 它被 RUNS_LIST_WHERE 的 `started_at IS NOT NULL` 擋在畫面外，
    // **兩軌對照永遠看不到它**（sqlite 側沒有對應列可配）。
    const r = judgeLegacyKeyCoherence([run({
      run_id: '40bf03dd-9cb0-494e-b97f-33b30b180b31', ticket: 'FAQ-3098',
      legacy_key: 'FAQ-3098.2026-09-03T01:34:41.015Z', stdout_path: null, started_at: null,
    })])
    expect(r.ok).toBe(false)
    expect(r.orphanRows).toHaveLength(1)
  })

  test('demand 列的 .demand-pipeline 後綴要先剝掉才還原得出時間戳', () => {
    const r = judgeLegacyKeyCoherence([run({
      run_id: 'r-d', ticket: 'ALDREQ-782', kind: 'demand',
      legacy_key: 'ALDREQ-782.2026-09-04T01-06-36-737Z.demand-pipeline',
      stdout_path: `${LOGS}/ALDREQ-782.2026-09-04T01-06-36-737Z.demand-pipeline.stdout.log`,
      started_at: '2026-09-04T01:06:36.748Z',
    })])
    expect(r.ok).toBe(true)
    expect(r.observedMaxDeltaMs).toBe(11)
  })

  test('回填列 Δ≡0 by construction（started_at 由 key 原字串直通）', () => {
    const r = judgeLegacyKeyCoherence([run({
      run_id: 'r-b', host: 'unknown_pre_migration', ticket: 'FAQ-1391',
      legacy_key: 'FAQ-1391.2026-08-26T03-10-18-375Z',
      stdout_path: `${LOGS}/FAQ-1391.2026-08-26T03-10-18-375Z.stdout.log`,
      started_at: '2026-08-26T03:10:18.375Z',
    })])
    expect(r.ok).toBe(true)
    expect(r.observedMaxDeltaMs).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('S6 retry/resume 血緣自洽（retry_of_run_id）', () => {
  // 依 post-run-notify.ts 的實際機制造鏈：timeout → resume 重派，
  // 新 run 的 retry_of_run_id ＝ 上一輪的 run_id（繼承 MON_RUN_ID）。
  const chain = (): DbRunRow[] => [
    run({ run_id: 'R1', ticket: 'FAQ-990001', legacy_key: 'FAQ-990001.2026-09-04T10-00-00-000Z', stdout_path: `${LOGS}/FAQ-990001.2026-09-04T10-00-00-000Z.stdout.log`, started_at: '2026-09-04T10:00:00.005Z', outcome: 'timeout', retry_of_run_id: null }),
    run({ run_id: 'R2', ticket: 'FAQ-990001', legacy_key: 'FAQ-990001.2026-09-04T13-00-02-090Z', stdout_path: `${LOGS}/FAQ-990001.2026-09-04T13-00-02-090Z.stdout.log`, started_at: '2026-09-04T13:00:02.100Z', outcome: 'timeout', retry_of_run_id: 'R1' }),
    run({ run_id: 'R3', ticket: 'FAQ-990001', legacy_key: 'FAQ-990001.2026-09-04T16-00-04-180Z', stdout_path: `${LOGS}/FAQ-990001.2026-09-04T16-00-04-180Z.stdout.log`, started_at: '2026-09-04T16:00:04.190Z', outcome: 'success', retry_of_run_id: 'R2' }),
  ]

  test('綠燈：三段 auto-retry 鏈自洽', () => {
    const r = judgeRetryLineage(chain())
    expect(r.ok).toBe(true)
    expect(r.counted.withLineage).toBe(2)
  })

  test('負面 1：父列不存在（退役後清舊列會產生的形狀）', () => {
    const rows = chain().filter(x => x.run_id !== 'R1')
    const r = judgeRetryLineage(rows)
    expect(r.ok).toBe(false)
    expect(r.dangling).toHaveLength(1)
    expect(r.dangling[0]).toContain('R2')
  })

  test('負面 2：血緣接到別張票（注入在鏈尾，一個故障只壞一條邊，D30）', () => {
    const rows = chain()
    rows[2] = { ...rows[2]!, ticket: 'FAQ-990002' }
    const r = judgeRetryLineage(rows)
    expect(r.ok).toBe(false)
    expect(r.ticketMismatch).toEqual(['R3（FAQ-990002）→ R2（FAQ-990001）'])
  })

  test('負面 3：子的 started_at 早於父（順序倒置）', () => {
    const rows = chain()
    rows[1] = { ...rows[1]!, started_at: '2026-09-04T09:00:00.000Z' }
    const r = judgeRetryLineage(rows)
    expect(r.ok).toBe(false)
    expect(r.notLaterThanParent).toHaveLength(1)
  })

  test('負面 4：自我參照與成環都判紅', () => {
    const selfRef = judgeRetryLineage([run({ run_id: 'X', retry_of_run_id: 'X' })])
    expect(selfRef.ok).toBe(false)
    expect(selfRef.cycles).toHaveLength(1)

    const rows = chain()
    rows[0] = { ...rows[0]!, retry_of_run_id: 'R3' } // R1→R3→R2→R1
    const cyc = judgeRetryLineage(rows)
    expect(cyc.ok).toBe(false)
    expect(cyc.cycles.length).toBeGreaterThan(0)
  })

  test('負面 5：同一個父被兩個 run 指為來源（一次失敗重試兩次）', () => {
    const rows = chain()
    rows.push(run({ run_id: 'R2b', ticket: 'FAQ-990001', legacy_key: 'FAQ-990001.2026-09-04T13-00-09-000Z', stdout_path: `${LOGS}/FAQ-990001.2026-09-04T13-00-09-000Z.stdout.log`, started_at: '2026-09-04T13:00:09.010Z', outcome: 'success', retry_of_run_id: 'R1' }))
    const r = judgeRetryLineage(rows)
    expect(r.ok).toBe(false)
    expect(r.forkedParents).toEqual(['R1 被 2 個 run 指為 retry 來源'])
  })

  test('父 outcome 在值域外只列出、不判紅（手動 /api/pipelines/retry 值域不封閉）', () => {
    const rows = chain()
    rows[0] = { ...rows[0]!, outcome: 'success' }
    const r = judgeRetryLineage(rows)
    expect(r.ok).toBe(true)
    expect(r.unexpectedParentOutcome).toHaveLength(1)
  })

  test('跨機重派（head 失敗 → worker 重跑）仍算合法血緣', () => {
    const rows = chain()
    rows[2] = { ...rows[2]!, host: 'landon2' }
    expect(judgeRetryLineage(rows).ok).toBe(true)
  })

  test('同票兩條並行 run（連點兩次形狀）沒有血緣時不誤報', () => {
    const a = run({ run_id: 'A', ticket: 'FAQ-990002', legacy_key: 'FAQ-990002.2026-09-04T10-00-00-000Z', stdout_path: `${LOGS}/FAQ-990002.2026-09-04T10-00-00-000Z.stdout.log`, started_at: '2026-09-04T10:00:00.001Z', lifecycle_rank: 30, retry_of_run_id: null })
    const b = run({ run_id: 'B', ticket: 'FAQ-990002', legacy_key: 'FAQ-990002.2026-09-04T10-02-00-000Z', stdout_path: `${LOGS}/FAQ-990002.2026-09-04T10-02-00-000Z.stdout.log`, started_at: '2026-09-04T10:02:00.001Z', lifecycle_rank: 30, retry_of_run_id: null })
    const r = judgeRetryLineage([a, b])
    expect(r.ok).toBe(true)
    expect(r.counted.withLineage).toBe(0)
    // 但 S4 必須看得到它們是兩把不同的 key（沒有互撞）
    expect(judgeLegacyKeyCoherence([a, b]).duplicateKeys).toEqual([])
  })
})
