import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { SubNav } from '../shared'
import { CONNECT_SUBTABS, tabFromPath, tabPath } from '../../lib/routes'

/**
 * 「連接」大分頁的共用 subnav 外框。對應舊版三個 section 內各自重複一份的
 * `.subnav`（index.html:135-139、239-243、249-253）。
 *
 * 舊版是三份重複的 DOM，這裡改成巢狀路由的 layout，只寫一份；
 * subtab 選中判定是嚴格比對目前 route（不吃 data-group），與舊版一致。
 */
export function ConnectLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const current = tabFromPath(location.pathname)

  return (
    <>
      <SubNav
        items={CONNECT_SUBTABS.map(s => ({ key: s.key, label: s.label }))}
        active={current ?? ''}
        onSelect={key => navigate(tabPath(key as (typeof CONNECT_SUBTABS)[number]['key']))}
      />
      <Outlet />
    </>
  )
}
