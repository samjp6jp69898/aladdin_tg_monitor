// 「哪些同事 TG 已連接」——讀 tech-users.csv（已對映 tg_chat_id 的人＝已連接）
// 與 telegram-dispatcher 的未知 sender log（DM 過 bot 但還沒被 tg-chatid-sync
// 對映回 CSV 的人＝待處理）。純唯讀展示；實際比對信心與寫入 CSV 是
// tg-chatid-sync skill 的職責（obsidian/skills/tg-chatid-sync），這裡不重複
// 那套邏輯，避免兩邊漂移。

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const TECH_USERS_CSV = '/Users/user/aladdin/aladdin_ai/commands/create-mr/references/tech-users.csv'
const UNKNOWN_SENDERS_LOG = '/Users/user/aladdin/telegram-dispatcher/logs/unknown-senders.jsonl'
const TG_MAP_SCRIPT = '/Users/user/aladdin/aladdin_ai/scripts/tg-map-chatids.sh'
const TG_NOTIFY_SCRIPT = '/Users/user/aladdin/aladdin_ai/scripts/tg-notify.sh'

export type ConnectedUser = { name: string; email: string; chat_id: string }
export type PendingSender = { chat_id: string; first_name: string; last_name: string; username: string; last_ts: string }
export type TechUser = { name: string; email: string; chat_id: string }

function parseCsvRows(raw: string): Record<string, string>[] {
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return []
  const header = lines[0]!.split(',').map(h => h.trim())
  return lines.slice(1).map(line => {
    const cols = line.split(',')
    const row: Record<string, string> = {}
    header.forEach((key, i) => { row[key] = (cols[i] ?? '').trim() })
    return row
  })
}

function allRows(): TechUser[] {
  if (!existsSync(TECH_USERS_CSV)) return []
  return parseCsvRows(readFileSync(TECH_USERS_CSV, 'utf8'))
    .map(r => ({ name: r.notion_user_name ?? '', email: r.email ?? '', chat_id: r.tg_chat_id ?? '' }))
}

export function loadConnectedUsers(): ConnectedUser[] {
  return allRows().filter(u => u.chat_id.length > 0)
}

// 待處理列表要給使用者選「指定給哪個技術」的完整名單（不論目前有沒有 chat_id）。
export function loadAllTechUsers(): TechUser[] {
  return allRows()
}

// 待處理：unknown-senders.jsonl 裡「還沒出現在已連接名單」的 chat_id，同一
// chat_id 多筆訊息只留最後一筆（log 是逐訊息 append，後面的名稱較新）。
export function loadPendingSenders(): PendingSender[] {
  if (!existsSync(UNKNOWN_SENDERS_LOG)) return []
  const connectedIds = new Set(loadConnectedUsers().map(u => u.chat_id))
  const byId = new Map<string, PendingSender>()
  for (const line of readFileSync(UNKNOWN_SENDERS_LOG, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: any
    try { row = JSON.parse(trimmed) } catch { continue }
    const chatId = String(row.chat_id ?? '')
    if (!chatId || connectedIds.has(chatId)) continue
    byId.set(chatId, {
      chat_id: chatId,
      first_name: row.first_name ?? '',
      last_name: row.last_name ?? '',
      username: row.username ?? '',
      last_ts: row.ts ?? '',
    })
  }
  return [...byId.values()].sort((a, b) => (a.last_ts < b.last_ts ? 1 : -1))
}

// 待處理列表手動指定技術人員：直接複用 tg-map-chatids.sh --set（單一事實
// 來源，不在這裡重新實作寫 CSV 的邏輯），成功後照 /tg-chatid-sync 流程發一
// 則確認訊息給本人。
export function assignChatId(email: string, chatId: string, opts: { force?: boolean } = {}): { ok: boolean; result: string } {
  // 先查 first_name（確認訊息用）——一定要在 --set 之前查：--set 成功後這個
  // chat_id 就從「待處理」名單消失（loadPendingSenders 會濾掉已連接的），事
  // 後才查會查不到，訊息只能退回一個沒有意義的通用稱呼。
  const label = loadPendingSenders().find(p => p.chat_id === chatId)?.first_name || '你'
  const args = ['--set', email, chatId]
  if (opts.force) args.push('--force')
  let result: string
  try {
    result = execFileSync('bash', [TG_MAP_SCRIPT, ...args], { encoding: 'utf8', timeout: 15_000 }).trim()
  } catch (err: any) {
    result = `SET_ERR_EXEC: ${err?.message ?? err}`
  }
  const ok = result.startsWith('SET_OK')
  if (ok) {
    try {
      execFileSync('bash', [TG_NOTIFY_SCRIPT, '--email', email, '--text', `${label} 連結成功`], { encoding: 'utf8', timeout: 15_000 })
    } catch {
      // 確認訊息送失敗不影響 CSV 已經寫入這件事，UI 仍回報 ok。
    }
  }
  return { ok, result }
}

// 取消連接：複用 tg-map-chatids.sh --unset（清空 tg_chat_id，不刪除整列）。
export function unsetChatId(email: string): { ok: boolean; result: string } {
  let result: string
  try {
    result = execFileSync('bash', [TG_MAP_SCRIPT, '--unset', email], { encoding: 'utf8', timeout: 15_000 }).trim()
  } catch (err: any) {
    result = `UNSET_ERR_EXEC: ${err?.message ?? err}`
  }
  return { ok: result.startsWith('UNSET_OK') || result.startsWith('UNSET_NOOP'), result }
}

// 測試發送：複用 tg-notify.sh --email，不重新實作發送邏輯。
export function sendTestMessage(email: string, text: string): { ok: boolean; result: string } {
  let result: string
  try {
    result = execFileSync('bash', [TG_NOTIFY_SCRIPT, '--email', email, '--text', text], { encoding: 'utf8', timeout: 15_000 }).trim()
  } catch (err: any) {
    result = `TG_ERR_EXEC: ${err?.message ?? err}`
  }
  return { ok: result.startsWith('TG_SENT'), result }
}
