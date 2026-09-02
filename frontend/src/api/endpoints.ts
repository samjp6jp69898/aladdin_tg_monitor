/**
 * server.ts 全部 32 個端點的具名函式。
 *
 * 一個端點一個函式，參數與回傳型別完全對齊 migration/00-api-inventory.md。
 * 分頁元件不要自己 fetch，也不要自己拼 URL，一律透過這裡。
 *
 * 慣例：
 * - 讀取端點用 `fetchXxx`，寫入端點用 `postXxx`。
 * - 每個函式最後一個參數都是選填的 `signal`，供 transport / useResource 在
 *   unmount 或下一次輪詢覆蓋時取消進行中的請求。
 * - 回傳 `OkResult` / `OkReason` 的寫入端點走 `postResult()`：後端用 4xx/409 表達
 *   業務失敗但 body 形狀相同，訊息要顯示給使用者，所以不拋例外（詳見 client.ts）。
 */

import { get, postResult, type QueryParams } from './client'
import type {
  AgentTraceResponse,
  CancelPipelineResponse,
  EventsParams,
  EventsResponse,
  LogSinceResponse,
  LogTailResponse,
  LogsResponse,
  OkReason,
  OkResult,
  OverviewResponse,
  PipelineRunDetailResponse,
  PipelinesResponse,
  RetryPipelineResponse,
  RostersResponse,
  SessionsParams,
  SessionsResponse,
  StatsResponse,
  StatusLogResponse,
  TgUsersResponse,
  TokenGrantsResponse,
  TokenService,
  ToolsmithResponse,
  WorkerDetailResponse,
  WorkersResponse,
} from './types'

/* ────────────────────────────── 靜態首頁 ────────────────────────────── */

/**
 * `GET /` — 舊版單檔 SPA 的 HTML 全文（text/html，非 JSON）。
 *
 * 新前端**不需要**也不應該呼叫它；列在這裡只是為了讓 32 個端點都有對應函式、
 * 契約盤點對得起來。真的要用（例如做新舊版 diff 工具）才呼叫。
 */
export async function fetchLegacyIndexHtml(signal?: AbortSignal): Promise<string> {
  const res = await fetch('/', { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status} /`)
  return res.text()
}

/* ────────────────────────────── overview / services ────────────────────────────── */

/** `GET /api/overview` — 總覽分頁的唯一資料源（服務、webhook、TG 統計、pipeline 併發）。 */
export function fetchOverview(signal?: AbortSignal): Promise<OverviewResponse> {
  return get<OverviewResponse>('/api/overview', undefined, signal)
}

/** `POST /api/services/restart` — 重啟某個 launchd 服務。成功訊息前綴 `RESTART_OK`。 */
export function postServiceRestart(id: string, signal?: AbortSignal): Promise<OkResult> {
  return postResult<OkResult>('/api/services/restart', { id }, signal)
}

/* ────────────────────────────── events ────────────────────────────── */

/** `GET /api/events` — 事件序列，最多 `limit`（預設 200、上限 1000）筆，依 id DESC。 */
export function fetchEvents(params?: EventsParams, signal?: AbortSignal): Promise<EventsResponse> {
  return get<EventsResponse>('/api/events', params as QueryParams | undefined, signal)
}

/* ────────────────────────────── sessions ────────────────────────────── */

/** `GET /api/sessions` — 由事件推導出的使用 session（gap 10 分鐘切段）。 */
export function fetchSessions(params?: SessionsParams, signal?: AbortSignal): Promise<SessionsResponse> {
  return get<SessionsResponse>('/api/sessions', params as QueryParams | undefined, signal)
}

/* ────────────────────────────── stats ────────────────────────────── */

/** `GET /api/stats` — 歷史統計；`days` 預設 7（`perHour` 與 `totalEvents` 不受 days 影響）。 */
export function fetchStats(days?: number, signal?: AbortSignal): Promise<StatsResponse> {
  return get<StatsResponse>('/api/stats', { days }, signal)
}

/* ────────────────────────────── status log ────────────────────────────── */

/** `GET /api/status-log` — 服務 up/down 翻轉紀錄，上限 200 筆；不帶 `service` 則回全部混合。 */
export function fetchStatusLog(service?: string, signal?: AbortSignal): Promise<StatusLogResponse> {
  return get<StatusLogResponse>('/api/status-log', { service }, signal)
}

/* ────────────────────────────── pipelines ────────────────────────────── */

/** `GET /api/pipelines` — pipeline 執行列表（上限 300）＋排隊中＋派送到 worker 的票。 */
export function fetchPipelines(signal?: AbortSignal): Promise<PipelinesResponse> {
  return get<PipelinesResponse>('/api/pipelines', undefined, signal)
}

/** `GET /api/pipelines/run` — 單一 run 詳情。查無 key 時後端回 404（會拋 ApiError）。 */
export function fetchPipelineRun(key: string, signal?: AbortSignal): Promise<PipelineRunDetailResponse> {
  return get<PipelineRunDetailResponse>('/api/pipelines/run', { key }, signal)
}

/**
 * `GET /api/agent-trace` — 單一 agent 對話 trace。
 * `path` 必須通過後端白名單（AGENT_TRACE_DIR/*.json 或 DISPATCHER_LOG_DIR/*.stdout.log），
 * 否則回 **403 純文字** `path not allowed`（ApiError.bodyText 可讀到）。
 */
export function fetchAgentTrace(path: string, signal?: AbortSignal): Promise<AgentTraceResponse> {
  return get<AgentTraceResponse>('/api/agent-trace', { path }, signal)
}

/** `POST /api/pipelines/cancel` — 取消執行中的 pipeline。`ticket` 需符合 /^[A-Z]+-\d+$/。 */
export function postPipelineCancel(
  kind: 'bug' | 'demand',
  ticket: string,
  signal?: AbortSignal,
): Promise<CancelPipelineResponse> {
  return postResult<CancelPipelineResponse>('/api/pipelines/cancel', { kind, ticket }, signal)
}

/** `POST /api/pipelines/retry` — 重試一張票。**只支援 FAQ-數字**，ALDREQ 需求單沒有這個按鈕。 */
export function postPipelineRetry(ticket: string, signal?: AbortSignal): Promise<RetryPipelineResponse> {
  return postResult<RetryPipelineResponse>('/api/pipelines/retry', { ticket }, signal)
}

/* ────────────────────────────── toolsmith ────────────────────────────── */

/** `GET /api/toolsmith` — toolsmith 需求執行紀錄，上限 200，依 updatedAt DESC。 */
export function fetchToolsmith(signal?: AbortSignal): Promise<ToolsmithResponse> {
  return get<ToolsmithResponse>('/api/toolsmith', undefined, signal)
}

/* ────────────────────────────── cluster / workers ────────────────────────────── */

/** `GET /api/cluster/workers` — 全部 worker 清單與線上狀態。 */
export function fetchWorkers(signal?: AbortSignal): Promise<WorkersResponse> {
  return get<WorkersResponse>('/api/cluster/workers', undefined, signal)
}

/**
 * `GET /api/cluster/worker` — 單一 worker 詳情。
 * `ticket` 選填，需符合 /^(FAQ|ALDREQ)-\d+$/ 才會回 `ticketStatus`。
 * worker 名稱對不到時後端回 404 `{ error: ... }`（會拋 ApiError）。
 */
export function fetchWorkerDetail(
  name: string,
  ticket?: string,
  signal?: AbortSignal,
): Promise<WorkerDetailResponse> {
  return get<WorkerDetailResponse>('/api/cluster/worker', { name, ticket }, signal)
}

/** `POST /api/cluster/worker/disable` — 中斷派工給某 worker。 */
export function postWorkerDisable(name: string, signal?: AbortSignal): Promise<OkReason> {
  return postResult<OkReason>('/api/cluster/worker/disable', { name }, signal)
}

/** `POST /api/cluster/worker/enable` — 恢復派工給某 worker。 */
export function postWorkerEnable(name: string, signal?: AbortSignal): Promise<OkReason> {
  return postResult<OkReason>('/api/cluster/worker/enable', { name }, signal)
}

/** `POST /api/cluster/worker/remove` — 從 head 名冊移除某 worker。 */
export function postWorkerRemove(name: string, signal?: AbortSignal): Promise<OkReason> {
  return postResult<OkReason>('/api/cluster/worker/remove', { name }, signal)
}

/* ────────────────────────────── telegram users ────────────────────────────── */

/** `GET /api/tg-users` — 連接／待處理／技術人員名冊三份資料，三個 subtab 共用。 */
export function fetchTgUsers(signal?: AbortSignal): Promise<TgUsersResponse> {
  return get<TgUsersResponse>('/api/tg-users', undefined, signal)
}

/** `POST /api/tg-users/assign` — 把某個 chat_id 指定給某位技術人員。成功前綴 `SET_OK`。 */
export function postTgUserAssign(
  input: { chat_id: string; email: string; force?: boolean },
  signal?: AbortSignal,
): Promise<OkResult> {
  return postResult<OkResult>('/api/tg-users/assign', input, signal)
}

/** `POST /api/tg-users/unset` — 取消某位技術人員的連接。成功前綴 `UNSET_OK` / `UNSET_NOOP`。 */
export function postTgUserUnset(email: string, signal?: AbortSignal): Promise<OkResult> {
  return postResult<OkResult>('/api/tg-users/unset', { email }, signal)
}

/**
 * `POST /api/tg-users/test` — 發測試訊息給某位已連接的技術人員。成功前綴 `TG_SENT`。
 * `text` 省略或空白時後端預設「這是一則來自 tg-monitor 的測試訊息」。
 */
export function postTgUserTest(email: string, text?: string, signal?: AbortSignal): Promise<OkResult> {
  return postResult<OkResult>('/api/tg-users/test', { email, text }, signal)
}

/* ────────────────────────────── rosters / token grants ────────────────────────────── */

/** `GET /api/rosters` — ⚠️ **頂層是陣列**，每個 service 一筆，只列有 tokensPath 的 service。 */
export function fetchRosters(signal?: AbortSignal): Promise<RostersResponse> {
  return get<RostersResponse>('/api/rosters', undefined, signal)
}

/** `GET /api/token-grants` — 每個人在各環境的 token 發放與用量彙總。 */
export function fetchTokenGrants(signal?: AbortSignal): Promise<TokenGrantsResponse> {
  return get<TokenGrantsResponse>('/api/token-grants', undefined, signal)
}

/** `POST /api/token-grants/revoke` — 撤銷某人在指定環境的 token。前綴 `REVOKE_ERR_ARGS` 等。 */
export function postTokenGrantRevoke(
  id: string,
  services: TokenService[],
  signal?: AbortSignal,
): Promise<OkResult> {
  return postResult<OkResult>('/api/token-grants/revoke', { id, services }, signal)
}

/** `POST /api/token-grants/add` — 幫既有的人補簽**單一**環境（不是陣列）。前綴 `ADD_ERR_*`。 */
export function postTokenGrantAdd(
  id: string,
  service: TokenService,
  signal?: AbortSignal,
): Promise<OkResult> {
  return postResult<OkResult>('/api/token-grants/add', { id, service }, signal)
}

/** `POST /api/token-grants/rename` — 改顯示名（上限 64 字）。前綴 `RENAME_ERR_*`。 */
export function postTokenGrantRename(id: string, name: string, signal?: AbortSignal): Promise<OkResult> {
  return postResult<OkResult>('/api/token-grants/rename', { id, name }, signal)
}

/** `POST /api/token-grants/create` — 新增一個人並簽發指定環境的 token。前綴 `CREATE_ERR_*`。 */
export function postTokenGrantCreate(
  id: string,
  name: string,
  services: TokenService[],
  signal?: AbortSignal,
): Promise<OkResult> {
  return postResult<OkResult>('/api/token-grants/create', { id, name, services }, signal)
}

/**
 * `POST /api/token-grants/resend` — 重發 token。
 * `services` 省略時後端 fallback 成「此人名冊裡現有的全部環境」。前綴 `RESEND_ERR_*`。
 */
export function postTokenGrantResend(
  id: string,
  services?: TokenService[],
  signal?: AbortSignal,
): Promise<OkResult> {
  return postResult<OkResult>('/api/token-grants/resend', { id, services }, signal)
}

/* ────────────────────────────── logs ────────────────────────────── */

/** `GET /api/logs` — 可檢視的 log 檔清單（登錄表 + dispatcher 目錄下的票號 log）。 */
export function fetchLogs(signal?: AbortSignal): Promise<LogsResponse> {
  return get<LogsResponse>('/api/logs', undefined, signal)
}

/**
 * `GET /api/log/tail` — 讀檔尾 `kb`KB（預設 64、上限 2048）。
 * 檔案不存在時回 200 `{ text:'', size:0, missing:true }`；
 * path 不在白名單時回 **403 純文字**（拋 ApiError，訊息在 bodyText）。
 */
export function fetchLogTail(path: string, kb?: number, signal?: AbortSignal): Promise<LogTailResponse> {
  return get<LogTailResponse>('/api/log/tail', { path, kb }, signal)
}

/**
 * `GET /api/log/since` — 即時跟隨：帶上次拿到的 `offset`，取回自該位置起的新增內容。
 * 單次最多讀 2MB；檔案被截斷（size < offset）時後端會從頭重讀並把 offset 重設為 0。
 * 這是全站唯一的「tail -f」機制（後端刻意不用 SSE，見 00-api-inventory.md）。
 */
export function fetchLogSince(
  path: string,
  offset?: number,
  signal?: AbortSignal,
): Promise<LogSinceResponse> {
  return get<LogSinceResponse>('/api/log/since', { path, offset }, signal)
}
