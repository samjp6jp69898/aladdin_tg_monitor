import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postPipelineCancel, postPipelineRetry } from '../../api/endpoints'
import type { CancelPipelineResponse, PipelinesResponse, RetryPipelineResponse } from '../../api/types'
import { Badge, Button, DataTable, ResultBadge, Toolbar, type Column } from '../../components/shared'
import { useAction, type Resource } from '../../hooks'
import { dur, fmt, fmtTok } from '../../lib/format'
import { pipelinesPath, workersPath } from '../../lib/navigation'
import type { PipelineListRow } from './types'

/**
 * Pipelines 列表頁。規格：migration/tabs/pipelines.md §1（`#pl-list`）、§3（`loadPipelines()`）。
 */
export function PipelinesListView({ resource }: { resource: Resource<PipelinesResponse> }) {
  const navigate = useNavigate()
  const [hideOutcomeCol, setHideOutcomeCol] = useState(false) // 互動點 2：純前端 toggle，不打 API，重整頁面會重置
  const cancelAction = useAction()
  const retryAction = useAction()

  const d = resource.data

  const rows: PipelineListRow[] = [
    ...(d?.queued ?? []).map((data): PipelineListRow => ({ kind: 'queued', data })),
    ...(d?.remote ?? []).map((data): PipelineListRow => ({ kind: 'remote', data })),
    ...(d?.rows ?? []).map((data): PipelineListRow => ({ kind: 'history', data })),
  ]

  // 互動點 6：取消。只在本機歷史列且 running===true 時出現。
  async function handleCancel(kind: 'bug' | 'demand', ticket: string) {
    const result = await cancelAction.run(() => postPipelineCancel(kind, ticket), {
      confirm: `確定要取消 ${kind} pipeline ${ticket}？\n\n會送 SIGTERM 給整棵行程樹；wrapper 的收尾會照常執行（釋放 bug-lock、發 TG「異常終止」通知給認領人、釋放併發名額）。`,
    })
    if (result === null) return // 使用者在 confirm 對話框按了取消
    const raw = result.raw as CancelPipelineResponse
    window.alert(
      result.ok
        ? `已送出取消：對 ${raw.killed.length} 個子行程送出 SIGTERM（${raw.killed.join(', ')}），wrapper ${raw.wrapperPid} 會自行收尾。幾秒後列表會更新。`
        : `取消失敗：${raw.reason || 'unknown'}`,
    )
    await resource.reload() // 一律 refresh(true)：不論成功失敗
  }

  // 互動點 7：重試。只在本機歷史列且 retryable===true 時出現（僅 FAQ-*）。
  async function handleRetry(ticket: string) {
    const result = await retryAction.run(() => postPipelineRetry(ticket), {
      confirm: `確定要重試 ${ticket}？\n\n會從上一輪最後完成的階段接續（沿用既有分析產物與 mr/ 分支的 commit；審查有 FAILED 時從 fixer 重做、三審皆過時直接 Solution 彙整起）。盤點失敗會自動退回整張全跑。`,
    })
    if (result === null) return
    const raw = result.raw as RetryPipelineResponse
    window.alert(result.ok ? `已觸發續跑（${describeRetryOutcome(raw)}），列表會在下個 tick 顯示新的一次執行。` : `重試失敗：${raw.reason || 'unknown'}`)
    await resource.reload()
  }

  const columns: Column<PipelineListRow>[] = [
    {
      key: 'ticket',
      header: '票號',
      className: 'mono',
      render: row => {
        if (row.kind === 'history') {
          const r = row.data
          return (
            <a
              href={pipelinesPath(r.key)}
              onClick={e => {
                e.preventDefault()
                // 互動點 3：進入 run 詳情
                navigate(pipelinesPath(r.key))
              }}
            >
              {r.ticket}
            </a>
          )
        }
        return row.data.ticket
      },
    },
    {
      key: 'worker',
      header: 'Worker',
      className: 'mono',
      render: row => {
        if (row.kind === 'queued') {
          // 維護模式期間照收排隊（見 QueuedTicket.reason 註解）跟背景併發已滿
          // 排隊是兩份完全獨立的狀態，用同一顆 badge 樣式標出來避免混淆——
          // 這種單不是「併發滿了在等名額」，是「維護結束才會開始處理」。
          return row.data.reason === 'maintenance' ? (
            <>
              本機 <Badge variant="warn">維護中排隊</Badge>
            </>
          ) : (
            '本機'
          )
        }
        if (row.kind === 'remote') {
          const r = row.data
          if (!r.worker) return '(交涉中)'
          return (
            <a
              href={workersPath(r.worker, r.ticket)}
              onClick={e => {
                e.preventDefault()
                // 互動點 8：遠端列 Worker 名稱連結
                navigate(workersPath(r.worker, r.ticket))
              }}
            >
              {r.worker}
            </a>
          )
        }
        // history 列（來自 /api/pipelines 的 rows）：host 只有 MON_READ_SOURCE=mysql
        // 才會帶（lib/read/types.ts PipelineRunRow.host?），依實際值分三種顯示，
        // 不再不分青紅皂白硬寫「本機」。
        const host = row.data.host
        if (host === 'head') return '本機'
        if (host === 'unknown_pre_migration') return '未知（遷移前）'
        if (!host) return '未知'
        // 任務 3（2026-09-04）：worker 執行的 history 列補上跟 remote 列一樣的
        // worker 詳情連結——原本只有純文字，跟 remote 列（互動點 8）比起來
        // 少了一個入口，這輪順手補齊。
        return (
          <a
            href={workersPath(host, row.data.ticket)}
            onClick={e => {
              e.preventDefault()
              navigate(workersPath(host, row.data.ticket))
            }}
          >
            {host}
          </a>
        )
      },
    },
    {
      key: 'assignee',
      header: '發起人',
      render: row => {
        if (row.kind === 'queued') return row.data.triggeredBy || ''
        if (row.kind === 'remote') return row.data.triggeredBy?.name || ''
        return row.data.assignee || ''
      },
    },
    {
      key: 'time',
      header: '開始／結束',
      className: 'mono',
      cellTitle: row => (row.kind === 'queued' ? '排入佇列時間' : undefined),
      render: row => {
        const started =
          row.kind === 'queued'
            ? row.data.enqueuedAt
              ? fmt(row.data.enqueuedAt)
              : '-'
            : row.kind === 'remote'
              ? fmt(row.data.dispatchedAt)
              : fmt(row.data.started_at)
        const finished = row.kind === 'history' ? fmt(row.data.finished_at) : '-'
        return (
          <div style={{ lineHeight: 1.4 }}>
            <div>{started}</div>
            <div className="mute">{finished}</div>
          </div>
        )
      },
    },
    {
      key: 'duration',
      header: '耗時',
      className: 'mono',
      cellTitle: row => (row.kind === 'queued' ? '已等待' : undefined),
      render: row => {
        if (row.kind === 'queued') return row.data.enqueuedAt ? dur(row.data.enqueuedAt, null) : '-'
        if (row.kind === 'remote') return dur(row.data.dispatchedAt, null)
        return dur(row.data.started_at, row.data.finished_at)
      },
    },
    {
      key: 'tokens',
      header: (
        <span title="cache：同一 session 內重複讀取既有對話歷史的量，不是新產生的資料量——需求單常見數千萬～上億，屬正常現象，不代表真的處理了那麼多新資料">
          tokens in / cache / out
        </span>
      ),
      className: 'mono',
      cellTitle: row => {
        if (row.kind !== 'history' || !row.data.agent_count) return undefined
        return 'cache：同一 session 內重複讀取既有對話歷史的量，不是新產生的資料量'
      },
      render: row => {
        if (row.kind !== 'history') return ''
        const r = row.data
        if (!r.agent_count) return ''
        const cache = (r.total_cache_read ?? 0) + (r.total_cache_create ?? 0)
        return `${fmtTok(r.total_input)} / ${fmtTok(cache)} / ${fmtTok(r.total_output)}`
      },
    },
    {
      key: 'outcome',
      header: '結果',
      className: 'col-outcome',
      headerClassName: 'col-outcome',
      render: row => {
        if (row.kind !== 'history') return null
        const outcome = row.data.outcome
        if (outcome === 'cancelled') return <Badge variant="warn">cancelled</Badge>
        if (outcome) return <ResultBadge result={outcome === 'success' ? 'success' : outcome.split(' ')[0]} />
        return null
      },
    },
    {
      key: 'actions',
      header: '',
      render: row => {
        // 互動點 6 延伸（任務 3，2026-09-04）：worker 執行中的列（row.kind ===
        // 'remote'）原本刻意不顯示取消按鈕——後端當時查不到本機行程只能直接
        // 回「not running」。現在 /api/pipelines/cancel 本機查不到時會改查
        // dispatch_attempts/登記表並轉發給對應的 worker（見 server.ts
        // findRemoteWorkerForTicket），所以這裡改成一樣可以按取消。
        if (row.kind === 'remote') {
          return (
            <Button variant="danger" disabled={cancelAction.pending} onClick={() => handleCancel(row.data.kind, row.data.ticket)}>
              取消
            </Button>
          )
        }
        if (row.kind !== 'history') return null
        const r = row.data
        if (r.running) {
          return (
            <Button variant="danger" disabled={cancelAction.pending} onClick={() => handleCancel(r.kind, r.ticket)}>
              取消
            </Button>
          )
        }
        // worker 連不上/逾時，無法確認這張票是否還在跑（見 types.ts
        // runningStatusUnknown 註解）：不顯示重試/取消按鈕，避免誤按。
        if (r.runningStatusUnknown) {
          return <span className="mute">無法確認執行狀態</span>
        }
        if (r.retryable) {
          return (
            <Button variant="warn" disabled={retryAction.pending} onClick={() => handleRetry(r.ticket)}>
              重試
            </Button>
          )
        }
        return null
      },
    },
  ]

  return (
    <div>
      <Toolbar>
        {/* 互動點 1：重新整理 */}
        <Button onClick={() => resource.reload()}>重新整理</Button>
        <Button
          onClick={() => setHideOutcomeCol(v => !v)}
        >
          {hideOutcomeCol ? '顯示結果欄' : '隱藏結果欄'}
        </Button>
        <span className="mute">
          資料來源：telegram-dispatcher/logs 逐票 log 檔名 + ps 行程表。需求單（demand）的進度在共用的
          demand-pipeline.log，逐票 stdout 為空是正常的。
        </span>
      </Toolbar>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row, i) =>
          row.kind === 'queued'
            ? `queued:${row.data.ticket}`
            : row.kind === 'remote'
              ? `remote:${row.data.ticket}`
              : row.data.key || i
        }
        emptyText="無資料"
        maxHeight="80vh"
        wrapperClassName={hideOutcomeCol ? 'hide-outcome' : undefined}
      />
    </div>
  )
}

/**
 * 重試觸發成功後的人話描述（task 2，2026-09-04）：cluster 啟用時可能落到某台
 * worker（`status`/`worker` 才會出現，見 api/types.ts RetryPipelineResponse
 * 註解），單機部署仍只有 `pid`——兩種形狀都要能講清楚「續跑去哪了」。
 */
function describeRetryOutcome(raw: RetryPipelineResponse): string {
  if (raw.status === 'remote_started' || raw.status === 'already_running_remote') return `派工至 worker ${raw.worker}`
  if (raw.status === 'queued') return '已排入背景佇列'
  if (raw.status === 'already_running' || raw.status === 'already_queued') return '已在執行中/排隊中'
  return `pid ${raw.pid}`
}
