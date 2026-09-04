// lib/ingest.compute-bug-stages.test.ts — task 1（2026-09-04）：computeBugStages()
// 新增的 remoteFiles 參數。省略時完全比照舊行為（掃 head 本機 Debug/worktrees
// 路徑）；帶值時改用 worker 回報的 mtime 原始資料組裝同一份階段檢核表——見
// lib/ingest.ts computeBugStages 檔頭與 telegram-dispatcher/lib/pipeline-runner/
// local-stage-files.ts 的對應說明。
import './test-tmp-db.ts' // 必須排在 ./ingest.ts 之前（NB-7，見 ingest.cancel.test.ts 同款註解）
import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeBugStages, type RemoteStageFiles } from './ingest.ts'

const DEBUG_DIR = '/Users/user/aladdin/obsidian/Debug'
const RUN_STARTED_AT = '2026-09-04T00:00:00.000Z'

describe('computeBugStages — remoteFiles 省略時（head 本機執行，既有行為）', () => {
  test('本機沒有任何產物：全部階段 pending（claim 例外，finishedAt=runStartedAt）', () => {
    const stages = computeBugStages('FAQ-__compute-bug-stages-empty__', RUN_STARTED_AT, null, false)
    const claim = stages.find(s => s.key === 'claim')!
    expect(claim.status).toBe('done')
    expect(claim.finished_at).toBe(RUN_STARTED_AT)
    const analytics = stages.find(s => s.key === 'analytics')!
    expect(analytics.status).toBe('pending')
    expect(analytics.finished_at).toBeNull()
  })

  test('本機有 analytics.md 產物（本輪之後才更新）：該階段 done', () => {
    const ticket = 'FAQ-__compute-bug-stages-local__'
    const dir = join(DEBUG_DIR, ticket)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ticket}-analytics.md`), '# analytics')
    try {
      const stages = computeBugStages(ticket, RUN_STARTED_AT, null, false)
      const analytics = stages.find(s => s.key === 'analytics')!
      expect(analytics.status).toBe('done')
      expect(typeof analytics.finished_at).toBe('string')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('computeBugStages — 帶 remoteFiles（worker 執行的票，task 1）', () => {
  test('全部檔案都是 null：跟本機沒有任何產物時的結果一致（除了 claim 恆為 done）', () => {
    const remoteFiles: RemoteStageFiles = { debugFiles: {}, worktreeBootstrapLog: null }
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-empty__', RUN_STARTED_AT, null, false, remoteFiles)
    const claim = stages.find(s => s.key === 'claim')!
    expect(claim.status).toBe('done')
    for (const key of ['analytics', 'spec', 'grounding', 'analysis-notes', 'worktree', 'review', 'final-review', 'solution']) {
      const s = stages.find(x => x.key === key)!
      expect(s.status).toBe('pending')
      expect(s.finished_at).toBeNull()
    }
  })

  test('analytics.md 有 mtime（本輪之後）：即使本機完全沒有這個 ticket 的目錄也顯示 done——資料完全來自 remoteFiles，不觸碰本機 Debug 目錄', () => {
    const remoteAt = '2026-09-04T00:05:00.000Z'
    const remoteFiles: RemoteStageFiles = {
      debugFiles: { 'analytics.md': remoteAt, 'spec.md': null, 'grounding.md': null, 'analysis-notes.md': null, 'solution.md': null },
      worktreeBootstrapLog: null,
    }
    const stages = computeBugStages('FAQ-__no-such-local-dir-999999__', RUN_STARTED_AT, null, false, remoteFiles)
    const analytics = stages.find(s => s.key === 'analytics')!
    expect(analytics.status).toBe('done')
    expect(analytics.finished_at).toBe(remoteAt)
  })

  test('review 三檔全到齊（remoteFiles）：review 階段 done，取三者最晚的 mtime', () => {
    const remoteFiles: RemoteStageFiles = {
      debugFiles: {
        'reviewer-report.md': '2026-09-04T00:10:00.000Z',
        'adversarial-review.md': '2026-09-04T00:11:00.000Z',
        'tdd-fidelity-review.md': '2026-09-04T00:09:00.000Z',
      },
      worktreeBootstrapLog: null,
    }
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-review__', RUN_STARTED_AT, null, false, remoteFiles)
    const review = stages.find(s => s.key === 'review')!
    expect(review.status).toBe('done')
    expect(review.finished_at).toBe('2026-09-04T00:11:00.000Z')
  })

  test('review 三檔只到兩個（remoteFiles）：review 階段仍是 pending（未全數到齊不算 done）', () => {
    const remoteFiles: RemoteStageFiles = {
      debugFiles: { 'reviewer-report.md': '2026-09-04T00:10:00.000Z', 'adversarial-review.md': '2026-09-04T00:11:00.000Z' },
      worktreeBootstrapLog: null,
    }
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-review2__', RUN_STARTED_AT, null, false, remoteFiles)
    const review = stages.find(s => s.key === 'review')!
    expect(review.status).toBe('pending')
  })

  test('worktreeBootstrapLog 有值：worktree 階段 done', () => {
    const at = '2026-09-04T00:02:00.000Z'
    const remoteFiles: RemoteStageFiles = { debugFiles: {}, worktreeBootstrapLog: at }
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-worktree__', RUN_STARTED_AT, null, false, remoteFiles)
    const worktree = stages.find(s => s.key === 'worktree')!
    expect(worktree.status).toBe('done')
    expect(worktree.finished_at).toBe(at)
  })

  test('mtime 早於 runStartedAt（沿用上一輪產物）：視為 reused，不是 done', () => {
    const remoteFiles: RemoteStageFiles = {
      debugFiles: { 'analytics.md': '2026-09-01T00:00:00.000Z' }, // 早於 RUN_STARTED_AT
      worktreeBootstrapLog: null,
    }
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-reused__', RUN_STARTED_AT, null, false, remoteFiles)
    const analytics = stages.find(s => s.key === 'analytics')!
    expect(analytics.status).toBe('reused')
    expect(analytics.finished_at).toBeNull()
  })

  test('running=true + remoteFiles，未帶 remoteCurrentStage（呼叫端沒有嘗試探測）：不丟例外，沒有任何階段被標成 running', () => {
    const remoteFiles: RemoteStageFiles = { debugFiles: { 'analytics.md': '2026-09-04T00:05:00.000Z' }, worktreeBootstrapLog: null }
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-running__', RUN_STARTED_AT, null, true, remoteFiles)
    expect(stages.some(s => s.status === 'running')).toBe(false)
    expect(stages.some(s => s.key === 'fixer')).toBe(false)
  })

  test('exit 階段仍由 tracker 參數決定，remoteFiles 不影響這一列', () => {
    const remoteFiles: RemoteStageFiles = { debugFiles: {}, worktreeBootstrapLog: null }
    const tracker = { status: 'done', completedAt: '2026-09-04T01:00:00.000Z' }
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-exit__', RUN_STARTED_AT, tracker, false, remoteFiles)
    const exit = stages.find(s => s.key === 'exit')!
    expect(exit.status).toBe('done')
    expect(exit.finished_at).toBe('2026-09-04T01:00:00.000Z')
  })
})

describe('computeBugStages — remoteCurrentStage（task 2，2026-09-04：worker 執行中的票即時進度）', () => {
  const remoteFiles: RemoteStageFiles = { debugFiles: {}, worktreeBootstrapLog: null }

  test('{ ok: false }（worker 探測逾時/連不上）：fail-closed，不顯示任何 running 列（不是顯示假資料）', () => {
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-cur-unknown__', RUN_STARTED_AT, null, true, remoteFiles, { ok: false })
    expect(stages.some(s => s.status === 'running')).toBe(false)
  })

  test('{ ok: true, stage: null }（探測成功但此刻沒有 agent 在跑）：不顯示 running 列', () => {
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-cur-idle__', RUN_STARTED_AT, null, true, remoteFiles, { ok: true, stage: null })
    expect(stages.some(s => s.status === 'running')).toBe(false)
  })

  test('{ ok: true, stage }（探測成功，bug-tracer 正在跑）：analysis-notes 該列標成 running', () => {
    const since = '2026-09-04T00:20:00.000Z'
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-cur-tracer__', RUN_STARTED_AT, null, true, remoteFiles, {
      ok: true,
      stage: { stageKey: 'analysis-notes', agent: 'bug-tracer', since },
    })
    const s = stages.find(x => x.key === 'analysis-notes')!
    expect(s.status).toBe('running')
    expect(s.started_at).toBe(since)
    expect(s.detail).toBe('bug-tracer')
  })

  test('{ ok: true, stage }（stageKey=fixer）：動態插入一列 fixer，標成 running', () => {
    const since = '2026-09-04T00:30:00.000Z'
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-cur-fixer__', RUN_STARTED_AT, null, true, remoteFiles, {
      ok: true,
      stage: { stageKey: 'fixer', agent: 'bug-fixer-with-tests', since },
    })
    const fixer = stages.find(s => s.key === 'fixer')
    expect(fixer).toBeDefined()
    expect(fixer!.status).toBe('running')
    expect(fixer!.detail).toBe('bug-fixer-with-tests')
  })

  test('{ ok: true, stage }（review + reviewRound）：detail 帶輪數', () => {
    const since = '2026-09-04T00:40:00.000Z'
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-cur-review__', RUN_STARTED_AT, null, true, remoteFiles, {
      ok: true,
      stage: { stageKey: 'review', agent: 'solution-reviewer', since, reviewRound: 2 },
    })
    const review = stages.find(s => s.key === 'review')!
    expect(review.status).toBe('running')
    expect(review.detail).toBe('solution-reviewer・第 2 輪')
  })

  test('running=false：即使帶 remoteCurrentStage 也不套用（跟本機 running=false 行為一致）', () => {
    const stages = computeBugStages('FAQ-__compute-bug-stages-remote-cur-notrunning__', RUN_STARTED_AT, null, false, remoteFiles, {
      ok: true,
      stage: { stageKey: 'analysis-notes', agent: 'bug-tracer', since: '2026-09-04T00:20:00.000Z' },
    })
    expect(stages.some(s => s.status === 'running')).toBe(false)
  })
})
