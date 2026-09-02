/**
 * Workers 分頁 — 單台詳情視圖（`#wk-detail`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/workers.md §3「詳情頁」、§4-6/7
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../../api/client'
import { fetchWorkerDetail } from '../../api/endpoints'
import { topics } from '../../api/topics'
import type { DispatchEntry, ProgressStage, WorkerDetailResponse } from '../../api/types'
import { Badge, Button, Card, type Column, DataTable, LogViewer, Toolbar, TwoColumn } from '../../components/shared'
import { useAction, useResource } from '../../hooks'
import { fmt } from '../../lib/format'
import { workersPath } from '../../lib/navigation'

/**
 * 舊版 `pre.log` 在本頁三處都是 `style="height:auto;max-height:30vh"`。2026-09-02 起
 * 共用 `LogViewer` 已補上 `maxHeight` prop，改用共用元件（`height="auto" maxHeight="30vh"`）。
 */
function LogPre({ text }: { text: string }) {
  return <LogViewer text={text} height="auto" maxHeight="30vh" />
}

export interface WorkerDetailProps {
  name: string
  initialTicket?: string
}

export function WorkerDetail({ name, initialTicket }: WorkerDetailProps) {
  const navigate = useNavigate()
  const detail = useResource(topics.workerDetail, { name }, {})

  const [ticketInput, setTicketInput] = useState(initialTicket ?? '')
  const [ticketQueried, setTicketQueried] = useState(false)
  const ticketAction = useAction()

  async function runTicketQuery(raw: string) {
    const t = raw.trim()
    if (!t || !name) return
    setTicketQueried(true)
    await ticketAction.run(() => fetchWorkerDetail(name, t))
  }

  // 對應舊版 `openWorkerTicket(name, ticket)`（跨頁跳轉入口）：帶著 ticket 進本頁時
  // 自動把輸入框填好並立即查一次，不等使用者按按鈕。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (initialTicket) void runTicketQuery(initialTicket)
  }, [])

  const apiErr = detail.error instanceof ApiError ? detail.error : null
  const errorMessage = apiErr
    ? apiErr.body && typeof apiErr.body === 'object' && 'error' in (apiErr.body as Record<string, unknown>)
      ? String((apiErr.body as Record<string, unknown>).error)
      : apiErr.message
    : null

  const title = detail.error ? name : (detail.data?.worker.name ?? name)
  const sub = detail.error
    ? (errorMessage ?? '')
    : detail.data
      ? `${detail.data.worker.url}（登記於 ${fmt(detail.data.worker.registeredAt)}）`
      : ''

  const ticketResp: WorkerDetailResponse | null =
    ticketAction.result?.raw && typeof ticketAction.result.raw === 'object' && 'ticketStatus' in ticketAction.result.raw
      ? (ticketAction.result.raw as WorkerDetailResponse)
      : null
  const ticketStatus = ticketResp?.ticketStatus ?? null
  const st = ticketStatus?.status ?? null

  const ticketResultText = !ticketQueried
    ? ''
    : ticketStatus
      ? JSON.stringify(ticketStatus, null, 2)
      : '（查詢失敗：worker 連不上，或票號格式不對，或 CLUSTER_SHARED_SECRET 未設定）'

  const ticketsColumns: Column<DispatchEntry>[] = [
    { key: 'ticket', header: '票號', className: 'mono', render: t => t.ticket },
    { key: 'kind', header: '種類', render: t => t.kind },
    { key: 'status', header: '狀態', render: t => t.status },
    { key: 'dispatchedAt', header: '派工時間', className: 'mono', render: t => fmt(t.dispatchedAt) },
    { key: 'triggeredBy', header: '觸發人', render: t => t.triggeredBy?.name ?? '' },
  ]

  const stageColumns: Column<ProgressStage>[] = [
    { key: 'label', header: '階段', render: s => s.label },
    {
      key: 'status',
      header: '狀態',
      render: s =>
        s.done ? (
          s.current ? (
            <Badge variant="warn">進行中</Badge>
          ) : (
            <Badge variant="ok">done</Badge>
          )
        ) : (
          <Badge>pending</Badge>
        ),
    },
    { key: 'at', header: '時間', className: 'mono', render: s => fmt(s.at) },
  ]

  return (
    <div id="wk-detail">
      <Toolbar>
        <Button onClick={() => navigate(workersPath())}>← 返回列表</Button>
        <span style={{ fontSize: '20px', fontWeight: 600 }}>{title}</span>
        <span className="mute">{sub}</span>
      </Toolbar>

      {detail.data && (
        <>
          <TwoColumn
            left={
              <Card title="GET /health">
                <LogPre text={detail.data.health ? JSON.stringify(detail.data.health, null, 2) : '（連不上 /health，worker 可能離線）'} />
              </Card>
            }
            right={
              <Card title="GET /capacity">
                <LogPre
                  text={
                    detail.data.capacity
                      ? JSON.stringify(detail.data.capacity, null, 2)
                      : '（連不上 /capacity，或 CLUSTER_SHARED_SECRET 未設定）'
                  }
                />
              </Card>
            }
          />

          <div style={{ marginTop: '12px' }}>
            <Card title="目前指派在這台的票">
              <DataTable
                columns={ticketsColumns}
                rows={detail.data.tickets}
                rowKey={(t, i) => `${t.ticket}-${i}`}
                emptyText="目前沒有票派在這台"
                emptyMode="replace"
              />
            </Card>
          </div>
        </>
      )}

      <div style={{ marginTop: '12px' }}>
        <Card title="查詢任一票在這台的 GET /jobs/:ticket">
          <Toolbar>
            <input
              placeholder="FAQ-1234 或 ALDREQ-1234"
              style={{ width: '220px' }}
              value={ticketInput}
              onChange={e => setTicketInput(e.target.value)}
            />
            <Button disabled={ticketAction.pending} onClick={() => runTicketQuery(ticketInput)}>
              查詢
            </Button>
          </Toolbar>
          <div className="mute" style={{ margin: '8px 0' }}>
            {ticketQueried && st && (
              <>
                鎖：{st.locked ? <Badge variant="ok">locked</Badge> : <Badge>未鎖</Badge>}
                　佇列狀態：{st.queueState ? <Badge variant="warn">{st.queueState}</Badge> : <span className="mute">-</span>}
              </>
            )}
          </div>
          {ticketQueried && st && (
            <DataTable
              columns={stageColumns}
              rows={st.stages ?? []}
              rowKey={(s, i) => `${s.key}-${i}`}
              rowClassName={s => (s.current ? 'stage-running' : undefined)}
              emptyText={st.locked ? '已鎖但查無 stage 產物（可能剛起步）' : '未鎖：本機無此單活動'}
              emptyMode="replace"
            />
          )}
          <details style={{ marginTop: '8px' }}>
            <summary className="mute">原始回應</summary>
            <LogPre text={ticketResultText} />
          </details>
        </Card>
      </div>
    </div>
  )
}
