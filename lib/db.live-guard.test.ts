// lib/db.live-guard.test.ts — 負面測試（D14）：證明 lib/db.ts 的結構性隔離守衛
// （phase9-readiness.md §9.6）真的會抓到「測試檔忘記先 import test-tmp-db.ts」，
// 不是只在乖乖遵守慣例時才驗證過。
//
// 手法：用 mkdtempSync 造出兩支獨立的 fixture 測試檔，各自用 `file://` 絕對路徑
// import 真正的 lib/db.ts / lib/test-tmp-db.ts（不複製、不 mock，測的是真檔案），
// 各自用 `bun test <fixture>` 起一個全新子行程（NODE_ENV=test 由 bun test 自動
// 設定，這正是守衛依賴的訊號——見 lib/db.ts 的守衛註解）。
//
// 本檔自己也 import lib/db.ts（間接透過其他被測模組不會，這裡直接 import），
// 所以仍需遵守同一條規則：第一行 import test-tmp-db.ts。
import '../lib/test-tmp-db.ts'

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const DB_TS_URL = `file://${REPO}/lib/db.ts`
const TEST_TMP_DB_URL = `file://${REPO}/lib/test-tmp-db.ts`

function runFixtureTest(fixtureSrc: string): { exitCode: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'db-live-guard-fixture-'))
  const file = join(dir, 'fixture.test.ts')
  writeFileSync(file, fixtureSrc)
  try {
    const proc = Bun.spawnSync(['bun', 'test', file], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: proc.exitCode ?? 1, output: proc.stdout.toString() + proc.stderr.toString() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('lib/db.ts 結構性隔離守衛（負面測試）', () => {
  test('違規：測試檔直接 import db.ts、沒先 import test-tmp-db.ts → 守衛觸發、子行程失敗', () => {
    const fixture = `
      import { db } from '${DB_TS_URL}'
      import { test, expect } from 'bun:test'
      test('would touch live db if guard did not fire', () => {
        expect(db).toBeTruthy()
      })
    `
    const result = runFixtureTest(fixture)
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('偵測到在測試環境')
    expect(result.output).toContain('live data/monitor.sqlite')
  })

  test('合規：先 import test-tmp-db.ts 再 import db.ts → 守衛不觸發、子行程通過', () => {
    const fixture = `
      import '${TEST_TMP_DB_URL}'
      import { db } from '${DB_TS_URL}'
      import { test, expect } from 'bun:test'
      test('safe: db points at tmp path', () => {
        expect(db).toBeTruthy()
      })
    `
    const result = runFixtureTest(fixture)
    expect(result.exitCode).toBe(0)
    expect(result.output).not.toContain('偵測到在測試環境')
  })

  test('合規：自行明確設定 TG_MONITOR_DB（非 live 路徑）也不觸發守衛（比照 verify-stream.ts 的用法）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-live-guard-explicit-'))
    const file = join(dir, 'fixture.test.ts')
    const explicitDbPath = join(dir, 'explicit.sqlite')
    writeFileSync(
      file,
      `
        import { db } from '${DB_TS_URL}'
        import { test, expect } from 'bun:test'
        test('safe: explicit TG_MONITOR_DB', () => {
          expect(db).toBeTruthy()
        })
      `,
    )
    try {
      const proc = Bun.spawnSync(['bun', 'test', file], {
        cwd: dir,
        env: { ...process.env, TG_MONITOR_DB: explicitDbPath },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(proc.exitCode).toBe(0)
      expect((proc.stdout.toString() + proc.stderr.toString())).not.toContain('偵測到在測試環境')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
