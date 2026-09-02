/**
 * Toolsmith 展開列（`#ts-d-{requestId}`）。規格：migration/tabs/toolsmith.md §1、§3「詳情列」。
 *
 * 展開狀態本身由 `ToolsmithPage` 用 React state 管理（契約 §8-2）——本元件只負責純呈現，
 * 是否掛載完全由呼叫端的 `DataTable.renderExpanded` 決定。
 */
import type { ToolsmithRun } from '../../api/types'
import { Badge, KeyValueGrid } from '../../components/shared'
import { tsGateSymbol, tsGateVariant } from './format'

export function ToolsmithDetail({ run }: { run: ToolsmithRun }) {
  return (
    // 對應舊版 index.html 展開列的 `<div class="kv" style="padding:4px 0 8px">`。
    <div style={{ padding: '4px 0 8px' }}>
      <KeyValueGrid
        rows={[
          {
            key: 'notes',
            label: 'notes',
            value: run.notes ? run.notes : <span className="mute">（無）</span>,
          },
          {
            key: 'request',
            label: '完整需求',
            value: <span style={{ whiteSpace: 'pre-wrap' }}>{run.request}</span>,
          },
          run.pendingQuestions && {
            key: 'pending',
            label: '待回答問題',
            value: (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {run.pendingQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            ),
          },
          {
            key: 'gates',
            label: '部署關卡',
            value: run.gates ? (
              run.gates.map(g => (
                <Badge key={g.key} variant={tsGateVariant(g.status)} title={g.label} style={{ marginRight: 4 }}>
                  {g.key}
                  {tsGateSymbol(g.status)}
                </Badge>
              ))
            ) : (
              <span className="mute">（部署尚未開始）</span>
            ),
          },
          run.finalResult && {
            key: 'finalResult',
            label: '終局結果',
            value: (
              <>
                <Badge variant={run.finalResult.success ? 'ok' : 'bad'}>
                  {run.finalResult.success ? 'success' : 'failed'}
                </Badge>{' '}
                {run.finalResult.stage || run.finalResult.errorKind || ''} — {run.finalResult.message}
              </>
            ),
          },
        ]}
      />
    </div>
  )
}
