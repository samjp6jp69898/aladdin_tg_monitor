/**
 * 分頁內的次分頁列。對應舊版 `.subnav` + `.subnav button.on`。
 * 「連接」大分頁下的 Token 權限／TG 已連接／TG 待處理三個 subtab 用它。
 */
export interface SubNavItem {
  key: string
  label: string
}

export interface SubNavProps {
  items: SubNavItem[]
  /** 目前選中的 key；比對是嚴格相等（不像主 nav 有 data-group 機制）。 */
  active: string
  onSelect: (key: string) => void
  className?: string
}

export function SubNav({ items, active, onSelect, className }: SubNavProps) {
  return (
    <div className={className ? `subnav ${className}` : 'subnav'}>
      {items.map(it => (
        <button
          key={it.key}
          type="button"
          className={it.key === active ? 'on' : undefined}
          onClick={() => onSelect(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
