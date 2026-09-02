/**
 * mutating（POST）端點的結果正規化。
 *
 * server.ts 有**兩種錯誤欄位慣例**並存：
 * - `result`：/api/services/restart、/api/tg-users/*、/api/token-grants/*
 * - `reason`：/api/pipelines/cancel、/api/pipelines/retry、/api/cluster/worker/*
 *
 * 兩者語意相同（都是要顯示給使用者的訊息），差別只在欄位名。分頁不要各寫一份判斷，
 * 一律用 `normalizeActionResult()` 轉成 `{ ok, message }` 再顯示。
 */

export interface ActionResult {
  ok: boolean
  /** 顯示給使用者的訊息；後端沒給訊息時為空字串。 */
  message: string
  /** 後端原始回應，需要讀 killed / pid 之類額外欄位時用。 */
  raw: unknown
}

export function normalizeActionResult(raw: unknown): ActionResult {
  const r = (raw ?? {}) as { ok?: unknown; result?: unknown; reason?: unknown }
  const message =
    typeof r.result === 'string' ? r.result : typeof r.reason === 'string' ? r.reason : ''
  return { ok: r.ok === true, message, raw }
}

/** 把任意例外轉成 ActionResult（network 失敗、403 純文字等）。 */
export function errorToActionResult(err: unknown): ActionResult {
  return { ok: false, message: err instanceof Error ? err.message : String(err), raw: err }
}
