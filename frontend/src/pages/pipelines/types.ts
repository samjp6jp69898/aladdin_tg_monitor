/**
 * Pipelines 分頁專屬型別。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/pipelines.md
 */
import type { DispatchEntry, PipelineRun, PipelineRunDetailResponse, QueuedTicket } from '../../api/types'

/**
 * `AgentRunRow` / `PipelineRunDetail`：2026-09-02 起共用層 `src/api/types.ts` 的
 * `PipelineRunDetailResponse['run']` 已補上 `agents[]` / `agent_count` / `total_input` /
 * `total_output` / `total_cost`（server.ts 的 `GET /api/pipelines/run` 實際上一直都有回傳
 * 這些欄位，只是原本的共用型別漏列——見 `PipelineRunDetailResponse` 上的修正註記），
 * 這裡直接 re-export 共用型別，不再維護本地 workaround 型別，讓型別只有單一來源。
 */
export type { AgentRunRow } from '../../api/types'
export type PipelineRunDetail = PipelineRunDetailResponse

/** 列表頁三段拼接（排隊列 + 遠端列 + 本機歷史列）後的統一列型別，見 pipelines.md §3。 */
export type PipelineListRow =
  | { kind: 'queued'; data: QueuedTicket }
  | { kind: 'remote'; data: DispatchEntry }
  | { kind: 'history'; data: PipelineRun }

/** 需求單共用進度 log（舊版 pipelines.md §3 log 欄固定連結，index.html:611）。 */
export const DEMAND_PIPELINE_LOG_PATH = '/Users/user/aladdin/telegram-dispatcher/logs/demand-pipeline.log'
