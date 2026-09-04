// lib/read/write-side-gaps.test.ts — judgeWriteSideField() 純函式測試。
//
// 背景：2026-09-04 調查發現 D 組的 rounds 兩欄（review_rounds/final_review_rounds）
// 永遠不可能轉綠——demand run 與提早結案的 bug run 混進「最近 N 筆」樣本，稀釋掉
// 唯一合格的樣本（migration/review/rounds-write-side-investigation.md）。修法：加
// `eligible` 過濾（kind='bug' && outcome='success'），列舉法不用排除法（理由見原始
// 碼註解）。每組只注入一個故障（a7-D30）。
import { describe, expect, test } from 'bun:test'
import { judgeWriteSideField, isRoundsEligible } from './write-side-gaps.ts'

const HEAD = 'head'
const ROUNDS_ELIGIBLE = isRoundsEligible

function row(overrides: Record<string, unknown>) {
  return {
    host: HEAD,
    kind: 'bug',
    outcome: 'success',
    finished_at: '2026-09-04T00:00:00.000Z',
    started_at: '2026-09-04T00:00:00.000Z',
    review_rounds: 1,
    ...overrides,
  }
}

describe('judgeWriteSideField — 無 eligible（既有行為，如 stderr_path/triggered_by）', () => {
  test('5 筆全部有值 → OK', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ started_at: `2026-09-04T00:0${i}:00.000Z` }))
    const r = judgeWriteSideField(rows, { field: 'review_rounds', requireFinished: true })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('5/5')
  })

  test('注入：其中一筆缺值 → FAIL', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ started_at: `2026-09-04T00:0${i}:00.000Z`, review_rounds: i === 0 ? null : 1 }),
    )
    const r = judgeWriteSideField(rows, { field: 'review_rounds', requireFinished: true })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('4/5')
  })
})

describe('judgeWriteSideField — eligible 過濾（rounds 的修法本體）', () => {
  test('demand run 與提早結案的 bug run 混在樣本裡，但不合格的不計入取樣 → 用剩下合格的湊滿 5 筆才判定', () => {
    const rows = [
      row({ kind: 'demand', outcome: 'success', review_rounds: null, started_at: '2026-09-04T00:09:00.000Z' }),
      row({ outcome: 'needs_qa_clarification', review_rounds: null, started_at: '2026-09-04T00:08:00.000Z' }),
      ...Array.from({ length: 5 }, (_, i) => row({ started_at: `2026-09-04T00:0${i}:00.000Z` })),
    ]
    const r = judgeWriteSideField(rows, { field: 'review_rounds', requireFinished: true, eligible: ROUNDS_ELIGIBLE })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('5/5')
    expect(r.detail).toContain('不合資格 2 筆')
  })

  test('注入：合格樣本不足 5 筆（即使不合格的一起數會超過）→ 樣本不足判 FAIL，不當作通過', () => {
    const rows = [
      row({ kind: 'demand', outcome: 'success', review_rounds: null, started_at: '2026-09-04T00:05:00.000Z' }),
      row({ kind: 'demand', outcome: 'success', review_rounds: null, started_at: '2026-09-04T00:04:00.000Z' }),
      ...Array.from({ length: 4 }, (_, i) => row({ started_at: `2026-09-04T00:0${i}:00.000Z` })),
    ]
    const r = judgeWriteSideField(rows, { field: 'review_rounds', requireFinished: true, eligible: ROUNDS_ELIGIBLE })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('樣本不足')
  })

  test('對照組：復現調查報告的真實樣本形狀（3 demand + 1 提早結案 + 1 合格且有值）→ 只算合格那 1 筆，樣本不足判 FAIL（不是誤判 1/5 通過）', () => {
    const rows = [
      row({ kind: 'demand', outcome: 'success', review_rounds: null, started_at: '2026-09-04T00:04:00.000Z' }),
      row({ kind: 'demand', outcome: 'insufficient_spec', review_rounds: null, started_at: '2026-09-04T00:03:00.000Z' }),
      row({ kind: 'demand', outcome: 'insufficient_spec', review_rounds: null, started_at: '2026-09-04T00:02:00.000Z' }),
      row({ outcome: 'needs_qa_clarification', review_rounds: null, started_at: '2026-09-04T00:01:00.000Z' }),
      row({ review_rounds: 1, started_at: '2026-09-04T00:00:00.000Z' }),
    ]
    const r = judgeWriteSideField(rows, { field: 'review_rounds', requireFinished: true, eligible: ROUNDS_ELIGIBLE })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('樣本不足：只有 1 筆可用')
  })
})
