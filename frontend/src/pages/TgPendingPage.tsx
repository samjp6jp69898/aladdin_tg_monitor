/**
 * TG 待處理分頁（route: `#/tg-pending`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/tg-pending.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * subnav（Token 權限／TG 已連接／TG 待處理）由殼層 `ConnectLayout` 統一渲染，本頁不重畫。
 *
 * 「輸入中的內容不被輪詢沖掉」：舊版每次輪詢都整個重建 `#tup-list` 的 DOM，靠重繪前掃描
 * `[id^="tup-sel-"]` 存值、重繪後寫回（`loadTgPending()` L808-809/811）補救。React 版不需要
 * 這個補救——每列輸入框的值本來就存在獨立於 `useResource` 資料的 `inputs` state
 * （key 是 `chat_id`），輪詢只換 `data`，不會去動 `inputs`，所以文字自然留著。
 */
import { useState } from 'react'
import type { PendingSender, TechUser } from '../api/types'
import { postTgUserAssign } from '../api/endpoints'
import { topics } from '../api/topics'
import { Button, Card, type Column, DataTable, Toolbar } from '../components/shared'
import { useAction, useResource } from '../hooks'
import { ago, fmt } from '../lib/format'
import { resolveTechUserEmail, techUserLabel } from './tg-pending/techUserResolve'

export function TgPendingPage() {
  // 輪詢守門：使用者正 focus 在任一列的搜尋輸入框（id 前綴 `tup-sel-`）時跳過本輪，
  // 對應舊版 isPickingTechUser()（L803）。手動按「重新整理」呼叫 reload() 不受此限。
  const { data, reload } = useResource(topics.tgUsers, undefined, {
    shouldPoll: () => !document.activeElement?.id?.startsWith('tup-sel-'),
  })

  // 每列輸入框的值，key 為 chat_id；輪詢重繪 `data` 不會清掉這裡的內容。
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const action = useAction()

  const pending: PendingSender[] = data?.pending ?? []
  const techUsers: TechUser[] = data?.techUsers ?? []

  async function assignTgUser(chatId: string, force = false) {
    const { email, reason } = resolveTechUserEmail(inputs[chatId] ?? '', techUsers)
    if (!email) {
      window.alert(reason || '請先選一位技術人員')
      return
    }
    const out = await action.run(() => postTgUserAssign({ chat_id: chatId, email, force }))
    if (!out) return
    if (out.ok) {
      window.alert(`指定成功：${out.message}`)
      await reload()
      return
    }
    if (
      out.message.startsWith('SET_CONFLICT') &&
      window.confirm(`${out.message}\n\n這位技術已經有不同的 chat_id，要覆蓋嗎？`)
    ) {
      await assignTgUser(chatId, true)
      return
    }
    window.alert(`指定失敗：${out.message}`)
  }

  const columns: Column<PendingSender>[] = [
    { key: 'chat_id', header: 'chat_id', className: 'mono', render: p => p.chat_id },
    {
      key: 'first_name',
      header: 'first_name',
      render: p => `${p.first_name ?? ''}${p.last_name ? ' ' + p.last_name : ''}`,
    },
    {
      key: 'username',
      header: 'username',
      className: 'mono',
      render: p => (p.username ? `@${p.username}` : ''),
    },
    {
      key: 'last_ts',
      header: '最後訊息',
      className: 'mono mute',
      render: p => (
        <>
          {fmt(p.last_ts)} <span className="mute">{ago(p.last_ts)}</span>
        </>
      ),
    },
    {
      key: 'assign',
      header: '指定技術人員',
      render: p => (
        <>
          <input
            list="tup-techusers"
            id={`tup-sel-${p.chat_id}`}
            placeholder="輸入姓名或 email 搜尋"
            style={{ minWidth: 260 }}
            autoComplete="off"
            value={inputs[p.chat_id] ?? ''}
            onChange={e => {
              const v = e.target.value
              setInputs(prev => ({ ...prev, [p.chat_id]: v }))
            }}
          />{' '}
          <Button disabled={action.pending} onClick={() => assignTgUser(p.chat_id)}>
            指定
          </Button>
        </>
      ),
    },
  ]

  return (
    <>
      <Toolbar>
        <Button onClick={() => reload()}>重新整理</Button>
        <span className="mute">
          DM 過 bot 但還沒對映回 CSV 的 chat_id。有人 DM 時會自動觸發 tg-auto-sync：高信心直接寫入，否則會通知維運者；這裡也可以直接手動指定。
        </span>
      </Toolbar>
      <Card
        title={
          <>
            待處理（<span>{pending.length}</span>）
          </>
        }
      >
        <DataTable
          columns={columns}
          rows={pending}
          rowKey={p => p.chat_id}
          emptyText="目前沒有待處理的新 DM"
          emptyMode="replace"
        />
        {pending.length > 0 && (
          <datalist id="tup-techusers">
            {techUsers.map(u => (
              <option key={u.email} value={techUserLabel(u)} />
            ))}
          </datalist>
        )}
      </Card>
    </>
  )
}
