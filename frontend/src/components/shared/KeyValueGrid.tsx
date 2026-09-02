import type { ReactNode } from 'react'

/**
 * 標籤／數值兩欄格。對應舊版 `.kv` + `.kv b`（值用等寬字體、允許斷行）。
 */
export interface KeyValueRow {
  /** React list key；省略時用陣列索引。 */
  key?: string
  label: ReactNode
  value: ReactNode
}

export interface KeyValueGridProps {
  /**
   * 允許夾帶 falsy 值，會被自動濾掉——方便寫「有值才顯示整列」：
   * `rows={[{label:'網址', value:url}, err && {label:'上次錯誤', value:err}]}`
   */
  rows: (KeyValueRow | false | null | undefined)[]
  className?: string
}

export function KeyValueGrid({ rows, className }: KeyValueGridProps) {
  const visible = rows.filter((r): r is KeyValueRow => Boolean(r))
  return (
    <div className={className ? `kv ${className}` : 'kv'}>
      {visible.map((r, i) => (
        <div key={r.key ?? i} style={{ display: 'contents' }}>
          <span>{r.label}</span>
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  )
}
