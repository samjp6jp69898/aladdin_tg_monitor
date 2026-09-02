/**
 * 預先定義好的可訂閱主題，直接餵給 `useResource()`。
 *
 *     const { data, error, loading } = useResource(topics.overview, undefined)
 *     const { data } = useResource(topics.events, { service, limit: 200 })
 *
 * 這些物件定義在**模組層級**（不會每次 render 產生新 identity），符合 useResource 的要求。
 * 需要別的參數組合時直接改 params，不要另外新建 topic。
 *
 * `streamable: true` 的四類主題（overview / pipelines / toolsmith / log）是後端未來
 * `GET /api/stream` 會推的範圍；目前全部仍走輪詢，切換點在 transport.ts。
 */

import { POLL_INTERVAL_MS, LOG_FOLLOW_INTERVAL_MS, defineTopic } from './transport'
import * as api from './endpoints'
import type { EventsParams, SessionsParams } from './types'

export const topics = {
  /** `GET /api/overview` — 5 秒輪詢。 */
  overview: defineTopic({
    key: 'overview',
    streamable: true,
    intervalMs: POLL_INTERVAL_MS,
    fetch: (_: void, signal: AbortSignal) => api.fetchOverview(signal),
  }),

  /** `GET /api/events` */
  events: defineTopic({
    key: 'events',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (p: EventsParams, signal: AbortSignal) => api.fetchEvents(p, signal),
  }),

  /** `GET /api/sessions` */
  sessions: defineTopic({
    key: 'sessions',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (p: SessionsParams, signal: AbortSignal) => api.fetchSessions(p, signal),
  }),

  /** `GET /api/stats` */
  stats: defineTopic({
    key: 'stats',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (p: { days?: number }, signal: AbortSignal) => api.fetchStats(p.days, signal),
  }),

  /** `GET /api/status-log` */
  statusLog: defineTopic({
    key: 'status-log',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (p: { service?: string }, signal: AbortSignal) => api.fetchStatusLog(p.service, signal),
  }),

  /** `GET /api/pipelines` */
  pipelines: defineTopic({
    key: 'pipelines',
    streamable: true,
    intervalMs: POLL_INTERVAL_MS,
    fetch: (_: void, signal: AbortSignal) => api.fetchPipelines(signal),
  }),

  /** `GET /api/pipelines/run` — 單張票詳情。 */
  pipelineRun: defineTopic({
    key: 'pipeline-run',
    streamable: true,
    intervalMs: POLL_INTERVAL_MS,
    fetch: (p: { key: string }, signal: AbortSignal) => api.fetchPipelineRun(p.key, signal),
  }),

  /**
   * `GET /api/agent-trace` — 單一 agent 對話。
   * 舊版**不隨輪詢自動更新**（點才重打），所以用它時請傳 `{ autoRefresh: false }`。
   */
  agentTrace: defineTopic({
    key: 'agent-trace',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (p: { path: string }, signal: AbortSignal) => api.fetchAgentTrace(p.path, signal),
  }),

  /** `GET /api/toolsmith` */
  toolsmith: defineTopic({
    key: 'toolsmith',
    streamable: true,
    intervalMs: POLL_INTERVAL_MS,
    fetch: (_: void, signal: AbortSignal) => api.fetchToolsmith(signal),
  }),

  /** `GET /api/cluster/workers` */
  workers: defineTopic({
    key: 'workers',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (_: void, signal: AbortSignal) => api.fetchWorkers(signal),
  }),

  /** `GET /api/cluster/worker` — 單一 worker 詳情（ticket 選填）。 */
  workerDetail: defineTopic({
    key: 'worker-detail',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (p: { name: string; ticket?: string }, signal: AbortSignal) =>
      api.fetchWorkerDetail(p.name, p.ticket, signal),
  }),

  /** `GET /api/tg-users` — tokens / tg-connected / tg-pending 共用資料源。 */
  tgUsers: defineTopic({
    key: 'tg-users',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (_: void, signal: AbortSignal) => api.fetchTgUsers(signal),
  }),

  /** `GET /api/rosters` — ⚠️ 回傳頂層是陣列。 */
  rosters: defineTopic({
    key: 'rosters',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (_: void, signal: AbortSignal) => api.fetchRosters(signal),
  }),

  /** `GET /api/token-grants` */
  tokenGrants: defineTopic({
    key: 'token-grants',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (_: void, signal: AbortSignal) => api.fetchTokenGrants(signal),
  }),

  /** `GET /api/logs` — log 檔清單。 */
  logs: defineTopic({
    key: 'logs',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (_: void, signal: AbortSignal) => api.fetchLogs(signal),
  }),

  /** `GET /api/log/tail` — 一次性讀檔尾；即時跟隨請用 `useLogFollow()`。 */
  logTail: defineTopic({
    key: 'log-tail',
    intervalMs: POLL_INTERVAL_MS,
    fetch: (p: { path: string; kb?: number }, signal: AbortSignal) =>
      api.fetchLogTail(p.path, p.kb, signal),
  }),

  /**
   * `GET /api/log/since` — 即時跟隨的增量讀取，間隔 1500ms（舊版 index.html:748）。
   * 一般不要直接用，改用 `useLogFollow()`，它會幫你維護 offset 與文字累加。
   */
  logSince: defineTopic({
    key: 'log',
    streamable: true,
    intervalMs: LOG_FOLLOW_INTERVAL_MS,
    fetch: (p: { path: string; offset?: number }, signal: AbortSignal) =>
      api.fetchLogSince(p.path, p.offset, signal),
  }),
}
