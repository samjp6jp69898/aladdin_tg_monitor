/**
 * 即時序列分頁（route: `#/events`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/events.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 這個檔案的路徑與 export 名稱是對路由的契約，**不可更名或搬移**。
 *
 * 關鍵行為（對應舊版 `evQuery`/`loadEvents`/`toggleEvDetail`，index.html:341-355）：
 * - `#ev-service`/`#ev-errors`/`#ev-tool-only` 一改就重查；`#ev-identity`/`#ev-q` 只有按 Enter
 *   才重查；`#ev-reload`（查詢鈕）永遠重查一次，不論欄位是否真的改變。
 * - `#ev-live` 沒有自己的 onchange 行為，純粹是背景輪詢（5 秒）要不要打 API 的旗標
 *   （見下方「`#ev-live` 如何控制輪詢」小節）。
 * - 一般查詢（含輪詢）永遠是「取代」：畫面只留最新一批 200 筆。「載入更早」是唯一的
 *   「累加」路徑，用 `before_id` 向舊資料翻頁，不影響上面的輪詢查詢與其參數。
 * - 本頁刻意不用 `ago()`、刻意沒有「無資料」文案（規格 §5）。
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchEvents } from '../api/endpoints'
import { topics } from '../api/topics'
import type { EventRow, EventsParams } from '../api/types'
import { Badge, Button, DataTable, KeyValueGrid, ResultBadge, Toolbar, type Column } from '../components/shared'
import { useAction, useResource } from '../hooks'
import { fmt } from '../lib/format'

interface FilterState {
  service: string
  identity: string
  q: string
  errorsOnly: boolean
  toolOnly: boolean
}

function toParams(f: FilterState): EventsParams {
  return {
    service: f.service || undefined,
    identity: f.identity.trim() || undefined,
    q: f.q.trim() || undefined,
    errors: f.errorsOnly ? '1' : undefined,
    toolOnly: f.toolOnly ? '1' : undefined,
    limit: 200,
  }
}

export function EventsPage() {
  const [sp] = useSearchParams()

  // 跨分頁跳轉預填（契約 §6.2，query 參數名稱與 lib/navigation.ts 的 EventsJumpFilters 一致）。
  const [service, setService] = useState(sp.get('service') ?? '')
  const [identity, setIdentity] = useState(sp.get('identity') ?? '')
  const [q, setQ] = useState(sp.get('q') ?? '')
  const [errorsOnly, setErrorsOnly] = useState(sp.get('errors') === '1')
  const [toolOnly, setToolOnly] = useState(sp.get('toolOnly') === '1')

  // `#ev-live`：預設勾選（自動更新）。純粹是輪詢旗標，見下方 useResource 的 autoRefresh。
  const [live, setLive] = useState(true)

  const [queryParams, setQueryParams] = useState<EventsParams>(() =>
    toParams({ service, identity, q, errorsOnly, toolOnly }),
  )

  // events / sessions 的服務下拉來自 /api/overview 的 services（契約 §6.3），只列 hasAudit===true。
  const overview = useResource(topics.overview, undefined)
  const serviceOptions = (overview.data?.services ?? []).filter(s => s.hasAudit)

  // 「即時序列」的主查詢：autoRefresh 由 #ev-live 控制（本頁唯一可被使用者關掉輪詢的分頁）。
  const resource = useResource(topics.events, queryParams, { autoRefresh: live })

  // 展開狀態存 React state，不受輪詢影響（契約 §8 全站原則）。
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  // 顯示中的列表；一般查詢（含輪詢）整批取代，「載入更早」累加。
  const [rows, setRows] = useState<EventRow[]>([])
  const [oldestId, setOldestId] = useState<number | null>(null)
  /** 新後端的 opaque 游標（`null` = 已到底、`undefined` = 尚不知道／舊後端）。 */
  const [cursor, setCursor] = useState<string | null | undefined>(undefined)
  const [reachedEnd, setReachedEnd] = useState(false)

  useEffect(() => {
    if (!resource.data) return
    setRows(resource.data.rows)
    if (resource.data.rows.length) setOldestId(resource.data.rows[resource.data.rows.length - 1].id)
    // 每次一般查詢（含篩選條件變動與輪詢）都會整批取代列表，所以分頁狀態必須跟著重設——
    // 沿用上一組條件的游標會讓「載入更早」接到另一個查詢的資料流。
    setCursor(resource.data.next_cursor)
    setReachedEnd(resource.data.next_cursor === null)
  }, [resource.data])

  /**
   * 對應舊版「不論值是否真的改變，觸發點就重查一次」。
   *
   * 結構性正確做法（不靠競態）：`useResource` 的取資料 effect 本來就是依 `paramsKey`
   * （`queryParams` 的序列化字串）判斷要不要重建訂閱，而重建訂閱一定會立即打一次新參數的請求
   * ——所以只要 `setQueryParams` 真的改變了值，重查這件事已經由該 effect 保證會發生，
   * 不需要（也不能）在這裡緊接著呼叫 `reload()`：`reload()` 打的是「呼叫當下」既有訂閱閉包捕捉
   * 的舊參數，此時 React 還沒重渲染、`queryParams` 尚未真的變成新值，會多打一次帶舊參數的請求。
   * 只有在新舊參數**序列化後相等**（值沒變、但使用者仍觸發了查詢鈕/Enter）時，才需要顯式
   * `reload()`——此時因為參數沒變，既有訂閱閉包捕捉的參數本來就等於新參數，不存在新舊落差，
   * 這個判斷本身是根據值比對而非時序，結果是確定的。
   */
  function runQuery(next: FilterState) {
    const nextParams = toParams(next)
    const changed = JSON.stringify(nextParams) !== JSON.stringify(queryParams)
    setQueryParams(nextParams)
    if (!changed) void resource.reload()
  }

  function handleEnterKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    runQuery({ service, identity, q, errorsOnly, toolOnly })
  }

  function toggleExpand(id: number) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 「載入更早」：append 模式，用 evOldest 當 before_id，直接呼叫具名端點函式（不透過會整批取代的
  // useResource——那支是輪詢/一般查詢專用，混用會讓 append 出來的資料被下一輪詢覆蓋掉）。
  const moreAction = useAction()
  async function loadMore() {
    await moreAction.run(async () => {
      // 新後端給 opaque `next_cursor` 就用它；舊後端不回該欄位（undefined），退回 before_id。
      // 兩條路並存是因為前端 build 產物一寫進 dist 就即時上線，而後端可能還沒部署——
      // 只走 cursor 會在新前端＋舊後端的組合下讓「載入更早」直接失效。
      const usingCursor = cursor != null
      if (!usingCursor && oldestId == null) return null
      const resp = await fetchEvents(
        usingCursor
          ? { ...queryParams, cursor: cursor!, limit: 200 }
          : { ...queryParams, before_id: oldestId!, limit: 200 },
      )
      setRows(prev => [...prev, ...resp.rows])
      if (resp.next_cursor !== undefined) {
        // 新後端：null 代表沒有更早的資料了，據此關掉按鈕並顯示已到底。
        setCursor(resp.next_cursor)
        setReachedEnd(resp.next_cursor === null)
      } else if (resp.rows.length) {
        // 舊後端路徑：維持原行為（0 筆時不更新 oldestId）。
        setOldestId(resp.rows[resp.rows.length - 1].id)
      }
      return resp
    })
  }

  const columns: Column<EventRow>[] = [
    { key: 'ts', header: '時間', className: 'mono', render: r => fmt(r.ts) },
    { key: 'service', header: '服務', render: r => r.service },
    {
      key: 'identity',
      header: '使用者',
      render: r => <b style={{ color: 'var(--acc)' }}>{r.identity || ''}</b>,
    },
    { key: 'tool', header: 'tool', className: 'mono', render: r => r.tool || '' },
    {
      key: 'result',
      header: '結果',
      render: r =>
        r.event === 'auth_failure' ? (
          <Badge variant="bad">{r.reason || ''}</Badge>
        ) : (
          <ResultBadge result={r.result} />
        ),
    },
    {
      key: 'duration',
      header: '耗時',
      className: 'mono',
      render: r => `${r.duration_ms ?? ''}${r.duration_ms != null ? 'ms' : ''}`,
    },
    {
      key: 'toggle',
      header: '',
      render: r => (
        <Button style={{ padding: '2px 8px' }} onClick={() => toggleExpand(r.id)}>
          {expandedIds.has(r.id) ? '▾' : '▸'}
        </Button>
      ),
    },
  ]

  return (
    <div>
      <Toolbar>
        <select
          value={service}
          onChange={e => {
            const v = e.target.value
            setService(v)
            runQuery({ service: v, identity, q, errorsOnly, toolOnly })
          }}
        >
          <option value="">全部服務</option>
          {serviceOptions.map(s => (
            <option key={s.id} value={s.id}>{`${s.name} :${s.port}`}</option>
          ))}
        </select>
        <input
          placeholder="identity（使用者）"
          value={identity}
          onChange={e => setIdentity(e.target.value)}
          onKeyDown={handleEnterKey}
        />
        <input
          placeholder="搜尋 tool / path / result / IP"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={handleEnterKey}
        />
        <label>
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={e => {
              const v = e.target.checked
              setErrorsOnly(v)
              runQuery({ service, identity, q, errorsOnly: v, toolOnly })
            }}
          />{' '}
          只看錯誤
        </label>
        <label>
          <input
            type="checkbox"
            checked={toolOnly}
            onChange={e => {
              const v = e.target.checked
              setToolOnly(v)
              runQuery({ service, identity, q, errorsOnly, toolOnly: v })
            }}
          />{' '}
          只看有呼叫 tool（隱藏 initialize/list 等握手雜訊）
        </label>
        <label>
          <input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> 自動更新
        </label>
        <Button onClick={() => runQuery({ service, identity, q, errorsOnly, toolOnly })}>查詢</Button>
        <span className="mute">顯示 {rows.length} 筆</span>
      </Toolbar>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={r => r.id}
        maxHeight="80vh"
        emptyMode="none"
        renderExpanded={r =>
          expandedIds.has(r.id) ? (
            <div style={{ padding: '4px 0 8px' }}>
              <KeyValueGrid
                rows={[
                  { label: '#', value: r.id },
                  {
                    label: '事件',
                    value: r.event === 'auth_failure' ? <Badge variant="bad">auth_failure</Badge> : <Badge>req</Badge>,
                  },
                  { label: 'method', value: r.method || '' },
                  { label: 'path', value: r.path || '' },
                  { label: 'IP', value: r.source_ip || '' },
                  { label: 'agrabah 帳號', value: r.agrabah_identifier || '' },
                ]}
              />
            </div>
          ) : null
        }
      />

      <div style={{ marginTop: 8 }}>
        <Toolbar>
          {/* 已到底只有新後端判斷得出來（next_cursor === null）；舊後端不回該欄位，
              reachedEnd 永遠 false，按鈕行為與原版完全一致（點了拿 0 筆、無提示）。 */}
          <Button disabled={moreAction.pending || reachedEnd} onClick={() => void loadMore()}>
            載入更早
          </Button>
          {reachedEnd && <span className="mute">已到底</span>}
        </Toolbar>
      </div>
    </div>
  )
}
