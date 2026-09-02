/**
 * 路由與導覽列定義。對應舊版 index.html:68-82（header/nav）與 281-284（showTab）。
 *
 * 11 個合法 route 對應 9 顆主 nav 按鈕——tokens / tg-connected / tg-pending 三個 route
 * 共用「連接」那一顆（舊版的 `data-group` 機制）。
 */

export type TabKey =
  | 'overview'
  | 'events'
  | 'sessions'
  | 'stats'
  | 'tokens'
  | 'tg-connected'
  | 'tg-pending'
  | 'pipelines'
  | 'toolsmith'
  | 'workers'
  | 'logs'

export interface NavItem {
  /** 點下去要導到的 route。 */
  tab: TabKey
  /** 中文標籤，照抄舊版。 */
  label: string
  /**
   * 對應舊版 `data-group`：只要目前 route 在這個清單裡，這顆按鈕就呈現選中態。
   * 省略時只比對 `tab === current`。
   */
  group?: TabKey[]
}

/** 9 顆主 nav 按鈕，順序照舊版。 */
export const NAV_ITEMS: NavItem[] = [
  { tab: 'overview', label: '總覽' },
  { tab: 'events', label: '即時序列' },
  { tab: 'sessions', label: '使用 Session' },
  { tab: 'stats', label: '歷史統計' },
  { tab: 'tokens', label: '連接', group: ['tokens', 'tg-connected', 'tg-pending'] },
  { tab: 'pipelines', label: 'Pipelines' },
  { tab: 'toolsmith', label: 'Toolsmith' },
  { tab: 'workers', label: 'Workers' },
  { tab: 'logs', label: 'Logs' },
]

/** 「連接」大分頁底下的 3 個 subtab，中文標籤照抄舊版。 */
export const CONNECT_SUBTABS: { key: TabKey; label: string }[] = [
  { key: 'tokens', label: 'Token 權限' },
  { key: 'tg-connected', label: 'TG 已連接' },
  { key: 'tg-pending', label: 'TG 待處理' },
]

export const DEFAULT_TAB: TabKey = 'overview'

/** route 值 → 路徑（HashRouter 下實際網址是 `#/overview`）。 */
export function tabPath(tab: TabKey): string {
  return `/${tab}`
}

/** 從 pathname 反推目前 tab；對不到回 null。 */
export function tabFromPath(pathname: string): TabKey | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0]
  const found = NAV_ITEMS.some(n => n.tab === seg) || CONNECT_SUBTABS.some(s => s.key === seg)
  return found ? (seg as TabKey) : null
}

/** 某顆 nav 按鈕在目前 route 下是否該高亮（含 data-group 邏輯）。 */
export function isNavActive(item: NavItem, current: TabKey | null): boolean {
  if (current === null) return false
  return item.tab === current || (item.group?.includes(current) ?? false)
}
