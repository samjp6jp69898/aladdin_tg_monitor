/**
 * 底層 fetch 包裝。
 *
 * 取代舊版 index.html:278 的 `const api = p => fetch(p).then(r => r.json())`——
 * 舊版**完全沒有檢查 HTTP status**，非 2xx 只要 body 是合法 JSON 就被當成正常資料。
 * 這裡補上狀態檢查與明確的錯誤型別，這是刻意的行為升級（不是 parity 破壞）。
 *
 * server.ts 沒有任何 middleware / CORS / 認證（只綁 127.0.0.1），
 * 所以這裡不需要帶任何 header 或 credentials。
 */

/** query string 允許的值型別；`undefined` / `null` 會被略過不送。 */
export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue>

/**
 * 所有非 2xx 回應與 JSON 解析失敗都用這個錯誤型別拋出。
 *
 * - `status`：HTTP 狀態碼；network 層失敗或 JSON 解析失敗時為 0。
 * - `bodyText`：原始回應內文（未解析）。三個端點（/api/log/tail、/api/log/since、
 *   /api/agent-trace）的路徑白名單失敗會回 **純文字** `path not allowed`，
 *   要判斷這種情況請讀 `bodyText`，不要假設 body 一定是 JSON。
 * - `body`：若 `bodyText` 能解析成 JSON 則為解析結果，否則 `undefined`。
 *   多數 POST 端點的錯誤 body 形狀是 `{ ok: false, result | reason }`。
 */
export class ApiError extends Error {
  readonly status: number
  readonly bodyText: string
  readonly body?: unknown
  readonly path: string

  constructor(message: string, opts: { status: number; bodyText: string; body?: unknown; path: string }) {
    super(message)
    this.name = 'ApiError'
    this.status = opts.status
    this.bodyText = opts.bodyText
    this.body = opts.body
    this.path = opts.path
  }
}

/** 把 params 串成 query string；undefined / null 直接略過（不會送出 `key=undefined`）。 */
export function buildQuery(params?: QueryParams): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { ...init, signal })
  } catch (err) {
    // AbortError 原樣往上拋，讓呼叫端（transport / useResource）能區分「被取消」與「真的失敗」。
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(`連線失敗：${path}（${String(err)}）`, { status: 0, bodyText: '', path })
  }

  const bodyText = await res.text()

  if (!res.ok) {
    const parsed = tryParseJson(bodyText)
    throw new ApiError(
      `HTTP ${res.status} ${path}：${bodyText.slice(0, 500) || '(空回應)'}`,
      { status: res.status, bodyText, body: parsed.ok ? parsed.value : undefined, path },
    )
  }

  const parsed = tryParseJson(bodyText)
  if (!parsed.ok) {
    throw new ApiError(
      `回應不是合法 JSON：${path}（前 200 字：${bodyText.slice(0, 200)}）`,
      { status: res.status, bodyText, path },
    )
  }
  return parsed.value as T
}

/** GET 一個 JSON 端點。非 2xx 或 JSON 解析失敗會拋 ApiError。 */
export function get<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<T> {
  return request<T>(`${path}${buildQuery(params)}`, { method: 'GET' }, signal)
}

/** POST 一個 JSON 端點。非 2xx 或 JSON 解析失敗會拋 ApiError。 */
export function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    signal,
  )
}

/**
 * 給「錯誤也是正常結果」的 mutating 端點用。
 *
 * server.ts 的多數 POST 端點在參數錯誤 / 衝突時回 400 / 404 / 409 / 429 / 500，
 * **但 body 形狀與成功時完全相同**（`{ ok: false, result }` 或 `{ ok: false, reason }`），
 * 訊息本身就是要顯示給使用者看的東西（例如 `RESTART_ERR_NO_LAUNCHD_LABEL`）。
 * 對這類端點用 `post()` 會把可用訊息包進例外裡，很難用；改用本函式：
 *
 * - 只要 body 能解析成 JSON，就直接回傳（不論 HTTP 狀態）。
 * - 只有 network 失敗、或非 2xx 且 body 不是 JSON（例如 403 純文字）才拋 ApiError。
 */
export async function postResult<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    return await post<T>(path, body, signal)
  } catch (err) {
    if (err instanceof ApiError && err.body !== undefined) return err.body as T
    throw err
  }
}
