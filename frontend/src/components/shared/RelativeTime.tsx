import { ago, fmt } from '../../lib/format'

/**
 * 相對時間顯示。對應舊版 index.html:274 的 `ago(ts)` 呼叫點。
 *
 * 沒有自己的 timer——舊版也是靠 5 秒輪詢重繪才更新，這裡維持相同語意
 * （分頁資料更新造成 re-render 時就會重算）。
 */
export interface RelativeTimeProps {
  ts?: string | null
  /**
   * 是否加上 `title={fmt(ts)}` 的完整時間 tooltip。
   * **舊版沒有這個 tooltip**，預設 false 以維持 parity；toolsmith 分頁有明確用到才開。
   */
  withTitle?: boolean
  className?: string
}

export function RelativeTime({ ts, withTitle = false, className }: RelativeTimeProps) {
  return (
    <span className={className} title={withTitle ? fmt(ts) : undefined}>
      {ago(ts)}
    </span>
  )
}
