import { useSearchParams } from 'react-router-dom'
import { topics } from '../api/topics'
import { useResource } from '../hooks'
import { PipelineDetailView } from './pipelines/PipelineDetailView'
import { PipelinesListView } from './pipelines/PipelinesListView'

/**
 * Pipelines 分頁（route: `#/pipelines`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/pipelines.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 列表／詳情頁切換照契約 §3.1「列表／詳情切換」pattern：靠 `?key=` query 參數決定，
 * 不是元件內部 state。有 `key` 進詳情頁，沒有就是列表頁——`PipelineDetailView` 用
 * `key={key}` 掛在外層，`key` 變動時整個子樹重新 mount，等同舊版 `openRun()` 重置
 * `curRunKey`/`curAgentPath` 的效果。
 *
 * 列表頁與詳情頁各自的 `useResource` 只在對應視圖真正 mount 時才訂閱，切換視圖時
 * 未使用的那支資源自動停止輪詢（契約 §7）。
 */
export function PipelinesPage() {
  const [searchParams] = useSearchParams()
  const key = searchParams.get('key')

  if (key) {
    return <PipelineDetailView key={key} runKey={key} />
  }
  return <PipelinesListPage />
}

function PipelinesListPage() {
  const resource = useResource(topics.pipelines, undefined)
  return <PipelinesListView resource={resource} />
}
