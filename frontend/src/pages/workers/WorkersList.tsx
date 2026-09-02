/**
 * Workers 分頁 — 列表視圖（`#wk-list-view`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/workers.md §3「列表頁」、§4-3/4/5
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchWorkerDetail, postWorkerDisable, postWorkerEnable, postWorkerRemove } from '../../api/endpoints'
import type { QueueStats, WorkerEntry, WorkersResponse } from '../../api/types'
import { Badge, Button, Card, type Column, DataTable, StatusDot } from '../../components/shared'
import { useAction } from '../../hooks'
import type { Resource } from '../../hooks'
import { fmt } from '../../lib/format'
import { workersPath } from '../../lib/navigation'

/** 舊版 `slot()`（index.html:664）：有資料顯示 `running/limit`（+排隊），無資料顯示 `-`。分頁專屬，不放共用層。 */
function slot(s: QueueStats | undefined | null): string {
  if (!s) return '-'
  return `${s.running}/${s.limit}${s.queued ? ` (+${s.queued} 排隊)` : ''}`
}

export interface WorkersListProps {
  resource: Resource<WorkersResponse>
}

export function WorkersList({ resource }: WorkersListProps) {
  const navigate = useNavigate()
  const action = useAction()
  const [reconnecting, setReconnecting] = useState<string | null>(null)

  async function handleDisable(name: string) {
    const r = await action.run(() => postWorkerDisable(name), {
      confirm: `確定要中斷 worker「${name}」嗎？\n\nhead 之後不會再把新工作派給它，但目前已經在它身上跑的工作不受影響（不會被砍掉）。`,
      onSettled: resource.reload,
    })
    if (r && !r.ok) window.alert(`中斷失敗：${r.message}`)
  }

  async function handleEnable(name: string) {
    const r = await action.run(() => postWorkerEnable(name), { onSettled: resource.reload })
    if (r && !r.ok) window.alert(`恢復失敗：${r.message}`)
  }

  async function handleRemove(name: string) {
    const r = await action.run(() => postWorkerRemove(name), {
      confirm: `確定要把 worker「${name}」從名冊移除嗎？\n\n注意：如果該機的 worker-agent 行程還在跑，它每 30 分鐘會自己重新登記回來（停用狀態也會重置）。要讓它真正退役，請同時在該機停掉 worker-agent（launchctl bootout）。`,
      onSettled: resource.reload,
    })
    if (r && !r.ok) window.alert(`移除失敗：${r.message}`)
  }

  // 重連＝立即重新探測這台的 /health 與 /capacity（GET /api/cluster/worker 本來就是
  // 即時 live probe，沒有快取層可繞）；探測完刷新整表。無成功/失敗提示——探測失敗時
  // 舊版是未捕捉的例外（列表也不會刷新），這裡刻意原樣保留靜默吞掉的行為。
  async function handleReconnect(name: string) {
    setReconnecting(name)
    try {
      await fetchWorkerDetail(name)
      await resource.reload()
    } catch {
      // 舊版行為：探測失敗不提示、也不刷新列表。
    } finally {
      setReconnecting(null)
    }
  }

  const columns: Column<WorkerEntry>[] = [
    { key: 'name', header: '名稱', render: w => <b style={{ color: 'var(--acc)' }}>{w.name}</b> },
    { key: 'url', header: 'URL', className: 'mono', render: w => w.url },
    {
      key: 'status',
      header: '狀態',
      render: w => (
        <>
          <StatusDot status={w.online ? 'up' : 'down'} /> <Badge variant={w.online ? 'ok' : 'bad'}>{w.online ? 'UP' : 'DOWN'}</Badge>
          {w.disabled ? (
            <>
              {' '}
              <Badge variant="warn">已停用</Badge>
            </>
          ) : null}
        </>
      ),
    },
    { key: 'bug', header: 'Bug 名額', className: 'mono', render: w => slot(w.capacity?.bug) },
    { key: 'demand', header: 'Demand 名額', className: 'mono', render: w => slot(w.capacity?.demand) },
    { key: 'registeredAt', header: '登記時間', className: 'mono', render: w => fmt(w.registeredAt) },
    {
      key: 'actions',
      header: '操作',
      render: w => (
        <>
          <Button onClick={() => navigate(workersPath(w.name))}>詳情</Button>{' '}
          <Button
            variant={w.disabled ? 'default' : 'warn'}
            disabled={action.pending}
            onClick={() => (w.disabled ? handleEnable(w.name) : handleDisable(w.name))}
          >
            {w.disabled ? '恢復' : '中斷'}
          </Button>{' '}
          <Button disabled={reconnecting === w.name} onClick={() => handleReconnect(w.name)}>
            重連
          </Button>{' '}
          <Button variant="danger" disabled={action.pending} onClick={() => handleRemove(w.name)}>
            移除
          </Button>
        </>
      ),
    },
  ]

  return (
    <div id="wk-list-view">
      {/* 對應舊版 index.html:218 `已註冊 Worker（<span id="wk-n">0</span>）`：計數包在獨立的
          <span> 裡（而非直接插值），視覺 parity 已驗證需要這個 DOM 結構。 */}
      <Card
        title={
          <>
            已註冊 Worker（<span>{resource.data?.workers.length ?? 0}</span>）
          </>
        }
      >
        {resource.data && (
          <DataTable
            columns={columns}
            rows={resource.data.workers}
            rowKey={w => w.name}
            emptyText="尚無已註冊的 worker（worker 機啟動 worker-agent.ts 後會自動登記，其後每 30 分鐘冪等重送）"
            emptyMode="replace"
          />
        )}
        <div className="mute" style={{ fontSize: '15px', marginTop: '8px' }}>
          名冊來源：telegram-dispatcher/logs/cluster-workers.json（worker-agent
          啟動時登記，其後每 30 分鐘冪等重送）。名冊只是「去哪裡問」的地址簿，不保證活著——狀態欄是即時探測 /health
          的結果。「中斷」只是讓 head 停止把新工作派給它，不影響已經在跑的工作；「移除」如果該機 worker-agent
          行程還在跑，30 分鐘內會自動重新登記回來，要真正退役請同時在該機停掉 worker-agent。
        </div>
      </Card>
    </div>
  )
}
