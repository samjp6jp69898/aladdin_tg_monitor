// lib/read/remote-dispatches.test.ts — 任務 1：pipelines 列表「worker 執行中
// 出現兩筆」去重規則。純函式，不碰 DB。
import { describe, expect, test } from 'bun:test'
import { dedupRemoteDispatches, type RemoteDispatchCandidate } from './remote-dispatches.ts'

function candidate(overrides: Partial<RemoteDispatchCandidate> = {}): RemoteDispatchCandidate {
  return {
    ticket: 'FAQ-1',
    kind: 'bug',
    status: 'confirmed',
    worker: 'worker-a',
    workerUrl: 'http://192.168.1.50:8801',
    dispatchedAt: '2026-09-04T10:00:00.000Z',
    triggeredBy: { name: '測試人員', email: 'tester@example.com' },
    ...overrides,
  }
}

describe('dedupRemoteDispatches', () => {
  test('票已在 rows 出現（rowKeys 命中）→ 從 remote 抑制，不重複顯示', () => {
    const out = dedupRemoteDispatches([candidate()], new Set(['bug:FAQ-1']))
    expect(out).toHaveLength(0)
  })

  test('票不在 rows、remoteRunId 也是 null → 保留（派工中、還沒有 run_id 的極短暫空窗期）', () => {
    const out = dedupRemoteDispatches([candidate({ remoteRunId: null })], new Set())
    expect(out).toHaveLength(1)
    expect(out[0]!.ticket).toBe('FAQ-1')
  })

  test('票不在 rows，但 remote_run_id 已填上 → 仍抑制（worker 那邊 runs 列已確立的獨立訊號，即使 rows 因 300 筆上限沒抓到這張票）', () => {
    const out = dedupRemoteDispatches([candidate({ remoteRunId: 'a1b2c3d4-0000-4000-8000-000000000000' })], new Set())
    expect(out).toHaveLength(0)
  })

  test('kind 不同、ticket 相同不會誤判成同一張票（key 是 kind:ticket 複合鍵）', () => {
    const out = dedupRemoteDispatches([candidate({ kind: 'demand', ticket: 'FAQ-1' })], new Set(['bug:FAQ-1']))
    expect(out).toHaveLength(1)
  })

  test('多筆候選各自獨立判斷，輸出形狀不含 remoteRunId（前端 DispatchEntry 型別沒有這個欄位）', () => {
    const out = dedupRemoteDispatches(
      [
        candidate({ ticket: 'FAQ-1', remoteRunId: null }),
        candidate({ ticket: 'FAQ-2', remoteRunId: 'a1b2c3d4-0000-4000-8000-000000000000' }),
        candidate({ ticket: 'FAQ-3', remoteRunId: undefined }),
      ],
      new Set(['bug:FAQ-3']), // FAQ-3 已經在 rows 出現
    )
    expect(out.map(e => e.ticket)).toEqual(['FAQ-1'])
    expect(out[0]).not.toHaveProperty('remoteRunId')
  })

  test('sqlite/記憶體登記表來源（沒有 remoteRunId 欄位，undefined）：只靠 rowKeys 去重，行為與遷移前一致', () => {
    const legacyStyle: RemoteDispatchCandidate = {
      ticket: 'FAQ-9',
      kind: 'bug',
      status: 'dispatching',
      worker: '',
      workerUrl: '',
      dispatchedAt: '2026-09-04T10:00:00.000Z',
      triggeredBy: null,
    }
    expect(dedupRemoteDispatches([legacyStyle], new Set())).toHaveLength(1)
    expect(dedupRemoteDispatches([legacyStyle], new Set(['bug:FAQ-9']))).toHaveLength(0)
  })

  test('空候選陣列 → 空輸出', () => {
    expect(dedupRemoteDispatches([], new Set(['bug:FAQ-1']))).toEqual([])
  })
})
