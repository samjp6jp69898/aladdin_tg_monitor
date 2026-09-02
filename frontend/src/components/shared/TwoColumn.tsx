import type { ReactNode } from 'react'

/**
 * 兩欄並排版面。對應舊版 `.two`：1fr 1fr，≤1000px 自動降為單欄。
 *
 * 兩種用法擇一：傳 `left`/`right`，或直接把兩個子元素當 children 傳進來。
 */
export interface TwoColumnProps {
  left?: ReactNode
  right?: ReactNode
  className?: string
  children?: ReactNode
}

export function TwoColumn({ left, right, className, children }: TwoColumnProps) {
  return (
    <div className={className ? `two ${className}` : 'two'}>
      {children ?? (
        <>
          {left}
          {right}
        </>
      )}
    </div>
  )
}
