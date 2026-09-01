// Telegram webhook 狀態：唯讀查 Bot API getWebhookInfo，給總覽頁一張卡片用。
// 2026-08-25 新增——當天排查 GGhotss /bug 無回應與 tunnel 500 時，這個狀態
// 完全要手動 curl 才看得到，補進總覽省掉下次再手動查一輪。
//
// 內建快取（REFRESH_MS）：/api/overview 每 5 秒被前端輪詢一次，getWebhookInfo
// 沒有那麼即時的必要，快取避免對 Telegram API 灌爆。

import { readFileSync } from 'node:fs'

// TG_DISPATCH_BOT_TOKEN 唯一來源（2026-09-01 起，根目錄 .env 已退役）。
const ENV_FILE = '/Users/user/aladdin/telegram-dispatcher/.env'
const REFRESH_MS = 30_000

export type WebhookStatus = {
  ok: boolean
  url: string | null
  pendingUpdateCount: number | null
  lastErrorDate: string | null // ISO；Telegram 只在「錯過的送達」才更新這欄，修好後不會自動清空，只是不再變化
  lastErrorMessage: string | null
  ipAddress: string | null
  maxConnections: number | null
  error: string | null // 查詢本身失敗的原因（讀不到 token / API 打不通等）
  checkedAt: string
}

function readBotToken(): string | null {
  try {
    const raw = readFileSync(ENV_FILE, 'utf8')
    for (const line of raw.split('\n')) {
      if (line.startsWith('TG_DISPATCH_BOT_TOKEN=')) {
        return line.slice('TG_DISPATCH_BOT_TOKEN='.length).trim().replace(/^['"]|['"]$/g, '')
      }
    }
  } catch {}
  return null
}

let cache: WebhookStatus | null = null

async function fetchFresh(): Promise<WebhookStatus> {
  const checkedAt = new Date().toISOString()
  const token = readBotToken()
  if (!token) return { ok: false, url: null, pendingUpdateCount: null, lastErrorDate: null, lastErrorMessage: null, ipAddress: null, maxConnections: null, error: 'TG_DISPATCH_BOT_TOKEN 讀不到', checkedAt }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: AbortSignal.timeout(5000) })
    const j: any = await res.json()
    if (!j?.ok) return { ok: false, url: null, pendingUpdateCount: null, lastErrorDate: null, lastErrorMessage: null, ipAddress: null, maxConnections: null, error: j?.description ?? `HTTP ${res.status}`, checkedAt }
    const r = j.result ?? {}
    return {
      ok: true,
      url: r.url || null,
      pendingUpdateCount: typeof r.pending_update_count === 'number' ? r.pending_update_count : null,
      lastErrorDate: typeof r.last_error_date === 'number' ? new Date(r.last_error_date * 1000).toISOString() : null,
      lastErrorMessage: r.last_error_message ?? null,
      ipAddress: r.ip_address ?? null,
      maxConnections: typeof r.max_connections === 'number' ? r.max_connections : null,
      error: null,
      checkedAt,
    }
  } catch (err: any) {
    return { ok: false, url: null, pendingUpdateCount: null, lastErrorDate: null, lastErrorMessage: null, ipAddress: null, maxConnections: null, error: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err), checkedAt }
  }
}

/** 帶內建快取的查詢；供 /api/overview 直接呼叫，不需要外部排程。 */
export async function getWebhookStatus(): Promise<WebhookStatus> {
  if (cache && Date.now() - Date.parse(cache.checkedAt) < REFRESH_MS) return cache
  cache = await fetchFresh()
  return cache
}
