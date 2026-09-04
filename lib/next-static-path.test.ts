// lib/next-static-path.ts 的測試（Reviewer B MINOR-9）。
// 每一組只注入一個故障（a7-D30）。

import { describe, expect, test } from 'bun:test'
import { resolveNextStaticPath } from './next-static-path.ts'

const DIST = '/app/frontend/dist/'

describe('resolveNextStaticPath', () => {
  test('空路徑 → index.html', () => {
    expect(resolveNextStaticPath(DIST, '')).toBe('/app/frontend/dist/index.html')
  })

  test('一般巢狀路徑正常解析', () => {
    expect(resolveNextStaticPath(DIST, 'assets/app.js')).toBe('/app/frontend/dist/assets/app.js')
  })

  test('合法的百分號編碼路徑正常解析', () => {
    // %20 = 空格，合法序列
    expect(resolveNextStaticPath(DIST, 'a%20b.js')).toBe('/app/frontend/dist/a b.js')
  })

  // ── 注入：非法百分號序列（MINOR-9 本體）──────────────────────────────
  // decodeURIComponent('%E0%A4%A') 會 throw URIError：修好前這裡會讓整支測試
  // 也跟著丟錯（未被吃掉），修好後回 null。
  test('注入：非法百分號序列 → null（不 throw）', () => {
    expect(resolveNextStaticPath(DIST, '%E0%A4%A')).toBeNull()
  })
  test('注入：孤立的 % → null（不 throw）', () => {
    expect(resolveNextStaticPath(DIST, '100%')).toBeNull()
  })

  // ── 對照組：既有的目錄穿越防護維持有效 ─────────────────────────────
  test('對照組：目錄穿越（未編碼）→ null', () => {
    expect(resolveNextStaticPath(DIST, '../../../etc/passwd')).toBeNull()
  })
  test('對照組：目錄穿越（URL 編碼）→ null', () => {
    expect(resolveNextStaticPath(DIST, '..%2F..%2F..%2Fetc%2Fpasswd')).toBeNull()
  })
})
