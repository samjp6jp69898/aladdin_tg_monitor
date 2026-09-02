// /api/events 的分頁游標編解碼（a7-D46 裁定：opaque 字串）。
//
// **為什麼 opaque**：游標的內部結構不成為契約的一部分，客戶端無從自行構造、
// 也就無從依賴它的內部語意——日後改變內部編碼不會是破壞性變更。
// 這與「不讓呼叫端對被呼叫端的不變式供稿」是同一條原則。
//
// **為什麼兩軌可以用同一個游標**：內部帶 `(ts, id)` 兩個分量。
//   - mysql 軌用 row-value 比較 `(e.ts, e.id) < (?, ?)`，配合 `ORDER BY ts DESC, id DESC`。
//   - sqlite 軌**只取用 `id` 分量**，對應它既有的 `id < ?` 述詞——所以
//     `lib/read/sqlite.ts` 的 SQL **逐位元不變**，`sqlite-parity.test.ts` 不受影響。
//     那 30 條 SQL 守的是 `MON_READ_SOURCE=sqlite` 這唯一的回滾槓桿：一旦改動
//     sqlite 軌的行為，「退回 sqlite」就不再是退回一個已知且被驗證過的狀態。
//   客戶端不知道、也不需要知道哪一軌用了哪個分量——這正是 opaque 的價值兌現處。
//
// 編碼：`base64url("<epochMillis>.<id>")`。刻意不用 JSON：更短，且不誘使人去解讀。

export type EventsCursor = { ts: string; id: number }

export function encodeEventsCursor(row: { ts: string; id: number }): string {
  const ms = Date.parse(row.ts)
  if (Number.isNaN(ms)) throw new Error(`encodeEventsCursor: ts 無法解析：${row.ts}`)
  return Buffer.from(`${ms}.${row.id}`, 'utf8').toString('base64url')
}

/** 解不開就回 null——呼叫端負責決定要回 400 還是忽略（本專案選 400，見 server.ts）。 */
export function decodeEventsCursor(raw: string): EventsCursor | null {
  let text: string
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const m = /^(\d+)\.(\d+)$/.exec(text)
  if (!m) return null
  const ms = Number(m[1])
  const id = Number(m[2])
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(id)) return null
  return { ts: new Date(ms).toISOString(), id }
}
