// 「逐頁走完 ＝ 一次 FULL」的行為測試（Reviewer B MAJOR-7b：分頁在測試與擋門的
// 覆蓋率原本是零；C1c 只對同一個 query 的 ORDER BY 做斷言，從未行使游標）。
//
// **必須放在 import 清單第一行**（見 lib/test-tmp-db.ts 的說明），否則會開到
// 使用者真正的 data/monitor.sqlite。
import '../test-tmp-db.ts'
import { describe, expect, test } from 'bun:test'
import { db } from '../db.ts'
import { sqliteReader } from './sqlite.ts'

// fixture 刻意包含 reviewer 點名的兩種形狀：
//   (1) 同一個 ts 有多列 —— MCP 一次 tool 呼叫會產生多個 request，落在同一毫秒常見
//   (2) id 序 ≠ ts 序 —— sqlite 的 events 由多檔 tail 掃描插入，插入順序不是時間序
//       （實測 live 資料有 333 處相鄰對違反 ts 遞減，那是既有行為不是 bug）
const FIXTURES: { ts: string; tag: string }[] = [
  { ts: '2026-09-01T10:00:00.000Z', tag: 'a' },
  { ts: '2026-09-01T10:00:00.000Z', tag: 'b' }, // 同 ts
  { ts: '2026-09-01T10:00:00.000Z', tag: 'c' }, // 同 ts
  { ts: '2026-08-20T09:00:00.000Z', tag: 'old-inserted-late' }, // id 大但 ts 舊
  { ts: '2026-09-01T11:00:00.000Z', tag: 'd' },
  { ts: '2026-08-25T09:00:00.000Z', tag: 'old2' }, // 同上
  { ts: '2026-09-01T12:00:00.000Z', tag: 'e' },
]

// 縱深防禦（2026-09-03 踩過一次）：即使 import 順序又出問題，也絕不寫進 live DB。
// 靠「別的檔案有沒有記得先 import test-tmp-db」來保護 live 資料太脆弱——
// 那是一個沒有守衛的約定，而約定會被下一個新增測試檔的人漏掉。
const DB_FILE = (db as any).filename ?? process.env.TG_MONITOR_DB ?? ''
if (!/tg-monitor-test-db-|[\\/]tmp[\\/]|[\\/]var[\\/]folders[\\/]/.test(DB_FILE)) {
  throw new Error(
    `events-paging.test.ts 拒絕執行：sqlite 路徑不是暫存檔而是 ${DB_FILE}。\n` +
      '成因是 import 順序——有測試檔在 test-tmp-db.ts 之前就載入了 lib/db.ts。\n' +
      '請確認每個（直接或間接）import ./db.ts 的測試檔都把 test-tmp-db 放在第一行。',
  )
}

const SERVICE = 'paging-fixture' 
const stmt = db.prepare(
  `INSERT INTO events (service, ts, event, identity, source_ip, method, path, tool, result,
                       agrabah_identifier, duration_ms, reason, raw)
   VALUES (?, ?, 'request', 'tester', '127.0.0.1', 'POST', '/x', 'tool-x', 'ok', NULL, 1, NULL, ?)`,
)
for (const f of FIXTURES) stmt.run(SERVICE, f.ts, `raw-${f.tag}`)

const base = { service: SERVICE, errorsOnly: false, toolOnly: false } as any

describe('sqlite 軌 /api/events 分頁', () => {
  test('逐頁走完 ＝ 一次 FULL：無重複、無遺漏、順序一致', async () => {
    const full = (await sqliteReader.queryEvents({ ...base, limit: 1000 })) as any
    expect(full.length).toBe(FIXTURES.length)

    const PAGE = 2
    const seen: any[] = []
    let beforeId: number | undefined
    let guard = 0
    for (;;) {
      const page = (await sqliteReader.queryEvents({ ...base, limit: PAGE, beforeId })) as any
      seen.push(...page)
      if (page.length < PAGE) break
      beforeId = page[page.length - 1].id
      if (++guard > 50) throw new Error('分頁未收斂')
    }

    // 三個性質分開斷言，任一格失敗都能單獨歸因
    expect(seen.map((r: any) => r.id)).toEqual(full.map((r: any) => r.id)) // 順序一致
    expect(new Set(seen.map((r: any) => r.id)).size).toBe(seen.length) // 無重複
    expect(seen.length).toBe(full.length) // 無遺漏
  })

  test('同一個 ts 有多列時仍不重複不遺漏（sqlite 以 id 破平手）', async () => {
    const sameTs = ((await sqliteReader.queryEvents({ ...base, limit: 1000 })) as any).filter(
      (r: any) => r.ts === '2026-09-01T10:00:00.000Z',
    )
    expect(sameTs.length).toBe(3) // fixture 裡確實有三列同 ts，否則這個測試沒在測它宣稱的東西
    const ids = sameTs.map((r: any) => r.id)
    expect(new Set(ids).size).toBe(3)
  })

  test('sqlite 軌的回傳順序是 id DESC（既有語意，a7 裁定不改）', async () => {
    const rows = (await sqliteReader.queryEvents({ ...base, limit: 1000 })) as any
    for (let i = 1; i < rows.length; i++) expect(rows[i].id).toBeLessThan(rows[i - 1].id)
  })

  test('fixture 確實含「id 序 ≠ ts 序」，否則上一格只是碰巧成立', async () => {
    const rows = (await sqliteReader.queryEvents({ ...base, limit: 1000 })) as any
    const inversions = rows.filter((r: any, i: number) => i > 0 && Date.parse(r.ts) > Date.parse(rows[i - 1].ts))
    expect(inversions.length).toBeGreaterThan(0)
  })
})
