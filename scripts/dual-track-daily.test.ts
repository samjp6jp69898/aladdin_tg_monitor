// scripts/dual-track-daily.test.ts — dual-track-daily.ts 的純函式單元測試
// + 端到端負面測試（D14：證明 C 組紅的那天，wrapper 真的會如實記錄紅，不是只在
// 綠燈時才驗證寫入行為）。
//
// 不 import lib/db.ts（本檔測的是子行程 spawn + log 檔 append，不碰監控 DB），
// 所以不需要 lib/test-tmp-db.ts 那一行——但仍全程只寫進 mkdtempSync 的暫存路徑，
// 不動 telegram-dispatcher/logs/monitor-dual-track.log 正式檔。
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendLogEntry, buildLogEntry, parseReadinessOutput, runReadinessCheck,
} from './dual-track-daily.ts'

const tmpDirs: string[] = []
function mkTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dual-track-test-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

const SAMPLE_OUTPUT = `═══ C. 資料面收斂 ═══
[OK]   C5 runs.started_at 在容差內（0 ≤ Δ ≤ 2000ms）  — 實測最大 Δ=14ms｜回填列已排除 47 筆
[OK]   C5 runs.finished_at 在容差內（0 ≤ Δ ≤ 200ms）  — 實測最大 Δ=6ms
[FAIL] C5 runs 其餘每一欄逐字相等  — ALDREQ-818.outcome: sqlite="已通知 x" mysql="success"
[FAIL] C6 sqlite 的每一筆 agent_run 在 mysql 都找得到  — sqlite=74 mysql=81 缺=3
[OK]   C7 status_log 在共同時間窗內的翻轉一致  — sqlite=70 mysql=70
═══ 結論：不可切（2/33 項未過） ═══
`

describe('parseReadinessOutput', () => {
  test('抓到全部 [FAIL] 項目與 Δ', () => {
    const parsed = parseReadinessOutput(SAMPLE_OUTPUT)
    expect(parsed.failedItems).toEqual([
      'C5 runs 其餘每一欄逐字相等',
      'C6 sqlite 的每一筆 agent_run 在 mysql 都找得到',
    ])
    expect(parsed.startedAtMaxDeltaMs).toBe(14)
    expect(parsed.finishedAtMaxDeltaMs).toBe(6)
  })

  test('全綠輸出：failedItems 為空陣列', () => {
    const output = `[OK]   C5 runs.started_at 在容差內  — 實測最大 Δ=1ms\n[OK]   C5 runs.finished_at 在容差內  — 實測最大 Δ=0ms\n結論：可切\n`
    const parsed = parseReadinessOutput(output)
    expect(parsed.failedItems).toEqual([])
    expect(parsed.startedAtMaxDeltaMs).toBe(1)
    expect(parsed.finishedAtMaxDeltaMs).toBe(0)
  })

  test('找不到 Δ 行時回 null，不假造 0', () => {
    const parsed = parseReadinessOutput('[FAIL] 某個完全不相關的檢查\n')
    expect(parsed.startedAtMaxDeltaMs).toBeNull()
    expect(parsed.finishedAtMaxDeltaMs).toBeNull()
    expect(parsed.failedItems).toEqual(['某個完全不相關的檢查'])
  })
})

describe('buildLogEntry', () => {
  test('exit_code=0 時 ok=true', () => {
    const entry = buildLogEntry(
      { exitCode: 0, output: SAMPLE_OUTPUT.replace('[FAIL]', '[OK]  ').replace('[FAIL]', '[OK]  '), durationMs: 1234 },
      new Date('2026-09-03T12:00:00.000Z'),
    )
    expect(entry.date).toBe('2026-09-03')
    expect(entry.exit_code).toBe(0)
    expect(entry.ok).toBe(true)
    expect(entry.duration_ms).toBe(1234)
  })

  test('exit_code!=0 時 ok=false 且帶未過項清單', () => {
    const entry = buildLogEntry({ exitCode: 1, output: SAMPLE_OUTPUT, durationMs: 555 }, new Date('2026-09-03T12:00:00.000Z'))
    expect(entry.ok).toBe(false)
    expect(entry.exit_code).toBe(1)
    expect(entry.failed_items.length).toBe(2)
  })
})

describe('appendLogEntry', () => {
  test('目錄不存在時自動建立，且是 append 不是覆寫', () => {
    const dir = mkTmpDir()
    const logPath = join(dir, 'nested', 'monitor-dual-track.log')
    const e1 = buildLogEntry({ exitCode: 0, output: '', durationMs: 1 }, new Date('2026-09-01T00:00:00Z'))
    const e2 = buildLogEntry({ exitCode: 1, output: SAMPLE_OUTPUT, durationMs: 2 }, new Date('2026-09-02T00:00:00Z'))
    appendLogEntry(logPath, e1)
    appendLogEntry(logPath, e2)
    expect(existsSync(logPath)).toBe(true)
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).date).toBe('2026-09-01')
    expect(JSON.parse(lines[1]).date).toBe('2026-09-02')
    expect(JSON.parse(lines[1]).ok).toBe(false)
  })
})

describe('runReadinessCheck（子行程掛鉤）', () => {
  test('替身指令回傳非 0 時正確回報 exitCode', async () => {
    const dir = mkTmpDir()
    const fake = join(dir, 'fake-fail.ts')
    writeFileSync(fake, `console.log('[FAIL] 假造失敗\\n'); process.exit(1)`)
    const result = await runReadinessCheck(['bun', 'run', fake], dir)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('[FAIL] 假造失敗')
  })

  test('替身指令回傳 0 時正確回報 exitCode', async () => {
    const dir = mkTmpDir()
    const fake = join(dir, 'fake-ok.ts')
    writeFileSync(fake, `console.log('[OK] 一切正常'); process.exit(0)`)
    const result = await runReadinessCheck(['bun', 'run', fake], dir)
    expect(result.exitCode).toBe(0)
  })
})

// ── 端到端負面測試（D14）──────────────────────────────────────────────────
// 不改動 switch-readiness.ts 本身：用 DUAL_TRACK_READINESS_CMD 指向一支構造的
// 假腳本，模擬「C 組紅的那天」，證明 wrapper（跑完整支 main()，包含子行程 spawn
// + log append + 退出碼）確實如實記錄紅，而不是只在綠燈時才驗證過寫入行為。
describe('dual-track-daily.ts 端到端：負面測試（C 組紅的那天）', () => {
  test('假失敗腳本 → log 記紅、wrapper 退出碼非 0', async () => {
    const dir = mkTmpDir()
    const fakeScript = join(dir, 'fake-switch-readiness.ts')
    writeFileSync(
      fakeScript,
      [
        `console.log('[OK]   C5 runs.started_at 在容差內  — 實測最大 Δ=3ms')`,
        `console.log('[OK]   C5 runs.finished_at 在容差內  — 實測最大 Δ=2ms')`,
        `console.log('[FAIL] C6 sqlite 的每一筆 agent_run 在 mysql 都找得到  — sqlite=74 mysql=81 缺=3')`,
        `console.log('結論：不可切（1/33 項未過）')`,
        `process.exit(1)`,
      ].join('\n'),
    )
    const logPath = join(dir, 'monitor-dual-track.log')

    const proc = Bun.spawn(
      ['bun', 'run', join(import.meta.dirname, 'dual-track-daily.ts')],
      {
        cwd: dir,
        env: {
          ...process.env,
          DUAL_TRACK_READINESS_CMD: JSON.stringify(['bun', 'run', fakeScript]),
          DUAL_TRACK_LOG_PATH: logPath,
          DUAL_TRACK_CWD: dir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const wrapperExitCode = await proc.exited

    // wrapper 自身的退出碼延續 switch-readiness.ts 的退出碼——紅的那天 wrapper 也要非 0，
    // 否則 launchd 的失敗偵測（StandardErrorPath / exit status）會漏掉那天。
    expect(wrapperExitCode).toBe(1)

    expect(existsSync(logPath)).toBe(true)
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0])
    expect(entry.exit_code).toBe(1)
    expect(entry.ok).toBe(false)
    expect(entry.failed_items).toEqual(['C6 sqlite 的每一筆 agent_run 在 mysql 都找得到'])
    expect(entry.started_at_max_delta_ms).toBe(3)
    expect(entry.finished_at_max_delta_ms).toBe(2)
  })

  test('對照組：假成功腳本 → log 記綠、wrapper 退出碼 0', async () => {
    const dir = mkTmpDir()
    const fakeScript = join(dir, 'fake-switch-readiness-ok.ts')
    writeFileSync(
      fakeScript,
      [
        `console.log('[OK]   C5 runs.started_at 在容差內  — 實測最大 Δ=1ms')`,
        `console.log('[OK]   C5 runs.finished_at 在容差內  — 實測最大 Δ=0ms')`,
        `console.log('結論：可切（0/33 項未過）')`,
        `process.exit(0)`,
      ].join('\n'),
    )
    const logPath = join(dir, 'monitor-dual-track.log')

    const proc = Bun.spawn(
      ['bun', 'run', join(import.meta.dirname, 'dual-track-daily.ts')],
      {
        cwd: dir,
        env: {
          ...process.env,
          DUAL_TRACK_READINESS_CMD: JSON.stringify(['bun', 'run', fakeScript]),
          DUAL_TRACK_LOG_PATH: logPath,
          DUAL_TRACK_CWD: dir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const wrapperExitCode = await proc.exited
    expect(wrapperExitCode).toBe(0)

    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(entry.exit_code).toBe(0)
    expect(entry.ok).toBe(true)
    expect(entry.failed_items).toEqual([])
  })
})
