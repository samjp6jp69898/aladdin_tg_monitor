/**
 * 服務狀態圓點。對應舊版 `.dot` / `.dot.up` / `.dot.down`。
 * `status` 為 undefined / null 時是灰點（未知）。
 */
export interface StatusDotProps {
  status?: 'up' | 'down' | null
  /** 原生 tooltip。 */
  title?: string
  className?: string
}

export function StatusDot({ status, title, className }: StatusDotProps) {
  const cls = ['dot', status === 'up' ? 'up' : status === 'down' ? 'down' : '', className]
    .filter(Boolean)
    .join(' ')
  return <span className={cls} title={title} />
}
