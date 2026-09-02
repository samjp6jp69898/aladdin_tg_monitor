/**
 * TG 已連接分頁（route: `#/tg-connected`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/tg-connected.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 單一表格頁：`GET /api/tg-users` 只取 `connected`（`tg-pending` 另外各自打一次同支端點，
 * 契約 §8-5 明訂不共用 cache）。subnav（Token 權限／TG 已連接／TG 待處理）由殼層
 * `ConnectLayout` 統一渲染，本頁不重畫。
 *
 * 規格 §5「狀態與邊界」：無 loading 骨架（await 期間畫面維持上次內容）、`GET /api/tg-users`
 * 失敗時舊版沒有任何 UI 提示（例外被 `refresh()` 外層 catch 吞掉，只留在 console）——
 * 所以這裡刻意不畫 loading / error 區塊，直接用 `data?.connected ?? []` 渲染。
 */
import { postTgUserTest, postTgUserUnset } from '../api/endpoints'
import type { ConnectedUser } from '../api/types'
import { topics } from '../api/topics'
import { Button, Card, DataTable, Toolbar } from '../components/shared'
import { useAction, useResource } from '../hooks'

export function TgConnectedPage() {
  const { data, reload } = useResource(topics.tgUsers, undefined)
  const testAction = useAction()
  const unsetAction = useAction()

  const connected = data?.connected ?? []

  // 舊版 testSendTgUser()（index.html:767-772）：prompt 取消（null）則不送出；
  // 成功/失敗都用 alert 呈現，不重新整理列表（此操作不改變連接狀態）。
  async function handleTestSend(email: string) {
    const text = window.prompt('要發送的測試訊息：', '這是一則來自 tg-monitor 的測試訊息')
    if (text === null) return
    const r = await testAction.run(() => postTgUserTest(email, text))
    if (r) window.alert(r.ok ? `已送出：${r.message}` : `送出失敗：${r.message}`)
  }

  // 舊版 unsetTgUser()（index.html:773-778）：成功不彈 alert，直接重新整理列表；
  // 失敗才 alert，且不重載。
  async function handleUnset(email: string, name: string) {
    const r = await unsetAction.run(() => postTgUserUnset(email), {
      confirm: `確定要取消 ${name}（${email}）的 Telegram 連接嗎？取消後這個人不會再收到 pipeline 通知，需要重新 DM bot 才能再連上。`,
    })
    if (!r) return
    if (r.ok) {
      reload()
    } else {
      window.alert(`取消失敗：${r.message}`)
    }
  }

  return (
    <>
      <Toolbar>
        <Button onClick={() => reload()}>重新整理</Button>
        <span className="mute">tech-users.csv 已回填 tg_chat_id 的人。</span>
      </Toolbar>
      {/* 對應舊版 index.html:245 `已連接（<span id="tuc-n">0</span>）`：計數包在獨立的
          <span> 裡（而非整段字串插值），視覺 parity 已驗證需要這個 DOM 結構。 */}
      <Card
        title={
          <>
            已連接（<span>{connected.length}</span>）
          </>
        }
      >
        <DataTable<ConnectedUser>
          rows={connected}
          rowKey={u => u.email}
          emptyText="尚無已連接的同事"
          emptyMode="replace"
          columns={[
            {
              key: 'name',
              header: '姓名',
              render: u => <b style={{ color: 'var(--acc)' }}>{u.name}</b>,
            },
            { key: 'email', header: 'email', className: 'mono', render: u => u.email },
            { key: 'chat_id', header: 'chat_id', className: 'mono', render: u => u.chat_id },
            {
              key: 'actions',
              render: u => (
                <>
                  <Button disabled={testAction.pending} onClick={() => handleTestSend(u.email)}>
                    測試發送
                  </Button>{' '}
                  <Button
                    variant="danger"
                    disabled={unsetAction.pending}
                    onClick={() => handleUnset(u.email, u.name)}
                  >
                    取消連接
                  </Button>
                </>
              ),
            },
          ]}
        />
      </Card>
    </>
  )
}
