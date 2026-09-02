import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  postTokenGrantAdd,
  postTokenGrantRename,
  postTokenGrantResend,
  postTokenGrantRevoke,
} from '../../api/endpoints'
import type { TokenGrantsResponse, TokenPerson, TokenService } from '../../api/types'
import { Badge, Button, Card, DataTable, Toolbar } from '../../components/shared'
import { useAction } from '../../hooks'
import { ago, fmt } from '../../lib/format'
import { tokensPath } from '../../lib/navigation'
import { ENV_LABELS, TKD_ENV_ORDER, TK_MANAGED } from './constants'

interface TokenDetailViewProps {
  data: TokenGrantsResponse
  person: TokenPerson
  reload: () => Promise<void>
}

/**
 * Token 權限詳情視圖：單人環境權限表 + 依勾選重發。
 * 對應舊版 `#tk-detail`（index.html:161-180）。
 */
export function TokenDetailView({ data, person, reload }: TokenDetailViewProps) {
  const navigate = useNavigate()

  const renameAction = useAction()
  const addAction = useAction()
  const revokeAction = useAction()
  const resendAction = useAction()
  const removeAction = useAction()

  // ── 契約 §8 第 3 條：手動勾選狀態存 React state，不被輪詢沖掉 ──────────────
  // 只有「切換到不同的人」時才把 checkedEnvs 重新播種成該人目前的權限；
  // 同一個人身上、後續每 5 秒的輪詢刷新（person.grants 內容變動）完全不動這份 state。
  // 對應舊版 index.html:440 `document.querySelectorAll('.tkd-env').forEach(cb => cb.checked = !!p.grants[cb.value])`
  // 每次 loadTokenDetail() 都會跑一次、把使用者手動勾選沖掉的副作用——新版刻意不重現。
  const [checkedEnvs, setCheckedEnvs] = useState<Set<TokenService>>(
    () => new Set(Object.keys(person.grants) as TokenService[]),
  )
  const seededForId = useRef(person.id)
  useEffect(() => {
    if (seededForId.current !== person.id) {
      setCheckedEnvs(new Set(Object.keys(person.grants) as TokenService[]))
      seededForId.current = person.id
    }
  }, [person.id, person.grants])

  function toggleEnv(service: TokenService) {
    setCheckedEnvs(prev => {
      const next = new Set(prev)
      if (next.has(service)) next.delete(service)
      else next.add(service)
      return next
    })
  }

  async function handleBack() {
    // 對應舊版 closeTokenDetail()：切回列表前先重打一次。
    await reload()
    navigate(tokensPath())
  }

  async function handleRename() {
    const input = window.prompt(`${person.id} 的新 display_name：`, person.display_name)
    if (input === null) return // 取消整個中止
    const name = input.trim()
    if (!name) {
      alert('display_name 不能為空。')
      return
    }
    if (name === person.display_name) return // 與原名相同，靜默 return，不打 API
    const r = await renameAction.run(() => postTokenGrantRename(person.id, name), { onSettled: reload })
    if (r) alert(r.ok ? `已改名。\n\n${r.message}` : `改名失敗：${r.message}`)
  }

  async function handleAddGrant(service: TokenService) {
    const note =
      service === 'toolsmith'
        ? '設定片段（含 token）會以 TG 訊息發到 Landon，由他一對一轉交本人。'
        : `會重建 dist/${person.id}/（既有環境的 token 不變）。對方要拿到更新後的 kit 才用得到，可用「重發 token」或 TG /kit 重發 zip。`
    const r = await addAction.run(() => postTokenGrantAdd(person.id, service), {
      confirm: `確定要為 ${person.id} 簽發「${service}」的新 token？\n\n${note}`,
      onSettled: reload,
    })
    if (r) alert(r.ok ? `已簽發。\n\n${r.message}` : `簽發失敗：${r.message}`)
  }

  async function handleRevokeGrant(service: TokenService) {
    const r = await revokeAction.run(() => postTokenGrantRevoke(person.id, [service]), {
      confirm: `確定要移除 ${person.id} 在「${service}」的 token？\n\n立即生效，對方這個環境下一個 request 起 401。`,
      onSettled: reload,
    })
    if (r) alert(r.ok ? `已移除。\n\n${r.message}` : `移除失敗：${r.message}`)
  }

  async function handleResendChecked() {
    const services = TKD_ENV_ORDER.filter(s => checkedEnvs.has(s))
    if (!services.length) {
      alert('至少勾一個環境。') // 未進 resendKit()，不彈 confirm
      return
    }
    const desc = `依勾選的環境（${services.join(', ')}）核發/重簽——沒有的環境會新核發，已有的環境會重簽（舊 token 立即失效），沒勾的環境不動。`
    const r = await resendAction.run(() => postTokenGrantResend(person.id, services), {
      confirm: `確定要重發 ${person.id}（${person.display_name}）的 kit？\n\n${desc}\n新設定會發到 Landon 的 TG，由他轉交對方。`,
      onSettled: reload,
    })
    if (r) alert(r.ok ? `已重發。\n\n${r.message}` : `重發失敗：${r.message}`)
  }

  async function handleRemoveAll() {
    const managed = (Object.keys(person.grants) as TokenService[]).filter(s => TK_MANAGED.includes(s))
    if (!managed.length) return
    const r = await removeAction.run(() => postTokenGrantRevoke(person.id, managed), {
      confirm: `確定要刪除 ${person.id}（${person.display_name}）的全部 token？\n\n環境：${managed.join(', ')}\n立即生效、dist/${person.id}/ 會一併移除，此人將完全無法使用後台工具。`,
      onSettled: reload,
    })
    if (r) alert(r.ok ? `已刪除。\n\n${r.message}` : `刪除失敗：${r.message}`)
  }

  return (
    <>
      <Toolbar>
        <Button onClick={handleBack}>← 返回列表</Button>
        <span style={{ fontSize: 20, fontWeight: 600 }}>
          {person.id}（{person.display_name}）
        </span>
        <span className="mute">{Object.keys(person.grants).length} 個環境</span>
        <Button disabled={renameAction.pending} onClick={handleRename}>
          改名
        </Button>
      </Toolbar>
      <Card title="環境權限">
        <DataTable
          rows={data.services}
          rowKey={s => s.id}
          emptyText="尚無環境資料"
          columns={[
            { key: 'name', header: '環境', render: s => s.name },
            {
              key: 'status',
              header: '狀態',
              render: s => (person.grants[s.id] ? <Badge variant="ok">有權限</Badge> : <span className="mute">—</span>),
            },
            {
              key: 'issued',
              header: '核發時間',
              className: 'mono mute',
              render: s => (person.grants[s.id] ? fmt(person.grants[s.id].issued_at) : ''),
            },
            {
              key: 'usage',
              header: '使用',
              className: 'mono mute',
              render: s => {
                const g = person.grants[s.id]
                if (!g) return ''
                return g.n ? `${g.n} 次 · ${ago(g.last_ts)}` : '未使用過'
              },
            },
            {
              key: 'actions',
              header: '操作',
              render: s =>
                person.grants[s.id] ? (
                  <Button
                    variant="danger"
                    disabled={revokeAction.pending}
                    onClick={() => handleRevokeGrant(s.id as TokenService)}
                  >
                    移除
                  </Button>
                ) : (
                  <Button disabled={addAction.pending} onClick={() => handleAddGrant(s.id as TokenService)}>
                    簽發
                  </Button>
                ),
            },
          ]}
        />
        <div className="mute" style={{ marginTop: 10, fontSize: 15 }}>
          「移除」與「刪除全部」立即生效（名冊 fail-closed、每個 request 現讀檔案）。「簽發」kit
          環境會產生新 token 並重建 dist/&lt;id&gt;/（既有環境的 token 不動，對方要拿到更新後的 kit
          才用得到）；toolsmith 的簽發/重簽則是把設定片段（含 token）以 TG 訊息發到 Landon 轉交。
        </div>
        <div style={{ marginTop: 12 }}>
          <Toolbar>
            <span className="mute" style={{ fontSize: 15 }}>
              依勾選重發：
            </span>
            {TKD_ENV_ORDER.map(s => (
              <label key={s}>
                <input type="checkbox" checked={checkedEnvs.has(s)} onChange={() => toggleEnv(s)} />{' '}
                {ENV_LABELS[s]}
              </label>
            ))}
          </Toolbar>
        </div>
        <div className="mute" style={{ fontSize: 15 }}>
          勾選的環境：沒有的會新核發、已有的會重簽（舊 token 立即失效）；沒勾的環境不動、不會自動撤銷。
        </div>
        <div style={{ marginTop: 12 }}>
          <Toolbar>
            <Button variant="warn" disabled={resendAction.pending} onClick={handleResendChecked}>
              依勾選重發 token（新 kit 發到 Landon TG）
            </Button>
            <Button variant="danger" disabled={removeAction.pending} onClick={handleRemoveAll}>
              刪除此人全部 token
            </Button>
          </Toolbar>
        </div>
      </Card>
    </>
  )
}
