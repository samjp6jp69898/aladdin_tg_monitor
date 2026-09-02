/**
 * TG 待處理分頁專屬的技術人員搜尋比對邏輯。
 *
 * 對應舊版 `public/index.html` L784（`techUserLabel`）與 L792-800
 * （`resolveTechUserEmail`）。刻意放在分頁底下、不進共用層
 * （契約 `02-frontend-contract.md` §5：「分頁專屬、不要放共用層」明確點名這兩個函式）。
 */
import type { TechUser } from '../../api/types'

/** 選項文字：「姓名 <email>」，已連接的人加註現有 chat_id。 */
export function techUserLabel(u: TechUser): string {
  return `${u.name} <${u.email}>${u.chat_id ? `（現有 chat_id：${u.chat_id}）` : ''}`
}

export interface ResolveTechUserResult {
  email: string
  reason?: string
}

/**
 * 輸入框內容 → email：先比完整選項文字，再比 email 全等，
 * 最後以姓名/email 子字串比對（僅唯一命中才採用）。
 */
export function resolveTechUserEmail(text: string, techUsers: TechUser[]): ResolveTechUserResult {
  const t = text.trim()
  if (!t) return { email: '' }

  const exact = techUsers.find(u => techUserLabel(u) === t || u.email === t)
  if (exact) return { email: exact.email }

  const q = t.toLowerCase()
  const hits = techUsers.filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
  if (hits.length === 1) return { email: hits[0].email }
  return {
    email: '',
    reason: hits.length
      ? `「${t}」符合 ${hits.length} 位技術人員，請從下拉清單選一位`
      : `找不到符合「${t}」的技術人員`,
  }
}
