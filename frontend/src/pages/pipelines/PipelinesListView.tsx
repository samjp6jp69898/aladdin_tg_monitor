import { useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { postPipelineCancel, postPipelineRetry } from '../../api/endpoints'
import type { CancelPipelineResponse, PipelinesResponse, RetryPipelineResponse } from '../../api/types'
import { Badge, Button, DataTable, ResultBadge, Toolbar, type Column } from '../../components/shared'
import { useAction, type Resource } from '../../hooks'
import { dur, fmt, fmtTok } from '../../lib/format'
import { logsPath, pipelinesPath, workersPath } from '../../lib/navigation'
import { DEMAND_PIPELINE_LOG_PATH, type PipelineListRow } from './types'

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
    window.alert(
      result.ok
        ? `已觸發續跑（pid ${raw.pid}），列表會在下個 tick 顯示新的一次執行。`
        : `重試失敗：${raw.reason || 'unknown'}`,
    )
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
        if (row.kind === 'queued') return '本機'
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
        return '本機'
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
      key: 'started',
      header: '開始',
      className: 'mono',
      cellTitle: row => (row.kind === 'queued' ? '排入佇列時間' : undefined),
      render: row => {
        if (row.kind === 'queued') return row.data.enqueuedAt ? fmt(row.data.enqueuedAt) : '-'
        if (row.kind === 'remote') return fmt(row.data.dispatchedAt)
        return fmt(row.data.started_at)
      },
    },
    {
      key: 'finished',
      header: '結束',
      className: 'mono',
      render: row => (row.kind === 'history' ? fmt(row.data.finished_at) : '-'),
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
      header: 'tokens in / out',
      className: 'mono',
      render: row => {
        if (row.kind !== 'history') return ''
        const r = row.data
        return r.agent_count ? `${fmtTok(r.total_input)} / ${fmtTok(r.total_output)}` : ''
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
      key: 'log',
      header: 'log',
      cellClassName: row => (row.kind === 'remote' ? 'mute' : undefined),
      render: row => {
        if (row.kind === 'queued') return null
        if (row.kind === 'remote') return '在 worker 本機'
        const r = row.data
        // 互動點 5：stdout / stderr / 進度 log 連結
        const openLog = (path: string | null) => (e: MouseEvent) => {
          e.preventDefault()
          if (path) navigate(logsPath(path))
        }
        if (r.kind === 'demand') {
          return (
            <a
              href={logsPath(DEMAND_PIPELINE_LOG_PATH)}
              onClick={openLog(DEMAND_PIPELINE_LOG_PATH)}
              title="需求 pipeline 的進度全部寫在共用的 demand-pipeline.log，逐票 stdout 固定是空的"
            >
              進度 log
            </a>
          )
        }
        return (
          <>
            <a href={logsPath(r.stdout_path ?? undefined)} onClick={openLog(r.stdout_path)}>
              stdout
            </a>
            {' · '}
            <a href={logsPath(r.stderr_path ?? undefined)} onClick={openLog(r.stderr_path)}>
              stderr
            </a>
          </>
        )
      },
    },
    {
      key: 'actions',
      header: '',
      render: row => {
        if (row.kind !== 'history') return null
        const r = row.data
        if (r.running) {
          return (
            <Button variant="danger" disabled={cancelAction.pending} onClick={() => handleCancel(r.kind, r.ticket)}>
              取消
            </Button>
          )
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
