import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/shell/AppShell'
import { ConnectLayout } from './components/shell/ConnectLayout'
import { RefreshProvider } from './hooks/refresh'
import { DEFAULT_TAB, tabPath } from './lib/routes'
import { EventsPage } from './pages/EventsPage'
import { LogsPage } from './pages/LogsPage'
import { OverviewPage } from './pages/OverviewPage'
import { PipelinesPage } from './pages/PipelinesPage'
import { SessionsPage } from './pages/SessionsPage'
import { StatsPage } from './pages/StatsPage'
import { TgConnectedPage } from './pages/TgConnectedPage'
import { TgPendingPage } from './pages/TgPendingPage'
import { TokensPage } from './pages/TokensPage'
import { ToolsmithPage } from './pages/ToolsmithPage'
import { WorkersPage } from './pages/WorkersPage'

/**
 * 應用進入點：HashRouter + 刷新匯流排 + 殼層 + 11 條路由。
 *
 * 用 HashRouter 是為了沿用舊版的 `#tab` 網址形式（舊書籤 `#/overview` 可直接運作），
 * 且 build 產物掛在 `/next/` 底下不需要後端另外做 SPA fallback。
 *
 * 與舊版的**刻意行為差異**（已在契約文件記錄）：舊版沒有監聽 hashchange，
 * 手動編輯網址列的 hash 不會切換分頁；HashRouter 會正確處理，屬修正而非破壞 parity。
 */
export function App() {
  return (
    <HashRouter>
      <RefreshProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to={tabPath(DEFAULT_TAB)} replace />} />
            <Route path="overview" element={<OverviewPage />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="stats" element={<StatsPage />} />
            {/* 「連接」大分頁：三個 subtab 共用同一個 SubNav layout */}
            <Route element={<ConnectLayout />}>
              <Route path="tokens" element={<TokensPage />} />
              <Route path="tg-connected" element={<TgConnectedPage />} />
              <Route path="tg-pending" element={<TgPendingPage />} />
            </Route>
            <Route path="pipelines" element={<PipelinesPage />} />
            <Route path="toolsmith" element={<ToolsmithPage />} />
            <Route path="workers" element={<WorkersPage />} />
            <Route path="logs" element={<LogsPage />} />
            {/* 未知路由一律回預設分頁，等同舊版 `location.hash.slice(1) || 'overview'` */}
            <Route path="*" element={<Navigate to={tabPath(DEFAULT_TAB)} replace />} />
          </Route>
        </Routes>
      </RefreshProvider>
    </HashRouter>
  )
}
