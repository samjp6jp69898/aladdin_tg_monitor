/**
 * 總覽分頁「服務 / Port」卡片牆的單張服務卡。
 * 規格：migration/tabs/overview.md §3.2（欄位對應）、§3.2.1（使用者清單三態）。
 * 對應舊版 index.html:291-305 的 `#cards` map 區塊。
 */
import { Badge, Button, Card, KeyValueGrid, StatusDot } from '../../components/shared'
import type { OverviewService } from '../../api/types'
import { ago, upt } from '../../lib/format'

export interface ServiceCardProps {
  service: OverviewService
  onRestart: (id: string, name: string) => void
}

export function ServiceCard({ service: s, onRestart }: ServiceCardProps) {
  const p = s.probe
  const up = p?.status === 'up'

  return (
    <Card
      title={
        <>
          <StatusDot status={p?.status ?? null} />
          <span className="nm">{s.name}</span>
          <span style={{ marginLeft: 'auto' }}>
            <Badge variant={up ? 'ok' : 'bad'}>{up ? 'UP' : 'DOWN'}</Badge>
          </span>
          {s.launchdLabel && (
            <Button
              style={{ padding: '3px 10px', fontSize: '14px' }}
              title={`launchctl kickstart -k ${s.launchdLabel}`}
              onClick={() => onRestart(s.id, s.name)}
            >
              重啟
            </Button>
          )}
        </>
      }
    >
      <div className="tags">
        <Badge>port {s.port}</Badge>
        {s.proxyPrefix && <Badge>{s.proxyPrefix}</Badge>}
        {s.launchdLabel && (
          <Badge title="launchd label">{s.launchdLabel.replace('com.aladdin.', '')}</Badge>
        )}
      </div>

      <KeyValueGrid
        rows={[
          Boolean(p?.detail) && { label: '狀態', value: <span className={up ? 'ok' : 'err'}>{p?.detail}</span> },
          {
            label: 'PID / 延遲',
            value: `${p?.pid ?? '-'} / ${p?.latencyMs != null ? p.latencyMs + 'ms' : '-'}`,
          },
          {
            label: 'uptime',
            value: (
              <>
                {upt(p?.uptimeSeconds)}
                {s.lastStatusChange && (
                  <span className="mute">
                    {' '}
                    ({s.lastStatusChange.status} {ago(s.lastStatusChange.ts)})
                  </span>
                )}
              </>
            ),
          },
          s.hasAudit && {
            label: '請求 1h / 24h',
            value: (
              <>
                {s.req1h} / {s.req24h}{' '}
                <span className={s.err24h ? 'err' : 'mute'}>錯誤 {s.err24h}</span>
              </>
            ),
          },
          s.hasAudit && {
            label: '最後事件',
            value: s.lastEvent
              ? `${s.lastEvent.identity || '-'} ${s.lastEvent.tool || s.lastEvent.path || ''} ${ago(s.lastEvent.ts)}`
              : '-',
          },
          s.hasAudit && { label: '名冊人數', value: s.rosterSize },
        ]}
      />

      <div className="users">
        {!s.hasAudit ? (
          <div className="mute" style={{ fontSize: '12.5px' }}>
            （此服務無稽核 log，無法歸屬使用者）
          </div>
        ) : s.activeUsers.length === 0 ? (
          <div className="mute" style={{ fontSize: '12.5px' }}>
            目前無人使用
          </div>
        ) : (
          s.activeUsers.map((u, i) => (
            <div className="user" key={`${u.identity}-${i}`}>
              <span className="who">{u.identity}</span>
              <span className="meta">
                {u.n} req · {u.last_tool || ''} · {ago(u.last_ts)}
                {u.source_ip ? ` · ${u.source_ip}` : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}
