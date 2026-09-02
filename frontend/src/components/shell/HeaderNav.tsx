import { Fragment } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { NAV_ITEMS, isNavActive, tabFromPath, tabPath } from '../../lib/routes'
import { useTriggerRefresh } from '../../hooks/refresh'

/**
 * 頂部固定 header。對應舊版 index.html:68-82。
 *
 * - 標題 `tg-monitor`
 * - 9 顆 nav 按鈕（中文標籤照抄），「連接」那顆在 tokens / tg-connected / tg-pending
 *   三個 route 下都呈現選中態（舊版 data-group 機制）
 * - 右上角「↻ 刷新」：`margin-left:auto` 推到最右，tooltip「立即刷新當前分頁的資料」，
 *   點擊等同舊版 `refresh(true)`
 */
export function HeaderNav() {
  const navigate = useNavigate()
  const location = useLocation()
  const current = tabFromPath(location.pathname)
  const triggerRefresh = useTriggerRefresh()

  return (
    <header>
      <h1>tg-monitor</h1>
      <nav>
        {/* 舊版是手寫 HTML，`<button>` 之間的換行/縮排在 inline 排版下會塌縮成一個空白字元，
            靠這個天然的文字節點撐出按鈕間距（nav 本身不是 flex、沒有 gap）。`.map()` 產生的
            陣列元素彼此間沒有這種空白文字節點，會讓按鈕貼得比舊版緊——用 `{i > 0 && ' '}`
            補回同樣的字面空白，而不是硬湊一個 CSS gap 數字。 */}
        {NAV_ITEMS.map((item, i) => (
          <Fragment key={item.tab}>
            {i > 0 && ' '}
            <button
              type="button"
              className={isNavActive(item, current) ? 'on' : undefined}
              onClick={() => navigate(tabPath(item.tab))}
            >
              {item.label}
            </button>
          </Fragment>
        ))}
      </nav>
      <button
        type="button"
        className="btn"
        title="立即刷新當前分頁的資料"
        style={{ marginLeft: 'auto' }}
        onClick={triggerRefresh}
      >
        ↻ 刷新
      </button>
    </header>
  )
}
