/**
 * 使用 Session分頁（route: `#/sessions`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/sessions.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 這個檔案的路徑與 export 名稱是對路由的契約，**不可更名或搬移**。
 * 分頁專屬子元件放在 src/pages/sessions/ 底下（本頁沒有另外拆子元件的需要）。
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { topics } from '../api/topics'
import type { SessionRow } from '../api/types'
import { Button, type Column, DataTable, Toolbar } from '../components/shared'
import { useResource } from '../hooks'
import { ago, dur, fmt } from '../lib/format'
import { eventsPath } from '../lib/navigation'

export function SessionsPage() {
  const navigate = useNavigate()

  const [service, setService] = useState('')
  const [days, setDays] = useState('7')
  const [identityInput, setIdentityInput] = useState('')
  const [identity, setIdentity] = useState('')

  // §6.3：sessions 的「全部服務」下拉來自 /api/overview 的 services（只放 hasAudit===true 的服務）。
  const overview = useResource(topics.overview, undefined)
  const serviceOptions = (overview.data?.services ?? []).filter(s => s.hasAudit)

  const sessions = useResource(topics.sessions, {
    service: service || undefined,
    identity: identity || undefined,
    days: Number(days),
  })

  /**
   * 「查詢」按鈕／identity 欄 Enter 一律要重查一次（sessions.md §4）。
   *
   * 結構性正確做法（同 EventsPage 的 runQuery，不靠競態）：`identity` 是傳給 `useResource` 的
   * params 的一部分，只要 `setIdentity` 真的改變了值，取資料 effect 就會因為 paramsKey 改變
   * 自動重建訂閱並立即打一次新參數的請求——不需要額外呼叫 `reload()`。只有 trim 後的新值與目前
   * 已提交的 `identity` **序列化後相等**（值沒變，但使用者仍按了查詢/Enter）時，才需要顯式
   * `reload()`；此時因為值沒變，既有訂閱閉包捕捉的參數本來就等於新參數，不存在新舊落差、
   * 不是靠時序決定正確性。
   */
  const runQuery = () => {
    const trimmed = identityInput.trim()
    const changed = trimmed !== identity
    setIdentity(trimmed)
    if (!changed) void sessions.reload()
  }

  const gapMin = sessions.data?.gapMin ?? 10

  const columns: Column<SessionRow>[] = [
    {
      key: 'identity',
      header: '使用者',
      render: s => <b style={{ color: 'var(--acc)' }}>{s.identity}</b>,
    },
    { key: 'service', header: '服務', render: s => s.service },
    { key: 'start', header: '開始', className: 'mono', render: s => fmt(s.start) },
    {
      key: 'end',
      header: '結束',
      className: 'mono',
      render: s => (
        <>
          {fmt(s.end)} <span className="mute">{ago(s.end)}</span>
        </>
      ),
    },
    { key: 'dur', header: '時長', className: 'mono', render: s => dur(s.start, s.end) },
    { key: 'count', header: '請求', className: 'mono', render: s => s.count },
    {
      key: 'errors',
      header: '錯誤',
      className: 'mono',
      cellClassName: s => (s.errors ? 'err' : undefined),
      render: s => s.errors,
    },
    { key: 'logins', header: '登入帳號', className: 'mono', render: s => s.logins.join(', ') },
    { key: 'ips', header: 'IP', className: 'mono mute', render: s => s.ips.join(', ') },
    {
      key: 'tools',
      header: 'tool 序列',
      className: 'tools',
      render: s =>
        s.tools.length ? (
          s.tools.map((t, i) => <span key={i}>{t}</span>)
        ) : (
          <span className="mute">（只有握手，未呼叫 tool）</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      render: s => (
        <a
          href={eventsPath({ service: s.service, identity: s.identity })}
          onClick={e => {
            e.preventDefault()
            navigate(eventsPath({ service: s.service, identity: s.identity }))
          }}
        >
          看事件
        </a>
      ),
    },
  ]

  return (
    <>
      <Toolbar>
        <select value={service} onChange={e => setService(e.target.value)}>
          <option value="">全部服務</option>
          {serviceOptions.map(s => (
            <option key={s.id} value={s.id}>{`${s.name} :${s.port}`}</option>
          ))}
        </select>
        <input
          placeholder="identity"
          value={identityInput}
          onChange={e => setIdentityInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') runQuery()
          }}
        />
        <select value={days} onChange={e => setDays(e.target.value)}>
          <option value="1">1 天</option>
          <option value="7">7 天</option>
          <option value="30">30 天</option>
          <option value="365">1 年</option>
        </select>
        <Button onClick={runQuery}>查詢</Button>
        <span className="mute">
          同一人連續請求間隔 &lt; <span>{gapMin}</span> 分鐘視為同一段 session；tool 欄為該段依序呼叫的工具
        </span>
      </Toolbar>

      <DataTable columns={columns} rows={sessions.data?.sessions ?? []} rowKey={(s, i) => `${s.service}-${s.identity}-${s.firstId}-${i}`} emptyText="無資料" maxHeight="80vh" />
    </>
  )
}
