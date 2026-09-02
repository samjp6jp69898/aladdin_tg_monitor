/**
 * 歷史統計分頁（route: `#/stats`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/stats.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 這個檔案的路徑與 export 名稱是對路由的契約，**不可更名或搬移**。
 * 本頁沒有另外拆子元件的需要（五張表 + 一個長條圖都直接靠 DataTable / SparkBarChart 表達）。
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { topics } from '../api/topics'
import type { RosterMember, StatsAuthFailure, StatsTopIdentity, StatsTopTool } from '../api/types'
import { Button, Card, type Column, DataTable, SparkBarChart, type SparkBarItem, Toolbar, TwoColumn } from '../components/shared'
import { useResource } from '../hooks'
import { ago, fmt } from '../lib/format'
import { eventsPath } from '../lib/navigation'

type RosterRow = RosterMember & { service: string }

export function StatsPage() {
  const navigate = useNavigate()

  const [days, setDays] = useState(7)

  const stats = useResource(topics.stats, { days })
  const rosters = useResource(topics.rosters, undefined)

  const handleReload = () => {
    void Promise.all([stats.reload(), rosters.reload()])
  }

  // 3.2：前端自行產生「過去 24 小時」24 個整點刻度，比對 key 用 UTC，顯示用本地時間。
  const perHour = stats.data?.perHour ?? []
  const hours: SparkBarItem[] = Array.from({ length: 24 }, (_, i) => {
    const t = new Date(Date.now() - (23 - i) * 3600e3)
    const h = t.toISOString().slice(0, 13)
    return { t, n: perHour.find(x => x.hour === h)?.n ?? 0 }
  })

  // 3.3：每日 × 服務交叉表——欄依 perDay 出現順序去重，列去重後 reverse（最新日期在最上方）。
  const perDayRows = stats.data?.perDay ?? []
  const perDayDays = [...new Set(perDayRows.map(x => x.day))].reverse()
  const perDayServices = [...new Set(perDayRows.map(x => x.service))]
  const perDayCell = (day: string, service: string) => perDayRows.find(x => x.day === day && x.service === service)?.n || ''
  const perDayColumns: Column<string>[] = [
    { key: 'day', header: '日期', className: 'mono', render: day => day },
    ...perDayServices.map(
      (s): Column<string> => ({
        key: `svc:${s}`,
        header: s,
        className: 'mono',
        render: day => perDayCell(day, s),
      }),
    ),
  ]

  // 3.4：使用者排行——無表頭，排序依 API（last_ts DESC）。
  const identColumns: Column<StatsTopIdentity>[] = [
    { key: 'identity', header: '使用者', render: r => <b style={{ color: 'var(--acc)' }}>{r.identity}</b> },
    { key: 'service', header: '服務', render: r => r.service },
    { key: 'n', header: '次數', className: 'mono', render: r => r.n },
    { key: 'last_ts', header: '最後出現', className: 'mono mute', render: r => ago(r.last_ts) },
  ]

  // 3.5：tool 排行——無表頭，排序依 API（n DESC）。
  const toolColumns: Column<StatsTopTool>[] = [
    { key: 'tool', header: 'tool', className: 'mono', render: r => r.tool },
    { key: 'service', header: '服務', render: r => r.service },
    { key: 'n', header: '次數', className: 'mono', render: r => r.n },
    {
      key: 'errors',
      header: '錯誤',
      className: 'mono',
      cellClassName: r => (r.errors ? 'err' : undefined),
      render: r => r.errors,
    },
    { key: 'avg_ms', header: '平均耗時', className: 'mono mute', render: r => `${r.avg_ms ?? '-'}ms` },
    {
      key: 'actions',
      header: '',
      render: r => (
        <a
          href={eventsPath({ service: r.service, q: r.tool, errors: !!r.errors })}
          onClick={e => {
            e.preventDefault()
            navigate(eventsPath({ service: r.service, q: r.tool, errors: !!r.errors }))
          }}
        >
          {r.errors ? '看錯誤' : '看事件'}
        </a>
      ),
    },
  ]

  // 3.6：認證失敗來源——無表頭，排序依 API（n DESC），reason 固定紅字，動作固定 errorsOnly=true。
  const authColumns: Column<StatsAuthFailure>[] = [
    { key: 'service', header: '服務', render: r => r.service },
    { key: 'source_ip', header: 'IP', className: 'mono', render: r => r.source_ip || '' },
    { key: 'reason', header: '原因', className: 'mono err', render: r => r.reason || '' },
    { key: 'n', header: '次數', className: 'mono', render: r => r.n },
    { key: 'last_ts', header: '最後出現', className: 'mono mute', render: r => ago(r.last_ts) },
    {
      key: 'actions',
      header: '',
      render: r => (
        <a
          href={eventsPath({ service: r.service, q: r.source_ip || '', errors: true })}
          onClick={e => {
            e.preventDefault()
            navigate(eventsPath({ service: r.service, q: r.source_ip || '', errors: true }))
          }}
        >
          看事件
        </a>
      ),
    },
  ]

  // 3.7：Token 名冊——唯一有明確表頭列的統計卡片；flatMap 攤平成「每個 token 一列」。
  const rosterRows: RosterRow[] = (rosters.data ?? []).flatMap(x => x.roster.map(t => ({ ...t, service: x.service })))
  const rosterColumns: Column<RosterRow>[] = [
    { key: 'service', header: '服務', render: r => r.service },
    { key: 'id', header: 'id', className: 'mono', render: r => r.id },
    { key: 'display_name', header: 'display_name', render: r => r.display_name },
    { key: 'issued_at', header: '核發時間', className: 'mono mute', render: r => fmt(r.issued_at) },
  ]

  return (
    <>
      <Toolbar>
        <select
          value={days}
          onChange={e => {
            // 舊版 loadStats() 每次觸發（含 #st-days 變更）都同步呼叫 /api/rosters（stats.md §2）。
            // rosters 的查詢參數本身不含 days，reload() 只是重打同一份既有訂閱，不受 days 是否
            // 已完成 state 更新影響，不是靠時序才正確。
            setDays(Number(e.target.value))
            void rosters.reload()
          }}
        >
          <option value={1}>1 天</option>
          <option value={7}>7 天</option>
          <option value={30}>30 天</option>
          <option value={365}>1 年</option>
        </select>
        <Button onClick={handleReload}>重算</Button>
        <span className="mute">{stats.data ? `資料庫共 ${stats.data.totalEvents} 筆事件` : ''}</span>
      </Toolbar>

      <Card className="section" title="近 24 小時每小時請求數">
        <SparkBarChart items={hours} />
      </Card>

      <TwoColumn>
        <Card title="每日 × 服務">
          <DataTable columns={perDayColumns} rows={perDayDays} rowKey={day => day} emptyText="無資料" emptyMode="replace" />
        </Card>
        <Card title="使用者排行">
          <DataTable
            columns={identColumns}
            rows={stats.data?.topIdentities ?? []}
            rowKey={(r, i) => `${r.identity}-${r.service}-${i}`}
            showHeader={false}
            emptyText="無資料"
            emptyMode="replace"
          />
        </Card>
        <Card title="tool 排行（次數 / 錯誤 / 平均耗時）">
          <DataTable
            columns={toolColumns}
            rows={stats.data?.topTools ?? []}
            rowKey={(r, i) => `${r.tool}-${r.service}-${i}`}
            showHeader={false}
            emptyText="尚無 tool 呼叫"
            emptyMode="replace"
          />
        </Card>
        <Card title="認證失敗來源">
          <DataTable
            columns={authColumns}
            rows={stats.data?.authFailures ?? []}
            rowKey={(r, i) => `${r.service}-${r.source_ip}-${i}`}
            showHeader={false}
            emptyText="期間內無認證失敗"
            emptyTone="ok"
            emptyMode="replace"
          />
        </Card>
      </TwoColumn>

      <div style={{ marginTop: 12 }}>
        <Card title="Token 名冊（不含 token 值）">
          <DataTable columns={rosterColumns} rows={rosterRows} rowKey={r => `${r.service}-${r.id}`} emptyMode="none" />
        </Card>
      </div>
    </>
  )
}
