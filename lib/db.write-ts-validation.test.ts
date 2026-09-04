// lib/db.ts-write-ts-validation.test.ts — insertAuditLine 寫入前驗證 ts（Reviewer B MINOR-6）。
//
// 背景：encodeEventsCursor（lib/events-cursor.ts）在 ts 無法解析時**故意** throw
// （見 events-cursor.test.ts:33-35，鎖死「編碼側遇到不可解析的 ts 會丟錯，不
// 靜默產生垃圾游標」的設計意圖）。真正的洞不在那裡，而在寫入端：collector
// 解析出來的原始 ts 值若本身就不合法，不該原樣存進 sqlite，否則分頁在讀到
// 這筆髒資料時會讓 encodeEventsCursor 炸掉。這裡驗證寫入端已經堵住這個洞：
// 非法 ts 不會被原樣存進 events.ts 欄位。
//
// 依 db.ts 檔頭結構性守衛的要求：import 到 db.ts 的測試檔必須先 import
// test-tmp-db.ts，把 sqlite 導向暫存路徑，否則會直接 throw。
import './test-tmp-db.ts'
import { describe, expect, test } from 'bun:test'
import { db, insertAuditLine } from './db.ts'

describe('insertAuditLine — 寫入前驗證 ts（MINOR-6：源頭堵住，不在下游吞錯）', () => {
  test('ts 無法解析時，不會把非法值原樣存進 sqlite；改存合法 fallback', () => {
    const service = `minor6-invalid-${Date.now()}`
    const raw = JSON.stringify({ ts: 'not-a-date', event: 'request' })
    const ok = insertAuditLine(service, raw)
    expect(ok).toBe(true)

    const row = db.prepare('SELECT ts FROM events WHERE service = ?').get(service) as { ts: string }
    // 存進去的 ts 不是原始壞值
    expect(row.ts).not.toBe('not-a-date')
    // 存進去的 ts 必須是可解析的合法時間字串（否則下游 encodeEventsCursor 會炸）
    expect(Number.isNaN(Date.parse(row.ts))).toBe(false)
  })

  test('ts 可解析時，原樣存進 sqlite（不誤傷正常路徑）', () => {
    const service = `minor6-valid-${Date.now()}`
    const validTs = '2026-09-02T03:24:10.182Z'
    const raw = JSON.stringify({ ts: validTs, event: 'request' })
    const ok = insertAuditLine(service, raw)
    expect(ok).toBe(true)

    const row = db.prepare('SELECT ts FROM events WHERE service = ?').get(service) as { ts: string }
    expect(row.ts).toBe(validTs)
  })
})
