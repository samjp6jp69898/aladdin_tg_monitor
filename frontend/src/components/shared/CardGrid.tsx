import type { ReactNode } from 'react'

/**
 * 響應式卡片牆。對應舊版 `.grid`：`repeat(auto-fill, minmax(440px, 1fr))`，gap 16px。
 */
export interface CardGridProps {
  className?: string
  children?: ReactNode
}

export function CardGrid({ className, children }: CardGridProps) {
  return <div className={className ? `grid ${className}` : 'grid'}>{children}</div>
}
