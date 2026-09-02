import type { ReactNode } from 'react'

/**
 * 單欄堆疊版面。對應舊版 `.stack`：`grid-template-columns:1fr; gap:16px`。
 * pipelines 詳情頁用它把多張卡片上下排開。
 */
export interface StackProps {
  className?: string
  children?: ReactNode
}

export function Stack({ className, children }: StackProps) {
  return <div className={className ? `stack ${className}` : 'stack'}>{children}</div>
}
