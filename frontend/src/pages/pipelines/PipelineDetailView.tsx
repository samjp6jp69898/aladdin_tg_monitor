import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { topics } from '../../api/topics'
import type { BugStage } from '../../api/types'
import { Badge, Button, Card, DataTable, Toolbar, type Column } from '../../components/shared'
import { useResource } from '../../hooks'
import { dur, fmt, fmtTok, hms } from '../../lib/format'
import { pipelinesPath } from '../../lib/navigation'
import { AgentConversationCard } from './AgentConversationCard'
import type { AgentRunRow, PipelineRunDetail } from './types'

/**
 * Pipeline run 詳情頁（`#pl-detail`）。規格：migration/tabs/pipelines.md §1/§3/§4。
 * 由 PipelinesPage 依 `?key=` 是否存在決定要不要 mount 本元件——mount 期間本頁自己的
 * `useResource` 才會訂閱 5 秒輪詢，切回列表頁時本元件會被卸載、自動停止輪詢
 * （對應契約 §7「依目前在列表頁或詳情頁，只查對應的那一支」）。
 */
export function PipelineDetailView({ runKey }: { runKey: string }) {
  const navigate = useNavigate()
  const detail = useResource(topics.pipelineRun, { key: runKey })

  // 互動點 9：點 agent 列開對話。curAgentPath 對應舊版模組級變數，這裡改存 React state；
  // 進 run 詳情時（本元件重新 mount，因為 PipelinesPage 用 key={runKey}）自然歸零，
  // 等同舊版 openRun() 的 `curAgentPath = null`。
  const [agentPath, setAgentPath] = useState<string | null>(null)
  const agentTrace = useResource(
    topics.agentTrace,
    { path: agentPath ?? '' },
    { enabled: !!agentPath, autoRefresh: false }, // 不隨 5 秒輪詢自動更新
  )

  function handleOpenAgent(path: string) {
    // 規格：「每次點擊表格列都重新呼叫（不快取）」——重點同一列也要強制重打，
    // useResource 只在 params 變動時才重新訂閱，所以同一 path 改呼叫 reload()。
    if (path === agentPath) {
      void agentTrace.reload()
    } else {
      setAgentPath(path)
    }
  }

  const data = detail.data as unknown as PipelineRunDetail | null
  // run 找不到（GET 404）：get() 對非 2xx 一律拋 ApiError，且從未成功載入過。
  const notFound = Boolean(detail.error) && !data

  if (notFound) {
    return (
      <div>
        <Toolbar>
          <Button onClick={() => navigate(pipelinesPath())}>← 返回列表</Button>
          <span style={{ fontSize: 20, fontWeight: 600 }}>找不到紀錄</span>
        </Toolbar>
      </div>
    )
  }

  const r = data?.run
  const agents = r?.agents ?? []
  const stages = data?.stages ?? []
  const progress = data?.progress ?? []

  const stageColumns: Column<BugStage>[] = [
    {
      key: 'label',
      header: '階段',
      render: s => (
        <>
          {s.label}
          {s.detail && (
            <>
              {' '}
              <span className="mute">({s.detail})</span>
            </>
          )}
        </>
      ),
    },
    {
      key: 'status',
      header: '狀態',
      render: s => {
        if (s.status === 'done') return <Badge variant="ok">done</Badge>
        if (s.status === 'running') return <Badge variant="warn">running</Badge>
        if (s.status === 'reused')
          return (
            <Badge title="產物檔存在但非本輪產出：resume 續跑沿用上一輪，或全跑尚未重做到這步">
              沿用上輪
            </Badge>
          )
        return <Badge>pending</Badge>
      },
    },
    {
      key: 'started',
      header: '開始',
      className: 'mono',
      render: s => ((s.status === 'done' || s.status === 'running') && s.started_at ? fmt(s.started_at) : '-'),
    },
    {
      key: 'finished',
      header: '結束',
      className: 'mono',
      render: s => (s.finished_at ? fmt(s.finished_at) : '-'),
    },
    {
      key: 'duration',
      header: '耗時',
      className: 'mono',
      render: s => {
        if (s.status === 'done' && s.started_at) return dur(s.started_at, s.finished_at)
        if (s.status === 'running' && s.started_at) return `${dur(s.started_at, null)}…`
        return '-'
      },
    },
  ]

  const agentColumns: Column<AgentRunRow>[] = [
    { key: 'idx', header: '#', className: 'mono mute', render: (_a, i) => i + 1 },
    { key: 'stage', header: 'stage', className: 'mono', render: a => <b>{a.stage}</b> },
    { key: 'started', header: '開始', className: 'mono', render: a => hms(a.started_at) },
    {
      key: 'duration',
      header: '耗時',
      className: 'mono',
      render: a => (a.ended_at ? dur(a.started_at, a.ended_at) : <span className="warn">進行中</span>),
    },
    {
      key: 'model',
      header: 'model',
      className: 'mono',
      render: a => <span style={{ fontSize: '14px' }}>{a.model || ''}</span>,
    },
    { key: 'turns', header: 'turns', className: 'mono', render: a => a.num_turns ?? '' },
    { key: 'tools', header: 'tools', className: 'mono', render: a => a.tool_calls },
    {
      key: 'in',
      header: 'in (fresh/cache)',
      className: 'mono',
      render: a => `${fmtTok(a.input_tokens)} / ${fmtTok((a.cache_read_tokens || 0) + (a.cache_create_tokens || 0))}`,
    },
    { key: 'out', header: 'out', className: 'mono', render: a => fmtTok(a.output_tokens) },
    {
      key: 'status',
      header: '狀態',
      render: a =>
        a.is_error ? (
          <Badge variant="bad">error</Badge>
        ) : a.ended_at ? (
          <Badge variant="ok">ok</Badge>
        ) : (
          <Badge variant="warn">running</Badge>
        ),
    },
  ]

  return (
    <div>
      <Toolbar>
        {/* 互動點 4：← 返回列表 */}
        <Button onClick={() => navigate(pipelinesPath())}>← 返回列表</Button>
        <span style={{ fontSize: 20, fontWeight: 600 }}>{r ? `${r.ticket}（${r.kind}）` : ''}</span>
        <span className="mute">
          {r
            ? `${fmt(r.started_at)} → ${r.finished_at ? fmt(r.finished_at) : '進行中'} · ${dur(r.started_at, r.finished_at)} · ${r.running ? 'running' : r.outcome || ''}`
            : ''}
        </span>
      </Toolbar>

      <div className="stack">
        {stages.length > 0 && (
          <Card title="Pipeline 階段檢核表">
            <DataTable
              columns={stageColumns}
              rows={stages}
              rowKey={(s, i) => s.key || i}
              rowClassName={s => (s.status === 'running' ? 'stage-running' : undefined)}
              emptyText=""
            />
            {r?.running && (
              <div className="mute" style={{ marginTop: 8 }}>
                run 執行中：本表只反映各階段產物「檔案落地」的狀態，標不出此刻正在跑哪一步——Step
                5（fixer TDD 修復）不產出獨立文件所以沒有列；審查被否決後重做時，Step 6
                在新報告落地前仍顯示「沿用上輪」；Step 2b 的 done 也可能是 fixer 往
                analysis-notes 追加 TDD 紀錄（同一份文件）。
              </div>
            )}
            <div className="mute" style={{ marginTop: 8 }}>
              單一 claude -p session 內部各階段用 Task 呼叫子 agent，非獨立
              process，拿不到每階段各自的 token 用量——input/output token
              只有整次執行的合計，見下方「Agent 流程」表。開始/結束時間根據 Debug
              產物檔案存在與 mtime 推算，「開始」= 前一個已完成階段的結束時間，非精確量測。
            </div>
          </Card>
        )}

        <Card title="Agent 流程（依開始時間）">
          <DataTable
            columns={agentColumns}
            rows={agents}
            rowKey={a => a.path}
            rowClassName={a => (a.path === agentPath ? 'agent-row on' : 'agent-row')}
            onRowClick={a => handleOpenAgent(a.path)}
            emptyText={
              r?.kind === 'demand'
                ? '尚無 agent trace（只有 2026-08-21 12:30 之後觸發的需求單才有；更早的執行 dispatcher 沒有保存 agent 輸出）'
                : 'Bug pipeline 結束後才會解析 stdout 的用量'
            }
            maxHeight="80vh"
          />
          {agents.length > 0 && (
            <div className="mute" style={{ marginTop: 8 }}>
              合計 {agents.length} 個 agent · input {fmtTok(r?.total_input ?? 0)}（含 cache）· output{' '}
              {fmtTok(r?.total_output ?? 0)}
            </div>
          )}
        </Card>

        <Card title="進度 log">
          <div className="scroll">
            {progress.length > 0 ? (
              <table>
                <tbody>
                  {progress.map((p, i) => (
                    <tr key={i}>
                      <td className="mono mute">{hms(p.ts)}</td>
                      <td style={{ whiteSpace: 'normal' }}>{p.msg}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : r?.kind === 'demand' ? (
              <div className="mute">此區間 demand-pipeline.log 沒有紀錄</div>
            ) : r ? (
              <div className="mute">（Bug pipeline 的進度請看 stdout log）</div>
            ) : null}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <AgentConversationCard path={agentPath} resource={agentTrace} />
      </div>
    </div>
  )
}
