/**
 * Workers分頁（route: `#/workers`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/workers.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 這個檔案的路徑與 export 名稱是對路由的契約，**不可更名或搬移**。
 * 分頁專屬子元件在 src/pages/workers/ 底下：WorkersList（列表視圖）、WorkerDetail（單台詳情視圖）。
 *
 * 列表／詳情切換一律用 query 參數（`?name=`，可再帶 `?ticket=`），不用元件內部 state
 * （契約 §6.2）。頂部「重新整理」按鈕與 secret 提示是舊版 `#wk-reload`/`#wk-secret-note`，
 * 在 HTML 結構上位於列表／詳情視圖**外層**、兩者切換時都看得到，所以放在這裡而不是子元件裡。
 */
import { useSearchParams } from 'react-router-dom'
import { topics } from '../api/topics'
import { Button, Toolbar } from '../components/shared'
import { useResource } from '../hooks'
import { WorkerDetail } from './workers/WorkerDetail'
import { WorkersList } from './workers/WorkersList'

export function WorkersPage() {
  const [searchParams] = useSearchParams()
  const name = searchParams.get('name')
  const ticket = searchParams.get('ticket')

  // 只在列表視圖訂閱 /api/cluster/workers（契約 §7：workers 依目前列表/詳情頁只查對應那支）。
  // 由於本 hook 掛在頁面層、不隨視圖切換而卸載，`data` 在切到詳情視圖後仍保留最後一次的值，
  // 與舊版「secret 提示只在 loadWorkers() 跑過才會更新、切到詳情不會清空」的行為一致。
  const list = useResource(topics.workers, undefined, { enabled: !name })

  return (
    <div>
      <Toolbar>
        <Button onClick={() => list.reload()}>重新整理</Button>
        <span className="mute">
          {list.data && !list.data.secretConfigured
            ? '（CLUSTER_SHARED_SECRET 未設定或格式不對：無法探測名額/票務，僅顯示名冊）'
            : ''}
        </span>
      </Toolbar>

      {name ? <WorkerDetail key={name} name={name} initialTicket={ticket ?? undefined} /> : <WorkersList resource={list} />}
    </div>
  )
}
