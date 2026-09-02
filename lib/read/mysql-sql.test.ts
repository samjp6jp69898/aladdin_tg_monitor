// mysql 讀取面的結構性測試。
//
// 這裡刻意**不連 DB**：連得到 DB 的對照是 scripts/compare-sqlite-mysql.ts 的事
// （那支要有資料才有意義）。本檔守的是「不必有資料就該成立」的那些性質：
// 形狀對映有沒有漏欄、SQL 片段的語意有沒有寫錯、只讀紀律與 pool 唯一性有沒有破。
//
// import lib/read/mysql.ts 本身零副作用（pool 是 getMonitorPool() 惰性建的），
// 所以就算 MON_DB_* 一個都沒設，本檔也跑得起來。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { AGENT_RUNS_SELECT, RUNS_SELECT, iso, jnum, jstr, toDatetimeParam } from './mysql.ts'

const MYSQL_SRC = readFileSync(new URL('./mysql.ts', import.meta.url).pathname, 'utf8')

describe('iso()：DATETIME(3) → 與 sqlite 同形的 ISO 字串', () => {
  const sql = iso('e.ts')

  test('不能用 %f——那是六位微秒，會產出 .751000Z 這種與 sqlite 不同形的字串', () => {
    expect(sql).not.toContain('%f')
  })

  test('毫秒是 FLOOR(MICROSECOND/1000) 再 LPAD 到三位', () => {
    expect(sql).toContain('LPAD(FLOOR(MICROSECOND(e.ts) / 1000), 3, ')
  })

  test('結尾是 Z（UTC），日期與時間之間是 T', () => {
    expect(sql).toContain("'%Y-%m-%dT%H:%i:%s.'")
    expect(sql).toContain("'Z'")
  })
})

describe('jstr() / jnum()：raw JSON 取值', () => {
  test('一律先 JSON_VALID 守門（raw 不是合法 JSON 時回 NULL，不讓端點 500）', () => {
    expect(jstr('e', 'tool')).toContain('IF(JSON_VALID(e.`raw`)')
    expect(jnum('e', 'durationMs')).toContain('IF(JSON_VALID(e.`raw`)')
  })

  test('用巢狀 IF 而不是 AND——MySQL 的 AND 不保證短路，raw 非法時不能去碰 JSON_EXTRACT', () => {
    const s = jstr('e', 'tool')
    expect(s).not.toMatch(/JSON_VALID\([^)]*\)\s+AND/)
    // 第一個 IF 的 then 分支本身又是一個 IF
    expect(s.indexOf('IF(', s.indexOf('IF(JSON_VALID') + 3)).toBeGreaterThan(0)
  })

  test('JSON 的 null 要變成 SQL NULL，不能變成字串 "null"', () => {
    expect(jstr('e', 'tool')).toContain("= 'NULL'")
  })

  test('jnum 只認真正的 JSON 數字（對齊 insertAuditLine 的 typeof === number）', () => {
    expect(jnum('e', 'durationMs')).toContain("IN ('INTEGER', 'DOUBLE', 'DECIMAL')")
  })

  test('alias 有帶進去——相關子查詢裡取的必須是 e2/e3 自己的 raw，不是外層的', () => {
    expect(jstr('e2', 'tool')).toContain('e2.`raw`')
    expect(jstr('e2', 'tool')).not.toContain('e.`raw`,')
  })
})

describe('toDatetimeParam()：使用者輸入的時間參數', () => {
  test('合法 UTC ISO → MySQL DATETIME(3) 字面值', () => {
    expect(toDatetimeParam('2026-08-26T03:23:44.751Z')).toBe('2026-08-26 03:23:44.751')
    expect(toDatetimeParam('2026-08-26T03:23:44Z')).toBe('2026-08-26 03:23:44.000')
  })

  test('不是合法 ISO 就原樣傳下去，不 throw（sqlite 那側對輸入也沒有驗證）', () => {
    expect(toDatetimeParam('2026-08-26')).toBe('2026-08-26')
    expect(toDatetimeParam('garbage')).toBe('garbage')
    expect(toDatetimeParam('')).toBe('')
  })
})

describe('形狀對映：runs → sqlite pipeline_runs', () => {
  // lib/db.ts 的 pipeline_runs 全欄（含三次 ALTER 補的欄位）
  const COLUMNS = [
    'key', 'kind', 'ticket', 'started_at', 'stdout_path', 'stderr_path',
    'finished_at', 'outcome', 'cancelled_at', 'triggered_by',
    'review_rounds', 'final_review_rounds',
  ]
  for (const col of COLUMNS) {
    test(`SELECT 有 ${col}`, () => {
      expect(RUNS_SELECT).toMatch(new RegExp(`AS \\\`?${col}\\\`?[,\\s]`))
    })
  }

  test('§8.1 允許的兩個可選欄位 host / run_id 也帶上', () => {
    expect(RUNS_SELECT).toContain('AS host')
    expect(RUNS_SELECT).toContain('AS run_id')
  })

  test('key 由 legacy_key 來、legacy_key 為空時退回 run_id', () => {
    expect(RUNS_SELECT).toContain('COALESCE(r.legacy_key, r.run_id)')
  })

  test('cancelled_at 對映到 cancel_requested_at', () => {
    expect(RUNS_SELECT).toContain('r.cancel_requested_at')
  })

  test('三個 schema 缺口欄位明確回 NULL（不是漏寫）', () => {
    for (const col of ['stderr_path', 'review_rounds', 'final_review_rounds']) {
      expect(RUNS_SELECT).toMatch(new RegExp(`NULL\\s+AS ${col}`))
    }
  })
})

describe('形狀對映：agent_runs', () => {
  const COLUMNS = [
    'path', 'ticket', 'kind', 'stage', 'started_at', 'ended_at', 'model',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_create_tokens',
    'cost_usd', 'num_turns', 'tool_calls', 'is_error', 'result_preview', 'file_mtime',
  ]
  for (const col of COLUMNS) {
    test(`SELECT 有 ${col}`, () => {
      expect(AGENT_RUNS_SELECT).toMatch(new RegExp(`AS ${col}[,\\s]`))
    })
  }

  test('stage 來自 agent_name（001 建表就是這一欄，回填也是這樣寫的）', () => {
    expect(AGENT_RUNS_SELECT).toContain('a.agent_name                    AS stage')
  })

  test('ticket / kind 走 run_id → runs 的 join，不反正規化', () => {
    expect(AGENT_RUNS_SELECT).toContain('JOIN runs r ON r.run_id = a.run_id')
    expect(AGENT_RUNS_SELECT).toContain('r.ticket                        AS ticket')
  })

  test('is_error 補 0（sqlite 那欄是 NOT NULL DEFAULT 0）', () => {
    expect(AGENT_RUNS_SELECT).toContain('COALESCE(a.is_error, 0)')
  })
})

describe('紀律', () => {
  test('mon_ui 讀取面**只讀**：整支檔案沒有任何寫入語句', () => {
    expect(MYSQL_SRC).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b/i)
  })

  test('【G:MN-G7】不自建 pool——全 repo 的 createPool 只能在 lib/mon-db.ts 那一處', () => {
    expect(MYSQL_SRC).not.toContain('createPool(')
    expect(MYSQL_SRC).toContain('getMonitorPool()')
  })

  test('讀取面查詢串成單一 FIFO 鏈，結構上最多佔用 1 條連線（pool 只有 4 條且 waitForConnections:false）', () => {
    expect(MYSQL_SRC).toContain('readChain')
  })

  test('使用者輸入的等值比較釘死 utf8mb4_bin（schema 預設 collation 大小寫不敏感，sqlite 的 = 不是）', () => {
    expect(MYSQL_SRC).toContain('e.service = ? COLLATE utf8mb4_bin')
    expect(MYSQL_SRC).toContain('e.identity = ? COLLATE utf8mb4_bin')
  })

  test('session 串接的 ORDER BY 也釘 utf8mb4_bin（不然同名不同大小寫會交錯、把一段 session 切碎）', () => {
    expect(MYSQL_SRC).toContain('ORDER BY e.service COLLATE utf8mb4_bin, e.identity COLLATE utf8mb4_bin, e.ts')
  })
})

describe('SSE handler 的踩坑禁令（lib/ingest.ts:99-103 未解除的那一條）', () => {
  const SERVER_SRC = readFileSync(new URL('../../server.ts', import.meta.url).pathname, 'utf8')
  const start = SERVER_SRC.indexOf("app.get('/api/stream'")
  const end = SERVER_SRC.indexOf('console.error(`tg-monitor ready', start)

  test('/api/stream handler 找得到（下面的斷言才有意義）', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
  })

  test('handler 內沒有任何同步 spawn', () => {
    const body = SERVER_SRC.slice(start, end)
    expect(body).not.toContain('spawnSync')
    expect(body).not.toContain('execFileSync')
    expect(body).not.toContain('execSync')
  })
})
