import { useEffect, useRef } from 'react'

/**
 * 純呈現的 log 檢視框。對應舊版 `pre.log`（`#lg-out`、pipelines 的 `#pd-prompt`、
 * workers 詳情頁的 JSON 區塊都是同一個 class）。
 *
 * **本元件不打 API**。輪詢式的「即時跟隨」由 `useLogFollow()` hook 負責，
 * 它算出來的文字再餵給這裡；靜態用途（prompt、JSON.stringify 結果）直接傳 text。
 */
export interface LogViewerProps {
  text: string
  /** 內容變動後自動捲到底（即時跟隨時要開）。預設 false。行為見下方元件註解。 */
  autoScroll?: boolean
  /**
   * 整批替換訊號：由呼叫端（如 `useLogFollow().loadId`）提供，值變動代表這次 text
   * 更新是「整批替換」（換檔案 / 改 kb / 切換 follow / 重新載入），值不變而 text
   * 變長代表「純追加」。不傳（`undefined`）時視為訊號恆定，一律走追加判定——
   * 現有靜態呼叫端（`autoScroll` 預設 false）不受影響，因為下面的 effect 整段
   * 被 `autoScroll` 短路跳過。
   */
  reloadToken?: string | number
  /** 覆寫高度；預設沿用 `pre.log` 的 70vh。 */
  height?: string
  /** 覆寫 max-height；搭配 `height="auto"` 可重現舊版 `height:auto;max-height:30vh`（workers 詳情）
   *  / `max-height:40vh`（pipelines 的 Prompt/rawStdout）組合。 */
  maxHeight?: string
  /** text 為空字串時顯示的替代文字（例如「(檔案不存在)」）。 */
  emptyText?: string
  className?: string
}

export function LogViewer({ text, autoScroll = false, reloadToken, height, maxHeight, emptyText, className }: LogViewerProps) {
  const ref = useRef<HTMLPreElement>(null)
  const prevReloadTokenRef = useRef(reloadToken)
  /** 目前是否在底部附近（40px 容忍）；由 onScroll 持續追蹤，供下次文字變動時判斷要不要自動捲動。 */
  const atBottomRef = useRef(true)

  const handleScroll = () => {
    const el = ref.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  useEffect(() => {
    const el = ref.current
    if (autoScroll && el) {
      // 對應舊版 loadLog()：初次載入 / 整批替換一律捲到底（index.html:744，
      // 例如換檔案、改 kb、切換 follow 或呼叫 reload() 觸發的 tail 重抓）；
      // 「即時跟隨」timer 內單純追加內容時，只有原本就在底部附近才自動捲動，
      // 避免打斷使用者往上翻歷史（index.html:751-753，容忍 40px，包含其截斷清空
      // 分支——那也是在追加迴圈裡發生，一樣走 40px 判定而非無條件捲到底）。
      // 是替換還是追加由呼叫端傳入的 reloadToken 決定，不再用「新文字是否為舊文字
      // 延伸」猜：內容形狀本質上無法區分「使用者重新載入、文字剛好長成 舊+新位元組」
      // 與「純追加」這兩種情境。
      const isReplace = reloadToken !== prevReloadTokenRef.current
      if (isReplace || atBottomRef.current) el.scrollTop = el.scrollHeight
    }
    prevReloadTokenRef.current = reloadToken
  }, [text, autoScroll, reloadToken])

  return (
    <pre
      ref={ref}
      onScroll={autoScroll ? handleScroll : undefined}
      className={className ? `log ${className}` : 'log'}
      style={height || maxHeight ? { height, maxHeight } : undefined}
    >
      {text === '' && emptyText !== undefined ? emptyText : text}
    </pre>
  )
}
