// lib/agent-runs-summary.test.ts — attachAgentRuns() 的 token 彙總契約。
//
// 純函式（無 DB、無檔案 I/O），不需要 test-tmp-db.ts。
import { describe, expect, test } from 'bun:test'
import { attachAgentRuns } from './agent-runs-summary.ts'
import type { AgentRunRow } from './read/types.ts'

function agent(overrides: Partial<AgentRunRow>): AgentRunRow {
  return {
    path: '/tmp/x.json',
    ticket: 'ALDREQ-1',
    kind: 'demand',
    stage: 'draft-A',
    started_at: '2026-09-04T00:00:00.000Z',
    ended_at: '2026-09-04T00:01:00.000Z',
    model: 'claude-x',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    cost_usd: 0,
    num_turns: 1,
    tool_calls: 0,
    is_error: 0,
    result_preview: null,
    file_mtime: null,
    ...overrides,
  } as AgentRunRow
}

describe('attachAgentRuns — 2026-09-04 token 彙總拆分', () => {
  test('total_input 只加總真正的 input_tokens，不再併入 cache_read/cache_create', () => {
    const rows = [{ kind: 'demand', ticket: 'ALDREQ-1', started_at: '2026-09-04T00:00:00.000Z' }]
    const agents: AgentRunRow[] = [
      agent({ input_tokens: 100, cache_read_tokens: 10_000_000, cache_create_tokens: 50_000, output_tokens: 200 }),
      agent({ input_tokens: 396, cache_read_tokens: 152_000_000, cache_create_tokens: 60_000, output_tokens: 300 }),
    ]
    attachAgentRuns(rows, agents)
    const r = rows[0] as any
    // 修正前的舊行為會是 100+396+10_000_000+50_000+152_000_000+60_000 = 162_110_496
    // （即背景描述的 ALDREQ-782「162.63M」現象）；修正後只剩真正的新輸入。
    expect(r.total_input).toBe(496)
    expect(r.total_cache_read).toBe(162_000_000)
    expect(r.total_cache_create).toBe(110_000)
    expect(r.total_output).toBe(500)
    expect(r.agent_count).toBe(2)
  })

  test('cache 欄位缺值（null）時當 0 處理，不污染彙總', () => {
    const rows = [{ kind: 'bug', ticket: 'FAQ-1', started_at: '2026-09-04T00:00:00.000Z' }]
    const agents: AgentRunRow[] = [
      agent({ input_tokens: null, cache_read_tokens: null, cache_create_tokens: null, output_tokens: null }),
    ]
    attachAgentRuns(rows, agents)
    const r = rows[0] as any
    expect(r.total_input).toBe(0)
    expect(r.total_cache_read).toBe(0)
    expect(r.total_cache_create).toBe(0)
    expect(r.total_output).toBe(0)
  })

  test('沒有任何 agent 掛上的 run：四個彙總欄都是 0，不是 undefined（既有行為，未受本次修正影響）', () => {
    const rows = [{ kind: 'demand', ticket: 'ALDREQ-2', started_at: '2026-09-04T00:00:00.000Z' }]
    attachAgentRuns(rows, [])
    const r = rows[0] as any
    expect(r.agent_count).toBe(0)
    expect(r.total_input).toBe(0)
    expect(r.total_cache_read).toBe(0)
    expect(r.total_cache_create).toBe(0)
    expect(r.total_output).toBe(0)
    expect(r.total_cost).toBe(0)
  })

  test('run_id 對位（mysql 模式）：命中就掛，token 彙總照常拆分', () => {
    const rows = [{ kind: 'bug', ticket: 'FAQ-2', started_at: '2026-09-04T00:00:00.000Z', run_id: 'run-abc' }]
    const agents: AgentRunRow[] = [agent({ run_id: 'run-abc', input_tokens: 50, cache_read_tokens: 1000 })]
    attachAgentRuns(rows, agents)
    const r = rows[0] as any
    expect(r.agent_count).toBe(1)
    expect(r.total_input).toBe(50)
    expect(r.total_cache_read).toBe(1000)
  })
})
