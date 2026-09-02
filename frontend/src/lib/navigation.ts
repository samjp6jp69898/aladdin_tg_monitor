/**
 * 跨分頁跳轉（含預填目標分頁的篩選條件）。
 *
 * 對應舊版的 `jumpEvents()` / `jumpEventsQuery()`（index.html:363/366）、
 * `openLog(path)`、overview 卡片上的 `showTab('tg-connected')` 等——
 * 舊版是直接改目標分頁的 DOM 輸入框再 showTab，React 版改成**把條件放進網址 query**，
 * 目標分頁用 `useSearchParams()` 讀出來當初始值。
 *
 * 用法（呼叫端）：
 *     const navigate = useNavigate()
 *     navigate(eventsPath({ service: 'agrabah-admin', identity: 'alice' }))
 *
 * ⚠️ 這些 query 參數名稱是**跨分頁契約**，兩邊都要照這裡的定義，不可各自命名。
 */

import { tabPath, type TabKey } from './routes'

function withQuery(tab: TabKey, params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    sp.set(k, String(v))
  }
  const qs = sp.toString()
  return qs ? `${tabPath(tab)}?${qs}` : tabPath(tab)
}

/* ── events ───────────────────────────────────────────────────────────── */

/** events 分頁認得的 query 參數（EventsPage 要用 useSearchParams 讀這些名字）。 */
export interface EventsJumpFilters {
  service?: string
  identity?: string
  q?: string
  /** 只看錯誤（對應 `#ev-errors` checkbox）。 */
  errors?: boolean
  /** 只看有呼叫 tool（對應 `#ev-tool-only` checkbox）。 */
  toolOnly?: boolean
}

/**
 * 對應舊版 `jumpEvents(svc, who)`（設 service + identity 後切到 events）
 * 與 `jumpEventsQuery(svc, q, errorsOnly)`（設 service + q + errors，並清空 identity/toolOnly）。
 * 兩者都用這一個函式：沒傳的欄位就是「不預填」。
 */
export function eventsPath(f: EventsJumpFilters = {}): string {
  return withQuery('events', {
    service: f.service,
    identity: f.identity,
    q: f.q,
    errors: f.errors ? '1' : undefined,
    toolOnly: f.toolOnly ? '1' : undefined,
  })
}

/* ── logs ─────────────────────────────────────────────────────────────── */

/** 對應舊版 `openLog(path)`：切到 logs 分頁並選中指定檔案。 */
export function logsPath(path?: string): string {
  return withQuery('logs', { path })
}

/* ── pipelines ────────────────────────────────────────────────────────── */

/** pipelines 詳情：`?key=<pipeline_runs.key>`；不帶 key 就是列表頁。 */
export function pipelinesPath(key?: string): string {
  return withQuery('pipelines', { key })
}

/* ── workers ──────────────────────────────────────────────────────────── */

/** workers 詳情：`?name=<worker>`，可再帶 `?ticket=` 直接查票。不帶 name 就是列表頁。 */
export function workersPath(name?: string, ticket?: string): string {
  return withQuery('workers', { name, ticket })
}

/* ── tokens / telegram ────────────────────────────────────────────────── */

/** Token 權限詳情：`?id=<kit id>`；不帶 id 就是列表頁。 */
export function tokensPath(id?: string): string {
  return withQuery('tokens', { id })
}

export function tgConnectedPath(): string {
  return tabPath('tg-connected')
}

export function tgPendingPath(): string {
  return tabPath('tg-pending')
}

/* ── 其餘無參數分頁 ───────────────────────────────────────────────────── */

export function overviewPath(): string {
  return tabPath('overview')
}
export function sessionsPath(): string {
  return tabPath('sessions')
}
export function statsPath(): string {
  return tabPath('stats')
}
export function toolsmithPath(): string {
  return tabPath('toolsmith')
}
