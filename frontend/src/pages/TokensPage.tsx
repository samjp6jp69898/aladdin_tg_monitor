import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { topics } from '../api/topics'
import { Button, Toolbar } from '../components/shared'
import { useResource } from '../hooks'
import { tokensPath } from '../lib/navigation'
import { TokenDetailView } from './tokens/TokenDetailView'
import { TokenListView } from './tokens/TokenListView'

/**
 * Token 權限分頁（route: `#/tokens`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/tokens.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 兩層視圖（列表 / 單人詳情）都吃同一個 `/api/token-grants`（舊版 loadTokenGrants /
 * loadTokenDetail 打的是同一個端點），所以本頁只用**一個** `useResource`，用網址
 * `?id=` 決定要渲染 TokenListView 還是 TokenDetailView（規格 §6.2 tokensPath）。
 *
 * 「重新整理」bar 在舊版 HTML 裡是列表視圖與詳情視圖**共用**的一段（index.html:140，
 * 位在 `#tk-list-view` / `#tk-detail` 兩個 div 之外），所以放在這裡、不進子元件。
 * subnav（Token 權限／TG 已連接／TG 待處理）由殼層 `ConnectLayout` 統一渲染，本頁不重畫。
 */
export function TokensPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const id = searchParams.get('id')

  const { data, error, reload } = useResource(topics.tokenGrants, undefined)

  const person = id && data ? data.people.find(p => p.id === id) : undefined

  // 詳情頁找不到此人（例如另一個瀏覽器分頁把這個人的 token 全刪了，本分頁輪詢時撲空）：
  // 自動切回列表頁，無提示訊息。對應舊版 loadTokenDetail() L428：
  // `if (!p) { closeTokenDetail(); return }`
  useEffect(() => {
    if (id && data && !person) {
      navigate(tokensPath(), { replace: true })
    }
  }, [id, data, person, navigate])

  return (
    <>
      <Toolbar>
        <Button onClick={() => reload()}>重新整理</Button>
        <span className="mute">
          名冊來源：各 hosted MCP server 的 tokens*.json（只讀 id / display_name /
          核發時間，絕不顯示 token 值）。
        </span>
      </Toolbar>
      {error && !data ? (
        <div className="err">{String(error)}</div>
      ) : !data ? null : id ? (
        person && <TokenDetailView data={data} person={person} reload={reload} />
      ) : (
        <TokenListView data={data} reload={reload} />
      )}
    </>
  )
}
