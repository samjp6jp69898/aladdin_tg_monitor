// /api/events 分頁游標的編解碼測試（Reviewer B MAJOR-7a：本模組原本零測試覆蓋）。
//
// 每一組只注入一個故障（a7-D30），期望值寫在斷言旁邊。
import { describe, expect, test } from 'bun:test'
import { decodeEventsCursor, encodeEventsCursor } from './events-cursor.ts'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

describe('encodeEventsCursor / decodeEventsCursor', () => {
  test('往返還原 ts 與 id', () => {
    const row = { ts: '2026-09-02T03:24:10.182Z', id: 1738 }
    expect(decodeEventsCursor(encodeEventsCursor(row))).toEqual(row)
  })

  test('毫秒精度不損失（DATETIME(3) 的往返前提）', () => {
    for (const ms of ['000', '001', '999', '182']) {
      const row = { ts: `2026-09-02T03:24:10.${ms}Z`, id: 1 }
      expect(decodeEventsCursor(encodeEventsCursor(row))!.ts).toBe(row.ts)
    }
  })

  test('編碼結果是 opaque：只含 base64url 字元，看不出原文', () => {
    const c = encodeEventsCursor({ ts: '2026-09-02T03:24:10.182Z', id: 1738 })
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(c).not.toContain('2026')
  })

  test('id = 0 可往返（邊界：0 是合法 id，不得被當成假值）', () => {
    const row = { ts: '2026-01-01T00:00:00.000Z', id: 0 }
    expect(decodeEventsCursor(encodeEventsCursor(row))).toEqual(row)
  })

  test('編碼側遇到不可解析的 ts 會丟錯，不靜默產生垃圾游標', () => {
    expect(() => encodeEventsCursor({ ts: 'not-a-date', id: 1 })).toThrow()
  })

  // ── 以下每一格只注入一個故障，全部期望回 null（呼叫端據此回 400）──
  test('注入：不是 base64url → null', () => {
    expect(decodeEventsCursor('!!!not-base64!!!')).toBeNull()
  })
  test('注入：base64url 但內容不是 <ms>.<id> → null', () => {
    expect(decodeEventsCursor(b64('hello world'))).toBeNull()
  })
  test('注入：只有一個分量 → null', () => {
    expect(decodeEventsCursor(b64('1756789012345'))).toBeNull()
  })
  test('注入：分量含非數字 → null', () => {
    expect(decodeEventsCursor(b64('abc.123'))).toBeNull()
    expect(decodeEventsCursor(b64('123.abc'))).toBeNull()
  })
  test('注入：數值超出 safe integer → null', () => {
    expect(decodeEventsCursor(b64('99999999999999999999.1'))).toBeNull()
    expect(decodeEventsCursor(b64('1.99999999999999999999'))).toBeNull()
  })
  test('注入：空字串 → null', () => {
    expect(decodeEventsCursor('')).toBeNull()
  })
})
