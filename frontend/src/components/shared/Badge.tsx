import type { CSSProperties, ReactNode } from 'react'
import type { PillVariant } from '../../lib/format'

/**
 * 膠囊徽章。對應舊版 `.pill` / `.pill.ok` / `.pill.bad` / `.pill.warn`。
 */
export interface BadgeProps {
  /** default = 灰框灰字（`.pill`）。 */
  variant?: PillVariant
  /** 原生 tooltip（toolsmith 的 gate、pipelines 的「沿用上輪」都需要）。 */
  title?: string
  className?: string
  /** inline style（例如 `margin-left:auto` 之類的佈局需求），不需再靠外層 `<span>` 包裹。 */
  style?: CSSProperties
  children?: ReactNode
}

export function Badge({ variant = 'default', title, className, style, children }: BadgeProps) {
  const cls = ['pill', variant === 'default' ? '' : variant, className].filter(Boolean).join(' ')
  return (
    <span className={cls} title={title} style={style}>
      {children}
    </span>
  )
}
