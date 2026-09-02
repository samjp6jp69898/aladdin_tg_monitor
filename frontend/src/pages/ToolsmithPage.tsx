/**
 * Toolsmith 分頁（route: `#/toolsmith`）。
 *
 * 顯示企劃呼叫 `aladdin_toolsmith_generate_tool` 後，aladdin-toolsmith 背景任務的即時進度。
 * 單一表格頁，每列可展開一段詳情。無任何寫入型操作按鈕——本頁純唯讀監控。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/toolsmith.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 輪詢：`topics.toolsmith`（streamable，5 秒輪詢，對應舊版 index.html:834 的 `refresh()`
 * toolsmith 分支）。展開狀態存在本元件的 React state（`expanded`），不受輪詢重繪影響——
 * 契約 §8-2「已定調的刻意行為差異」第 2 條：舊版 `innerHTML` 整表重建會把展開列收合，
 * 新版刻意不重現這個副作用。
 */
import { useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { topics } from '../api/topics'
import type { ToolsmithRun } from '../api/types'
import { Badge, Button, DataTable, Toolbar, type Column } from '../components/shared'
import { useResource } from '../hooks'
import { ago, fmt } from '../lib/format'
import { logsPath } from '../lib/navigation'
import { tsStatusLabel, tsStatusVariant } from './toolsmith/format'
import { ToolsmithDetail } from './toolsmith/ToolsmithDetail'

const SUMMARY_MAX = 60

export function ToolsmithPage() {
  const navigate = useNavigate()
  const resource = useResource(topics.toolsmith, undefined)
  const rows = resource.data?.rows ?? []

  // 互動點 4：展開/收合。key 穩定用 requestId，存在頁面自己的 state，輪詢不會沖掉（契約 §8-2）。
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openLog = (path: string) => (e: MouseEvent) => {
    e.preventDefault()
    navigate(logsPath(path))
  }

  const columns: Column<ToolsmithRun>[] = [
    {
      key: 'requestId',
      header: 'requestId',
      className: 'mono',
      cellTitle: row => row.requestId,
      render: row => row.requestId.slice(0, 8),
    },
    {
      key: 'target',
      header: 'target',
      className: 'mono',
      render: row => row.target,
    },
    {
      key: 'requestedBy',
      header: '發起人',
      render: row => row.requestedBy,
    },
    {
      key: 'status',
      header: '狀態',
      render: row => <Badge variant={tsStatusVariant(row.status)}>{tsStatusLabel(row.status)}</Badge>,
    },
    {
      key: 'roundsCount',
      header: '輪次',
      className: 'mono',
      render: row => row.roundsCount,
    },
    {
      key: 'createdAt',
      header: '建立',
      className: 'mono',
      render: row => fmt(row.createdAt),
    },
    {
      key: 'updatedAt',
      header: '更新',
      className: 'mono',
      cellTitle: row => ago(row.updatedAt),
      render: row => fmt(row.updatedAt),
    },
    {
      key: 'summary',
      header: '摘要',
      render: row => (row.request.length > SUMMARY_MAX ? `${row.request.slice(0, SUMMARY_MAX)}…` : row.request),
    },
    {
      key: 'log',
      header: 'log',
      render: row => (
        <>
          {row.agentLogExists ? (
            <a href={logsPath(row.agentLogPath)} onClick={openLog(row.agentLogPath)}>
              研究log
            </a>
          ) : (
            <span className="mute">研究log</span>
          )}
          {' · '}
          {row.deployLogExists ? (
            <a href={logsPath(row.deployLogPath)} onClick={openLog(row.deployLogPath)}>
              部署log
            </a>
          ) : (
            <span className="mute">部署log</span>
          )}
        </>
      ),
    },
    {
      key: 'expand',
      header: '',
      render: row => (
        <Button style={{ padding: '2px 8px' }} onClick={() => toggleExpand(row.requestId)}>
          {expanded.has(row.requestId) ? '▾' : '▸'}
        </Button>
      ),
    },
  ]

  return (
    <div>
      <Toolbar>
        <Button onClick={() => resource.reload()}>重新整理</Button>
        <span className="mute">
          資料來源：aladdin-toolsmith 的 scratch/{'<requestId>'}/conversation.json（即時現讀，非收集器）。企劃呼叫
          aladdin_toolsmith_generate_tool 後，這裡會出現一筆請求，狀態隨背景處理即時更新。
        </span>
      </Toolbar>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={row => row.requestId}
        emptyText="無資料"
        maxHeight="80vh"
        renderExpanded={row => (expanded.has(row.requestId) ? <ToolsmithDetail run={row} /> : null)}
      />
    </div>
  )
}
