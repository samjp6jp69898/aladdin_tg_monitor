import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * 標準按鈕。對應舊版 `button.btn` / `.btn.danger` / `.btn.warn`。
 *
 * 注意 danger / warn **不只是換顏色**：舊版 CSS 同時把 padding 縮成 `4px 10px`、
 * 字級縮到 15px（見 global.css），所以它們視覺上比 default 小一號，這是原行為。
 */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: 'default' | 'danger' | 'warn'
  className?: string
  children?: ReactNode
}

export function Button({ variant = 'default', className, children, type, ...rest }: ButtonProps) {
  const cls = ['btn', variant === 'default' ? '' : variant, className].filter(Boolean).join(' ')
  return (
    <button type={type ?? 'button'} className={cls} {...rest}>
      {children}
    </button>
  )
}
