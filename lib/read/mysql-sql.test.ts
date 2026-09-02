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
import { AGENT_RUNS_SELECT, RUNS_SELECT, exact, iso, jnum, jstr, likeable, limitClause, toDatetimeParam, tsCompare } from './mysql.ts'

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

  test('jnum 用 AS DOUBLE 不是 AS SIGNED（sqlite 是動態型別，12.7 存進去就是 12.7，不會截成 12）', () => {
    expect(jnum('e', 'durationMs')).toContain('AS DOUBLE')
    expect(jnum('e', 'durationMs')).not.toContain('AS SIGNED')
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

  test('migration 004 之後三欄讀真欄位，不再是硬寫 NULL', () => {
    // 落地前這三欄在 runs 表根本不存在，只能 `NULL AS ...`；004（2026-09-02 套用）
    // 補上後就該讀真的。**值**仍可能是 NULL（rounds 兩欄的寫入端還沒接），
    // 那是可接受的降級，與這條斷言無關。
    for (const col of ['stderr_path', 'review_rounds', 'final_review_rounds']) {
      expect(RUNS_SELECT).toContain(`r.${col}`)
      expect(RUNS_SELECT).not.toMatch(new RegExp(`NULL\\s+AS ${col}`))
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

  test('session 串接的 ORDER BY 也釘 utf8mb4_bin（不然同名不同大小寫會交錯、把一段 session 切碎）', () => {
    expect(MYSQL_SRC).toContain('ORDER BY e.service COLLATE utf8mb4_bin, e.identity COLLATE utf8mb4_bin, e.ts')
  })

  test('讀取面查詢有 I/O 期限與佇列上限（一條卡死的查詢不得堵死整條鏈）', () => {
    expect(MYSQL_SRC).toContain('READ_QUERY_TIMEOUT_MS')
    expect(MYSQL_SRC).toContain('READ_QUEUE_MAX')
  })
})

describe('collation：兩個方向都必須釘死（本輪對抗審查抓到的 BLOCKER）', () => {
  test('exact()＝utf8mb4_bin，likeable()＝utf8mb4_0900_ai_ci', () => {
    expect(exact('e.service')).toBe('e.service COLLATE utf8mb4_bin')
    expect(likeable('x')).toBe('(x) COLLATE utf8mb4_0900_ai_ci')
  })

  test('每一個進 LIKE 的 JSON 取值都包了 likeable()', () => {
    // JSON_UNQUOTE 的結果 collation 是 utf8mb4_bin（實測），而 sqlite 的 LIKE
    // 對 ASCII 大小寫不敏感 —— 不校正會讓 /api/events?q=Admin 靜默回 0 筆。
    // 掃全檔：任何 `... LIKE` 的左運算元只要含 JSON_EXTRACT，就必須先過 likeable。
    const likeOperands = [...MYSQL_SRC.matchAll(/\$\{([^}]*(?:jstr|source_ip)[^}]*)\}\s*LIKE/g)].map(m => m[1])
    expect(likeOperands.length).toBeGreaterThan(0)
    for (const op of likeOperands) expect(op).toContain('likeable(')
  })

  test('等值／分組一律走 exact()，檔案裡不該再有裸寫的 COLLATE utf8mb4_bin 等值片段', () => {
    expect(MYSQL_SRC).not.toContain("= ? COLLATE utf8mb4_bin'")
    expect(MYSQL_SRC).toContain("exact('e.service')")
    expect(MYSQL_SRC).toContain("exact('e.identity')")
  })
})

describe('與 sqlite 的退化輸入語意對齊（本輪對抗審查抓到的 MAJOR）', () => {
  test('limit 為負數 → 不加 LIMIT（sqlite 把負數 LIMIT 當不限筆數）', () => {
    expect(limitClause(-1)).toBe('')
  })

  test('limit 為 NaN → 丟錯（對齊 sqlite 綁定 NaN 時的 datatype mismatch → HTTP 500）', () => {
    expect(() => limitClause(Number('abc'))).toThrow()
  })

  test('limit 正常值 → 一般 LIMIT 片段', () => {
    expect(limitClause(300)).toBe(' LIMIT 300')
  })

  test('合法 ISO 的時間比較走 DATETIME（吃得到索引）', () => {
    const c = tsCompare('e.ts', '>=', '2026-08-26T03:23:44.751Z')
    expect(c.frag).toBe('e.ts >= ?')
    expect(c.param).toBe('2026-08-26 03:23:44.751')
  })

  test('垃圾輸入退化成字典序字串比較（sqlite 的 ts 是文字欄，to=garbage 會命中全部）', () => {
    const c = tsCompare('e.ts', '<=', 'garbage')
    expect(c.frag).toContain('DATE_FORMAT')
    expect(c.frag.endsWith('<= ?')).toBe(true)
    expect(c.param).toBe('garbage')
  })
})

describe('同步 spawn 禁令（lib/ingest.ts:113-117，未解除的那一條）', () => {
  // 對抗審查指出：只掃 `/api/stream` handler 的字面字串等於沒守門——真正的風險
  // 全在**傳遞層**（有人把 readTrackerStatusAsync 改回同步版、或在某個
  // build*Payload() 鏈上加一支會 spawn 的函式，字面掃描照樣全綠）。
  // 這裡改守兩件更硬的事：
  //   (1) server.ts **整支**不得出現任何同步 spawn；
  //   (2) server.ts 不得 import lib/ingest.ts 的同步版 readTrackerStatus。
  // 這兩條擋得住上面那兩個具體的回歸路徑。剩下「別人的函式內部偷偷 spawn」
  // 這一類，靠 scripts/verify-stream.ts 的實跑（8 條硬斷後 server 必須存活）兜底。
  const SERVER_SRC = readFileSync(new URL('../../server.ts', import.meta.url).pathname, 'utf8')

  // 比對的是「呼叫形狀」（識別字後面緊接左括號），不是單純的字串出現——
  // 檔案裡本來就有幾處註解在**講**這條禁令（例如「非同步版本（execFile 非
  // execFileSync）」），那些不該讓測試變紅。
  const SYNC_SPAWN_CALL = /\b(spawnSync|execFileSync|execSync)\s*\(/

  test('server.ts 整支沒有任何同步 spawn 呼叫', () => {
    expect(SERVER_SRC).not.toMatch(SYNC_SPAWN_CALL)
  })

  test('server.ts 只 import 非同步的 execFile', () => {
    expect(SERVER_SRC).toContain("import { execFile } from 'node:child_process'")
  })

  test('server.ts 用的是 readTrackerStatusAsync，不是同步版 readTrackerStatus', () => {
    expect(SERVER_SRC).toContain('readTrackerStatusAsync')
    expect(SERVER_SRC).not.toMatch(/\breadTrackerStatus\b(?!Async)/)
  })

  test('/api/stream handler 存在且 handler 內同樣乾淨', () => {
    const start = SERVER_SRC.indexOf("app.get('/api/stream'")
    const end = SERVER_SRC.indexOf("app.get('/api/read-source'", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const body = SERVER_SRC.slice(start, end)
    expect(body).not.toMatch(SYNC_SPAWN_CALL)
  })

  test('SSE 失敗語意：連續失敗要讓串流以錯誤收場，不能只送被 EventSource 忽略的註解列', () => {
    expect(SERVER_SRC).toContain('SSE_MAX_CONSECUTIVE_FAILURES')
    expect(SERVER_SRC).toContain('controller.error(')
  })

  test('SSE 有背壓檢查與連線數上限', () => {
    expect(SERVER_SRC).toContain('controller.desiredSize')
    expect(SERVER_SRC).toContain('SSE_MAX_CONNECTIONS')
  })
})
