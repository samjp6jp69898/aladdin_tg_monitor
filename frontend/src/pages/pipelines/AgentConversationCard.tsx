import { useEffect, useRef } from 'react'
import { ApiError } from '../../api/client'
import type { AgentTraceBlock, AgentTraceResponse } from '../../api/types'
import { Badge, Card, LogViewer, Toolbar } from '../../components/shared'
import type { Resource } from '../../hooks'
import { dur, fmt, fmtTok, hms } from '../../lib/format'

/**
 * Agent 對話檢視器（`#pd-conv-card`）。規格：migration/tabs/pipelines.md §3「Agent 對話檢視器」
 * 與互動點 9/10。**不快取，每次點列都重打**——由呼叫端（PipelineDetailView）決定要
 * `setAgentPath` 還是對同一個 path 直接 `reload()`，本元件只負責呈現。
 */
export function AgentConversationCard({
  path,
  resource,
}: {
  path: string | null
  resource: Resource<AgentTraceResponse>
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  // 渲染完捲到對話卡片（僅成功時；有錯誤時原地顯示錯誤標題，不捲動）。
  useEffect(() => {
    if (resource.data && !resource.error) {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [resource.data])

  // 尚未點過任何 agent 列：卡片不出現。
  if (!path) return null

  const data = resource.data
  const err = resource.error

  // 有錯誤時：標題顯示錯誤訊息，其餘欄位維持上一次成功內容不繼續渲染（原版行為，見 §5）。
  const title = err
    ? traceErrorMessage(err)
    : data
      ? `${data.meta.stage ?? ''}${data.meta.ticket ? ' · ' + data.meta.ticket : ''}`
      : ''

  return (
    <div ref={cardRef}>
      <Card className="pd-conv-card" title={title}>
        {data && (
          <>
            <Toolbar>
              {data.meta.startedAt && (
                <Badge>
                  {fmt(data.meta.startedAt)} → {data.meta.endedAt ? hms(data.meta.endedAt) : '…'}（
                  {dur(data.meta.startedAt, data.meta.endedAt)}）
                </Badge>
              )}
              {data.summary.model && <Badge>{data.summary.model}</Badge>}
              <Badge>turns {data.summary.num_turns ?? '-'}</Badge>
              <Badge>tool calls {data.summary.tool_calls}</Badge>
              <Badge>
                in {fmtTok(data.summary.input_tokens)} + cache{' '}
                {fmtTok((data.summary.cache_read_tokens || 0) + (data.summary.cache_create_tokens || 0))}
              </Badge>
              <Badge>out {fmtTok(data.summary.output_tokens)}</Badge>
              {data.meta.cwd && <Badge title="cwd">{data.meta.cwd}</Badge>}
              {data.meta.error !== undefined && data.meta.error !== null && (
                <Badge variant="bad">{errorMessage(data.meta.error) || 'error'}</Badge>
              )}
            </Toolbar>
            <details>
              <summary>Prompt（輸入給 agent 的完整提示）</summary>
              <LogViewer
                text={data.prompt ?? '（bug pipeline：prompt 為 /create-mr 指令，未另存）'}
                height="auto"
                maxHeight="40vh"
              />
            </details>
            <div style={{ marginTop: 12 }}>
              {data.turns.length > 0 ? (
                data.turns.map((t, i) => (
                  <div key={i} className={`turn ${t.role}`}>
                    <div className="role">
                      #{i + 1} {t.role === 'assistant' ? '🤖 assistant' : '👤 tool results'}
                      {t.ts ? ` · ${hms(t.ts)}` : ''}
                    </div>
                    {t.blocks.map((b, bi) => (
                      <BlockView key={bi} block={b} />
                    ))}
                  </div>
                ))
              ) : data.rawStdout ? (
                <LogViewer text={data.rawStdout} height="auto" maxHeight="40vh" />
              ) : (
                <div className="mute">沒有對話事件</div>
              )}
            </div>
            {data.result && (
              <div className="final" style={{ marginTop: 12 }}>
                <b>{data.result.is_error ? '❌ 最終結果（錯誤）' : '✅ 最終產出'}</b>{' '}
                <span className="mute">
                  · {data.result.subtype || ''} ·{' '}
                  {data.result.duration_ms ? `${(data.result.duration_ms / 1000).toFixed(1)}s` : ''}
                </span>
                <pre>{data.result.text || '（無文字）'}</pre>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}

// AgentTraceBlock 的最後一個聯集成員（未知 type 的攔截型別）帶 `[k: string]: unknown`
// 索引簽章，會讓 switch(block.type) 的窄化在存取具名欄位時退化成 unknown——用
// Extract<> 明確窄化到單一成員，取代直接的 switch 自動窄化。
function BlockView({ block }: { block: AgentTraceBlock }) {
  if (block.type === 'text') {
    const b = block as Extract<AgentTraceBlock, { type: 'text' }>
    return <pre>{b.text}</pre>
  }
  if (block.type === 'thinking') {
    const b = block as Extract<AgentTraceBlock, { type: 'thinking' }>
    return (
      <details>
        <summary>thinking</summary>
        <pre className="thinking">{b.text}</pre>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    const b = block as Extract<AgentTraceBlock, { type: 'tool_use' }>
    return (
      <details>
        <summary>🔧 {b.name}</summary>
        <pre>{JSON.stringify(b.input, null, 2)}</pre>
      </details>
    )
  }
  if (block.type === 'tool_result') {
    const b = block as Extract<AgentTraceBlock, { type: 'tool_result' }>
    return (
      <details className={`result ${b.is_error ? 'err' : ''}`}>
        <summary>
          {b.is_error ? '❌' : '↩'} tool_result{b.is_error ? '（錯誤）' : ''} · {(b.content || '').length} 字
        </summary>
        <pre>{b.content}</pre>
      </details>
    )
  }
  return <div className="mute">[{block.type}]</div>
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return ''
}

/** GET /api/agent-trace 錯誤訊息：get() 對非 2xx 一律拋 ApiError（含 404/500/403 三種情境）。 */
function traceErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | undefined
    if (body?.error) return body.error
    if (err.bodyText) return err.bodyText
  }
  return err instanceof Error ? err.message : String(err)
}
