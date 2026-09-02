import { useCallback, useState } from 'react'
import { errorToActionResult, normalizeActionResult, type ActionResult } from '../lib/mutation'

/**
 * 執行一個 mutating 端點的共用流程：（可選）confirm →  呼叫 API → 正規化結果 →（可選）刷新資料。
 *
 * 對應舊版散落在各分頁的
 * `if(!confirm(...))return; const r=await fetch(...).then(r=>r.json()).catch(...); alert(r.result); loadXxx()`。
 * 這裡不強制 alert——要不要跳訊息由分頁自己決定（讀 `result` 或 `run()` 的回傳值）。
 */
export interface RunOptions {
  /** 有值時先跳 window.confirm，使用者取消則不執行、回傳 null。 */
  confirm?: string
  /** 成功或失敗後都會呼叫（通常傳資源的 reload）。 */
  onSettled?: () => void | Promise<void>
}

export interface UseActionResult {
  /** 執行中（同一個 hook 實例一次只跑一個動作）。 */
  pending: boolean
  /** 最近一次結果；尚未執行過為 null。 */
  result: ActionResult | null
  /** 清掉 `result`（例如關閉提示框時）。 */
  reset: () => void
  run: (fn: () => Promise<unknown>, options?: RunOptions) => Promise<ActionResult | null>
}

export function useAction(): UseActionResult {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)

  const reset = useCallback(() => setResult(null), [])

  const run = useCallback(
    async (fn: () => Promise<unknown>, options: RunOptions = {}): Promise<ActionResult | null> => {
      if (options.confirm && !window.confirm(options.confirm)) return null
      setPending(true)
      let out: ActionResult
      try {
        out = normalizeActionResult(await fn())
      } catch (err) {
        out = errorToActionResult(err)
      }
      setResult(out)
      setPending(false)
      await options.onSettled?.()
      return out
    },
    [],
  )

  return { pending, result, reset, run }
}
