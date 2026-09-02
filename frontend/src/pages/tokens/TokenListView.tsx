import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postTokenGrantCreate, postTokenGrantResend, postTokenGrantRevoke } from '../../api/endpoints'
import type { TokenGrantsResponse, TokenPerson, TokenService } from '../../api/types'
import { Button, Card, DataTable, Toolbar } from '../../components/shared'
import { useAction } from '../../hooks'
import { tokensPath } from '../../lib/navigation'
import { ENV_LABELS, TKC_ENV_DEFAULT_CHECKED, TKC_ENV_ORDER, TK_MANAGED, TOKEN_ID_PATTERN } from './constants'

interface TokenListViewProps {
  data: TokenGrantsResponse
  reload: () => Promise<void>
}

/** 此人可被「重發/刪除全部」動到的環境：現有 grants 與 TK_MANAGED 的交集（index.html:487/499）。 */
function managedEnvsOf(person: TokenPerson): TokenService[] {
  return (Object.keys(person.grants) as TokenService[]).filter(s => TK_MANAGED.includes(s))
}

/**
 * Token 權限列表視圖：持有人表格 + 新增 token 表單。
 * 對應舊版 `#tk-list-view`（index.html:141-160）。
 */
export function TokenListView({ data, reload }: TokenListViewProps) {
  const navigate = useNavigate()
  const resendAction = useAction()
  const removeAction = useAction()
  const createAction = useAction()

  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [newEnvs, setNewEnvs] = useState<Set<TokenService>>(() => new Set(TKC_ENV_DEFAULT_CHECKED))

  async function openDetail(id: string) {
    // 對應舊版 openTokenDetail()：切視圖前先重打一次，確保進詳情頁看到的是最新資料。
    await reload()
    navigate(tokensPath(id))
  }

  async function resendKitFromList(person: TokenPerson) {
    const managed = managedEnvsOf(person)
    if (!managed.length) return // 對應 resendKit()：managed 為空且未帶 services 時直接 return，不彈窗
    const desc = `會重簽全部現有環境（${managed.join(', ')}）的 token——舊 token 立即失效，對方換到新 kit 前完全無法使用。`
    const r = await resendAction.run(() => postTokenGrantResend(person.id), {
      confirm: `確定要重發 ${person.id}（${person.display_name}）的 kit？\n\n${desc}\n新設定會發到 Landon 的 TG，由他轉交對方。`,
      onSettled: reload,
    })
    if (r) alert(r.ok ? `已重發。\n\n${r.message}` : `重發失敗：${r.message}`)
  }

  async function removeAllFromList(person: TokenPerson) {
    const managed = managedEnvsOf(person)
    if (!managed.length) return // 對應 removeAllTokens()：managed 為空時直接 return，不彈窗
    const r = await removeAction.run(() => postTokenGrantRevoke(person.id, managed), {
      confirm: `確定要刪除 ${person.id}（${person.display_name}）的全部 token？\n\n環境：${managed.join(', ')}\n立即生效、dist/${person.id}/ 會一併移除，此人將完全無法使用後台工具。`,
      onSettled: reload,
    })
    if (r) alert(r.ok ? `已刪除。\n\n${r.message}` : `刪除失敗：${r.message}`)
  }

  function toggleNewEnv(service: TokenService) {
    setNewEnvs(prev => {
      const next = new Set(prev)
      if (next.has(service)) next.delete(service)
      else next.add(service)
      return next
    })
  }

  async function handleCreate() {
    const id = newId.trim()
    const name = newName.trim()
    const services = TKC_ENV_ORDER.filter(s => newEnvs.has(s))
    // 前端校驗（無 confirm 前，不合格直接 alert 擋下、不打 API）：
    if (!TOKEN_ID_PATTERN.test(id)) {
      alert('id 格式不合法：小寫英數/連字號/底線，2-32 字，且以小寫字母開頭。')
      return
    }
    if (!name) {
      alert('請填 display_name。')
      return
    }
    if (!services.length) {
      alert('至少勾一個環境。')
      return
    }
    const r = await createAction.run(() => postTokenGrantCreate(id, name, services), {
      confirm: `確定要核發 ${id}（${name}）的新 kit？\n\n環境：${services.join(', ')}\nkit zip + 使用說明會發到 Landon 的 TG。`,
    })
    if (!r) return
    if (r.ok) {
      alert(`已核發並發送。\n\n${r.message}`)
      // 成功才清空欄位、重載；失敗欄位不清空、不重載（規格 §4-3）。
      setNewId('')
      setNewName('')
      await reload()
    } else {
      alert(`核發失敗：${r.message}`)
    }
  }

  return (
    <>
      {/* 對應舊版 index.html:142 `Token 持有人（<span id="tk-n">0</span> 人）`：計數包在
          獨立的 <span> 裡（而非整段字串插值），視覺 parity 已驗證需要這個 DOM 結構。 */}
      <Card
        title={
          <>
            Token 持有人（<span>{data.people.length}</span> 人）
          </>
        }
      >
        <DataTable
          rows={data.people}
          rowKey={p => p.id}
          emptyText="名冊為空"
          emptyMode="replace"
          columns={[
            {
              key: 'id',
              header: 'id',
              className: 'mono',
              render: p => <b style={{ color: 'var(--acc)' }}>{p.id}</b>,
            },
            { key: 'display_name', header: 'display_name', render: p => p.display_name },
            {
              key: 'actions',
              header: '操作',
              render: p => (
                <>
                  <Button onClick={() => openDetail(p.id)}>詳情</Button>{' '}
                  <Button variant="warn" disabled={resendAction.pending} onClick={() => resendKitFromList(p)}>
                    重發 token
                  </Button>{' '}
                  <Button variant="danger" disabled={removeAction.pending} onClick={() => removeAllFromList(p)}>
                    移除 token
                  </Button>
                </>
              ),
            },
          ]}
        />
      </Card>
      <div style={{ marginTop: 12 }}>
        <Card title="新增 token（核發新 kit）">
          <Toolbar>
            <input
              value={newId}
              onChange={e => setNewId(e.target.value)}
              placeholder="id（小寫英數/連字號/底線）"
              style={{ width: 230 }}
            />
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="display_name（顯示名）"
              style={{ width: 190 }}
            />
            {TKC_ENV_ORDER.map(s => (
              <label key={s}>
                <input type="checkbox" checked={newEnvs.has(s)} onChange={() => toggleNewEnv(s)} /> {ENV_LABELS[s]}
              </label>
            ))}
            <Button disabled={createAction.pending} onClick={handleCreate}>
              核發並發送到 Landon TG
            </Button>
          </Toolbar>
          <div className="mute" style={{ fontSize: 15 }}>
            依勾選環境核發：沒有的環境會新核發、已有的環境會重簽（舊 token 立即失效）。id
            已存在時也能用，等同補齊/重簽這次勾選的環境，不會動到沒勾的既有環境。設定會發到 Landon 的
            TG，由他轉交對方。
          </div>
        </Card>
      </div>
    </>
  )
}
