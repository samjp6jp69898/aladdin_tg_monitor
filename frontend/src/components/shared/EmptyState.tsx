/**
 * 「無資料」文案。對應舊版各分頁散落的 `<div class="mute">無資料</div>` /
 * `<div class="ok">期間內無認證失敗</div>` 等。
 *
 * 各分頁文案不同，一律由 `text` 傳入，不要在這裡寫死預設文案。
 */
export interface EmptyStateProps {
  text: string
  /** mute = 灰（最常見）、ok = 綠（stats「期間內無認證失敗」）、err = 紅。 */
  tone?: 'mute' | 'ok' | 'err'
  className?: string
}

export function EmptyState({ text, tone = 'mute', className }: EmptyStateProps) {
  return <div className={className ? `${tone} ${className}` : tone}>{text}</div>
}
