import { resultPillText, resultPillVariant } from '../../lib/format'
import { Badge } from './Badge'

/**
 * 事件「結果」欄徽章。對應舊版 index.html:277 的 `resPill()`。
 *
 * 顏色規則（與舊版完全相同）：falsy / 'unknown' → 灰；'success' / 'recovered' → 綠；其餘一律紅。
 * 舊版回傳 HTML 字串，這裡改回傳元件——新前端不得使用 dangerouslySetInnerHTML。
 */
export interface ResultBadgeProps {
  result?: string | null
  title?: string
  className?: string
}

export function ResultBadge({ result, title, className }: ResultBadgeProps) {
  return (
    <Badge variant={resultPillVariant(result)} title={title} className={className}>
      {resultPillText(result)}
    </Badge>
  )
}
