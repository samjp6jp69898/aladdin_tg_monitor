import type { ReactNode } from 'react'

/**
 * 篩選／操作列容器。對應舊版 `.bar`：flex、gap 8px、wrap、垂直置中、下方 12px。
 * 純樣式元件——輸入框、按鈕、尾端的 `.mute` 統計文字都直接當 children 放進來。
 */
export interface ToolbarProps {
  className?: string
  children?: ReactNode
}

export function Toolbar({ className, children }: ToolbarProps) {
  return <div className={className ? `bar ${className}` : 'bar'}>{children}</div>
}
