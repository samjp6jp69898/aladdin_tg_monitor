import type { ReactNode } from 'react'

/**
 * 卡片容器。對應舊版 `.card` + `.card h3`（index.html:7-65 樣式區）。
 */
export interface CardProps {
  /** 標題列內容；可放圖示、pill、按鈕（h3 本身是 flex，gap 10px）。省略則不渲染標題列。 */
  title?: ReactNode
  /** 追加在 `.card` 上的 class。 */
  className?: string
  /** 追加在標題 `h3` 上的 class。 */
  titleClassName?: string
  children?: ReactNode
}

export function Card({ title, className, titleClassName, children }: CardProps) {
  return (
    <div className={className ? `card ${className}` : 'card'}>
      {title !== undefined && <h3 className={titleClassName}>{title}</h3>}
      {children}
    </div>
  )
}
