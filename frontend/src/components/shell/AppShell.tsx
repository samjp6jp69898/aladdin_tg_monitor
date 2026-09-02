import { Outlet } from 'react-router-dom'
import { HeaderNav } from './HeaderNav'

/**
 * 應用殼層：固定 header + `<main>` 容器（`padding:20px 22px; max-width:1700px; margin:0 auto`）。
 * 目前分頁由巢狀路由的 `<Outlet/>` 渲染。
 */
export function AppShell() {
  return (
    <>
      <HeaderNav />
      <main>
        <Outlet />
      </main>
    </>
  )
}
