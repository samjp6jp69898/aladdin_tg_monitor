// 把 agent_runs 依 (kind, ticket, 時間區間) 掛到對應的 pipeline run，並彙總 token 用量。
// 從 server.ts 抽出（2026-09-04）：純函式、無外部狀態，抽成獨立檔案才能在不啟動
// 整個 server（initReader/startCollectors 等 top-level await）的情況下單元測試。
// 行為與抽出前逐字相同，只有 token 彙總這段依本次任務修正（見下方 total_input 註解）。
import type { AgentRunRow } from './read/types.ts'

/**
 * 把 agent_runs 依 (kind, ticket, 時間區間) 掛到對應的 pipeline run：
 * trace 的 started_at 落在 [run.started_at, 同票下一次 run.started_at) 即屬於該 run。
 */
export function attachAgentRuns(rows: any[], agents: AgentRunRow[]) {
  const byKey = new Map<string, any[]>()
  for (const r of rows) byKey.set(`${r.kind}:${r.ticket}`, [...(byKey.get(`${r.kind}:${r.ticket}`) ?? []), r])
  // MON_READ_SOURCE=mysql 時兩邊都帶 run_id（agent_runs 的 PK 一半就是它），
  // 歸戶不必再靠時間視窗猜——直接對位。sqlite 模式兩邊都沒有 run_id，
  // 這個 Map 是空的，一律落到下面既有的時間視窗邏輯，行為完全不變。
  const byRunId = new Map<string, any>()
  for (const r of rows) if (typeof r.run_id === 'string' && r.run_id) byRunId.set(r.run_id, r)
  for (const r of rows) { r.agents = []; }
  for (const a of agents as any[]) {
    // 有 run_id 就**只信 run_id**：命中就掛上，沒命中代表那個 run 不在本次視野內
    // （例如 /api/pipelines 只取最新 300 筆，或該 run 被 lifecycle 過濾掉），
    // 這時要直接略過。掉回下面的時間視窗分支會把它掛到「同票、開始時間在它之前
    // 的最後一個 run」上，把別人的 agent_count / total_* 灌大——那是猜的，而
    // run_id 明明是確定的答案。sqlite 模式兩邊都沒有 run_id，這一段完全不會進來。
    if (typeof a.run_id === 'string' && a.run_id) {
      byRunId.get(a.run_id)?.agents.push(a)
      continue
    }
    const runs = (byKey.get(`${a.kind}:${a.ticket}`) ?? []).slice().sort((x, y) => (x.started_at < y.started_at ? -1 : 1))
    let owner: any = null
    for (const r of runs) if (r.started_at <= a.started_at) owner = r
    // trace 可能比 run 的檔名時間早幾百毫秒（wrapper 先開檔），容忍 5 秒
    if (!owner && runs.length && Date.parse(runs[0].started_at) - Date.parse(a.started_at) < 5000) owner = runs[0]
    if (owner) owner.agents.push(a)
  }
  for (const r of rows) {
    r.agent_count = r.agents.length
    // 2026-09-04 修正：total_input 曾把 cache_read_tokens／cache_create_tokens
    // 無差別併入，跨多 stage 相加後對使用者顯示成一個嚇人的大數字（實測
    // ALDREQ-782 顯示 162.63M，99%+ 是 cache_read，並非新產生的輸入資料）。
    // 現在拆開：total_input 只加總真正的「新輸入」（input_tokens），
    // cache_read/cache_create 各自獨立彙總，不再混進 total_input。
    r.total_input = r.agents.reduce((n: number, a: any) => n + (a.input_tokens ?? 0), 0)
    r.total_cache_read = r.agents.reduce((n: number, a: any) => n + (a.cache_read_tokens ?? 0), 0)
    r.total_cache_create = r.agents.reduce((n: number, a: any) => n + (a.cache_create_tokens ?? 0), 0)
    r.total_output = r.agents.reduce((n: number, a: any) => n + (a.output_tokens ?? 0), 0)
    r.total_cost = r.agents.reduce((n: number, a: any) => n + (a.cost_usd ?? 0), 0)
  }
}
