/**
 * 總覽分頁（route: `#/overview`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/overview.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 這個檔案的路徑與 export 名稱是對路由的契約，**不可更名或搬移**。
 * 分頁專屬子元件放在 src/pages/overview/ 底下。
 */
import { useNavigate } from 'react-router-dom'
import { postMaintenance, postPipelineCancel, postServiceRestart } from '../api/endpoints'
import { topics } from '../api/topics'
import type { CancelPipelineResponse, MaintenanceToggleResponse, QueuedTicket, RunningProc, StatusLogRow } from '../api/types'
import { Badge, Button, Card, CardGrid, type Column, DataTable, EmptyState, KeyValueGrid, TwoColumn } from '../components/shared'
import { useAction, useResource } from '../hooks'
import { ago, dur, fmt } from '../lib/format'
import { tgConnectedPath, tgPendingPath } from '../lib/navigation'
import { ServiceCard } from './overview/ServiceCard'

export function OverviewPage() {
  const navigate = useNavigate()

  const overview = useResource(topics.overview, undefined)
  const statusLog = useResource(topics.statusLog, {})
  const maintenance = useResource(topics.maintenance, undefined)

  const restartAction = useAction()
  const cancelAction = useAction()
  const maintenanceAction = useAction()

  const handleMaintenanceToggle = async (nextOn: boolean) => {
    const result = await maintenanceAction.run(() => postMaintenance(nextOn), {
      confirm: nextOn
        ? '確定要開啟維護模式嗎？\n\nhead 不會再拒絕新的 Bug／需求單認領，而是照收並排入等待佇列，維護結束後依收到順序自動處理，TG 通知認領人；worker 會立即停止接受新工作（不影響 head 收單）。目前已在跑的工作不受影響。'
        : '確定要關閉維護模式嗎？\n\nhead 會立即開始依序處理維護期間排隊的請求，並恢復正常受理新單；worker 會立即恢復接受新工作。',
      onSettled: maintenance.reload,
    })
    if (!result) return
    const raw = result.raw as Partial<MaintenanceToggleResponse> & { reason?: string }
    // 400（缺 on）／409（secret 未設定）這兩種是請求本身被拒絕，body 形狀是
    // `{ ok: false, reason }`，完全沒有 head/workers 欄位——這時候顯示「head
    // 失敗」是誤導（head 根本沒被打到）。用 head 欄位存不存在來分辨兩種失敗
    // （review 發現：原本不分這兩種，一律當成「head 這端切換失敗」）。
    if (!raw.head) {
      window.alert(`維護模式切換失敗：${result.message || raw.reason || 'unknown'}`)
      return
    }
    if (result.ok) {
      window.alert(`已${nextOn ? '開啟' : '關閉'}維護模式（head：${raw.head.ok ? '成功' : '失敗'}；worker：${raw.workers!.filter(w => w.ok).length}/${raw.workers!.length} 台成功）`)
    } else {
      const failedWorkers = raw.workers?.filter(w => !w.ok).map(w => w.name) ?? []
      window.alert(
        `維護模式切換部分失敗：head ${raw.head.ok ? '成功' : '失敗'}` +
          (failedWorkers.length ? `；以下 worker 沒切成功：${failedWorkers.join(', ')}（可能剛好斷線，稍後重試或個別確認）` : ''),
      )
    }
  }

  const reloadAll = async () => {
    await Promise.all([overview.reload(), statusLog.reload()])
  }

  const handleRestart = async (id: string, name: string) => {
    const result = await restartAction.run(() => postServiceRestart(id), {
      confirm: `確定要重啟「${name}」嗎？\n\n會執行 launchctl kickstart -k 重新拉起該 launchd job，服務會短暫離線幾秒。`,
      onSettled: reloadAll,
    })
    if (result) {
      window.alert(result.ok ? `已送出重啟：${result.message}` : `重啟失敗：${result.message}`)
    }
  }

  const handleCancel = async (kind: 'bug' | 'demand', ticket: string) => {
    const result = await cancelAction.run(() => postPipelineCancel(kind, ticket), {
      confirm: `確定要取消 ${kind} pipeline ${ticket}？\n\n會送 SIGTERM 給整棵行程樹；wrapper 的收尾會照常執行（釋放 bug-lock、發 TG「異常終止」通知給認領人、釋放併發名額）。`,
      onSettled: reloadAll,
    })
    if (!result) return
    if (result.ok) {
      const raw = result.raw as CancelPipelineResponse
      window.alert(
        `已送出取消：對 ${raw.killed.length} 個子行程送出 SIGTERM（${raw.killed.join(', ')}），wrapper ${raw.wrapperPid} 會自行收尾。幾秒後列表會更新。`,
      )
    } else {
      window.alert(`取消失敗：${result.message || 'unknown'}`)
    }
  }

  if (!overview.data) return null
  const d = overview.data
  const wh = d.webhook
  const tgu = d.tgUsers
  const pp = d.pipelines
  const queued = pp.queued || []
  const limitNote = pp.limitsSource === 'fallback' ? (
    <span className="mute" title="啟動時讀不到 dispatcher 常數，顯示後備值">
      (後備值)
    </span>
  ) : null

  const runningColumns: Column<RunningProc>[] = [
    { key: 'kind', header: '類型', render: r => r.kind },
    { key: 'ticket', header: '票號', className: 'mono', render: r => r.ticket },
    { key: 'etime', header: '已跑', className: 'mono', render: r => r.etime },
    { key: 'pid', header: 'PID', className: 'mono', render: r => r.pid },
    {
      key: 'extra',
      header: '附註',
      className: 'mono',
      render: r => <span style={{ whiteSpace: 'normal' }}>{r.kind === 'demand' ? r.extra || '' : ''}</span>,
    },
    {
      key: 'actions',
      header: '',
      render: r => (
        <Button variant="danger" onClick={() => handleCancel(r.kind, r.ticket)}>
          取消
        </Button>
      ),
    },
  ]

  const queuedColumns: Column<QueuedTicket>[] = [
    { key: 'position', header: '排隊', className: 'mono', render: q => `#${q.position}` },
    { key: 'kind', header: '類型', render: q => q.kind },
    { key: 'ticket', header: '票號', className: 'mono', render: q => q.ticket },
    { key: 'waited', header: '已等', className: 'mono', render: q => (q.enqueuedAt ? dur(q.enqueuedAt, null) : '-') },
    { key: 'triggeredBy', header: '發起人', render: q => q.triggeredBy || '' },
  ]

  const statusLogColumns: Column<StatusLogRow>[] = [
    { key: 'ts', header: '時間', className: 'mono', render: r => fmt(r.ts) },
    { key: 'service', header: '服務', render: r => r.service },
    { key: 'status', header: '狀態', render: r => <span className={r.status === 'up' ? 'ok' : 'err'}>{r.status}</span> },
    { key: 'detail', header: 'detail', className: 'mono mute', render: r => r.detail || '' },
  ]

  const m = maintenance.data
  const anyMaintenanceOn = m ? m.head.on || m.workers.some(w => w.on === true) : false

  return (
    <>
      <div className="section">
        <Card title="維護模式（手動開關受理 Bug／需求單）">
          {m ? (
            <>
              <KeyValueGrid
                rows={[
                  {
                    label: 'head',
                    value: <Badge variant={m.head.on ? 'warn' : 'ok'}>{m.head.on ? '維護中' : '正常受理'}</Badge>,
                  },
                  ...m.workers.map(w => ({
                    label: w.name,
                    value:
                      w.on === null ? (
                        <Badge variant="bad">無法確認（連不上）</Badge>
                      ) : (
                        <Badge variant={w.on ? 'warn' : 'ok'}>{w.on ? '維護中' : '正常受理'}</Badge>
                      ),
                  })),
                ]}
              />
              <div style={{ marginTop: '8px' }}>
                {m.secretConfigured ? (
                  <Button
                    variant={anyMaintenanceOn ? 'default' : 'warn'}
                    disabled={maintenanceAction.pending}
                    onClick={() => handleMaintenanceToggle(!anyMaintenanceOn)}
                  >
                    {anyMaintenanceOn ? '關閉維護模式' : '開啟維護模式'}
                  </Button>
                ) : (
                  <span className="mute">CLUSTER_SHARED_SECRET 未設定，維護模式開關停用</span>
                )}
              </div>
              <div className="mute" style={{ fontSize: '15px', marginTop: '8px' }}>
                開啟期間 head 照收新的 Bug／需求單認領，排入等待佇列、維護結束後依收到順序自動處理（TG bot 回覆已排隊訊息）；該台 worker
                則立即停止接受新工作。已經在跑的工作不受影響。head 與每台 worker 各自獨立一份旗標，「無法確認」代表該台當下連不上，不代表它正在受理。
              </div>
            </>
          ) : (
            <EmptyState text="讀取中…" />
          )}
        </Card>
      </div>

      <div className="section">
        <h2>
          服務 / Port（每 5 秒探測；「目前使用中」= 最近 <span>{d.activeWindowMin}</span> 分鐘內有稽核紀錄的人）
        </h2>
        <CardGrid>
          {d.services.map(s => (
            <ServiceCard key={s.id} service={s} onRestart={handleRestart} />
          ))}
        </CardGrid>
      </div>

      <TwoColumn
        left={
          <Card title="Telegram Webhook">
            {wh.ok ? (
              <>
                <KeyValueGrid
                  rows={[
                    { label: 'URL', value: wh.url || '-' },
                    {
                      label: '待送達',
                      value: <span className={wh.pendingUpdateCount ? 'err' : 'ok'}>{wh.pendingUpdateCount ?? '-'}</span>,
                    },
                    {
                      label: '上次錯誤',
                      value: wh.lastErrorMessage ? (
                        <>
                          {wh.lastErrorMessage}{' '}
                          <span className="mute">
                            ({fmt(wh.lastErrorDate)} · {ago(wh.lastErrorDate)}）
                          </span>
                        </>
                      ) : (
                        <span className="ok">無</span>
                      ),
                    },
                    { label: '邊緣 IP', value: wh.ipAddress || '-' },
                  ]}
                />
                <div className="mute" style={{ fontSize: '14px', marginTop: '6px' }}>
                  查詢時間 {fmt(wh.checkedAt)}（快取 30 秒）；「上次錯誤」只在真的有送達失敗時更新，修好後不會自動清空，時間比對照更重要
                </div>
              </>
            ) : (
              <div className="err">查詢失敗：{wh.error || 'unknown'}</div>
            )}
          </Card>
        }
        right={
          <Card title="TG 連接名單">
            <KeyValueGrid
              rows={[
                {
                  label: '已連接',
                  value: (
                    <>
                      {tgu.connectedCount ?? '-'}{' '}
                      <a
                        href={tgConnectedPath()}
                        onClick={e => {
                          e.preventDefault()
                          navigate(tgConnectedPath())
                        }}
                      >
                        查看
                      </a>
                    </>
                  ),
                },
                {
                  label: '待處理',
                  value: (
                    <span className={tgu.pendingCount ? 'err' : undefined}>
                      {tgu.pendingCount ?? '-'}{' '}
                      <a
                        href={tgPendingPath()}
                        onClick={e => {
                          e.preventDefault()
                          navigate(tgPendingPath())
                        }}
                      >
                        查看
                      </a>
                    </span>
                  ),
                },
              ]}
            />
          </Card>
        }
      />

      <TwoColumn
        left={
          <Card title="背景 Pipeline 併發">
            <KeyValueGrid
              rows={[
                {
                  label: 'Bug /create-mr',
                  value: (
                    <>
                      {pp.bugSlots.used} / {pp.bugSlots.limit}
                      {pp.bugSlots.queued ? (
                        <>
                          {' '}
                          <Badge variant="warn">排隊 {pp.bugSlots.queued}</Badge>
                        </>
                      ) : null}
                      {limitNote ? <> {limitNote}</> : null}
                    </>
                  ),
                },
                {
                  label: '需求 pipeline',
                  value: (
                    <>
                      {pp.demandSlots.used} / {pp.demandSlots.limit}
                      {pp.demandSlots.queued ? (
                        <>
                          {' '}
                          <Badge variant="warn">排隊 {pp.demandSlots.queued}</Badge>
                        </>
                      ) : null}
                      {limitNote ? <> {limitNote}</> : null}
                    </>
                  ),
                },
                { label: 'bug-lock', value: pp.locks.length ? pp.locks.map(l => l.ticket).join(', ') : '無' },
              ]}
            />

            {pp.running.length > 0 ? (
              <div style={{ marginTop: '8px' }}>
                <DataTable
                  columns={runningColumns}
                  rows={pp.running}
                  rowKey={(r, i) => `${r.kind}-${r.ticket}-${i}`}
                  scroll={false}
                  emptyText=""
                />
              </div>
            ) : (
              <div style={{ marginTop: '8px' }}>
                <EmptyState text="目前沒有背景 pipeline 在跑" />
              </div>
            )}

            {queued.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <DataTable
                  columns={queuedColumns}
                  rows={queued}
                  rowKey={(q, i) => `${q.kind}-${q.ticket}-${i}`}
                  scroll={false}
                  emptyText=""
                />
              </div>
            )}
          </Card>
        }
        right={
          <Card title="最近狀態翻轉">
            <DataTable
              columns={statusLogColumns}
              rows={(statusLog.data?.rows ?? []).slice(0, 30)}
              rowKey={r => r.id}
              emptyText="尚無紀錄"
              emptyMode="replace"
              showHeader={false}
            />
          </Card>
        }
      />
    </>
  )
}
