// 「sqlite 模式 byte-level 不變」的結構性關卡。
//
// 硬驗收是「MON_READ_SOURCE 未設 / sqlite 時全部端點行為 byte-level 不變」。
// 那件事有兩根支柱：
//   (1) 回應組裝邏輯完全留在 server.ts（兩個資料源共用同一份），
//   (2) **sqlite 這一側的每一條 SQL 都是從改動前的 server.ts 逐字搬過來的**。
//
// 本檔守的是 (2)：下面每一條字串都是 **commit f3dbe92 的 server.ts**
// （Phase 8 讀取層落地前的最後一版）裡逐字複製出來的，必須原樣出現在
// lib/read/sqlite.ts 內。任何人改動 lib/read/sqlite.ts 的 SQL 都會讓這裡變紅——
// 那正是意圖：sqlite 這一側不是拿來重構的，要改行為請改 server.ts 的組裝層。
//
// **刻意的偏離**（誠實記錄，不要以為是漏的）：
//   1. `/api/pipelines` 的 `... ORDER BY started_at DESC LIMIT 300` 在這裡是
//      `LIMIT ?`、由呼叫端傳 300 進來——reader 介面把筆數當參數是必要的（mysql
//      那側同款）。除了這個 `300` → `?`，其餘每一個字元都一樣；`/api/pipelines`
//      的實際回應在改動前後逐位元組比對過（22 個端點變體全綠）。
//   2. `sessions` 的 `ORDER BY service, identity, ts` 在這裡多了一個 `, id`
//      （Reviewer B MINOR-1，2026-09-04）：同一毫秒內的多列（MCP 一次 tool
//      呼叫常見）在 `ts` 之後順序未定義，讓 `/api/sessions` 回應的 `tools[]`
//      順序不穩定——這是行為修正，不是重構，比照 a7-D51 的原則：改動 sqlite
//      軌需要明確理由，且 parity 測試要繼續反映真實 SQL、不能被繞過（本檔的
//      baseline 字串已同步更新為含 `, id` 的版本，不是刪掉那條測試）。
//
// （為什麼把期望值寫死在測試裡而不是 `git show f3dbe92:server.ts`：測試不該
// 依賴 git 歷史還在不在、也不該在 worktree／淺 clone 下失效。寫死的代價是
// 這份字串要人工核對一次——落地時已用腳本對 `git show f3dbe92:server.ts`
// 逐條驗過 30 條全部命中，之後 review 這個檔案時請一併重看。）

// **必須是第一個 import**：本檔 import './sqlite.ts'（→ '../db.ts'），而 db.ts 在
// import 當下就依 TG_MONITOR_DB 開檔。多檔同行程跑 bun test 時，誰先載入 db.ts
// 誰就決定了 DB_PATH——本檔原本沒有這一行，於是它會先把 db.ts 綁到使用者真正的
// data/monitor.sqlite，讓同批其他測試檔的 test-tmp-db 失效（2026-09-03 實際發生：
// events-paging.test.ts 的 7 筆 fixture 寫進了 live monitor.sqlite）。
// 這正是 lib/test-tmp-db.ts 檔頭那條規則要防的事，而本檔違反了它。
import '../test-tmp-db.ts'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sqliteReader } from './sqlite.ts'
import { mysqlReader } from './mysql.ts'

const SQLITE_SRC = readFileSync(new URL('./sqlite.ts', import.meta.url).pathname, 'utf8')

/** commit f3dbe92 的 server.ts 內、所有直接對 sqlite 下的 SQL（逐字）。 */
const BASELINE_SQL: [string, string][] = [
  [
    'activeUsersStmt（server.ts:66-73）',
    `
  SELECT identity, COUNT(*) AS n, MAX(ts) AS last_ts, MIN(ts) AS first_ts,
         (SELECT tool FROM events e2 WHERE e2.service = e.service AND e2.identity = e.identity AND e2.tool IS NOT NULL ORDER BY ts DESC LIMIT 1) AS last_tool,
         (SELECT source_ip FROM events e3 WHERE e3.service = e.service AND e3.identity = e.identity ORDER BY ts DESC LIMIT 1) AS source_ip
  FROM events e
  WHERE service = ? AND ts >= ? AND identity IS NOT NULL
  GROUP BY identity ORDER BY last_ts DESC
`,
  ],
  ['countSinceStmt', `SELECT COUNT(*) AS n FROM events WHERE service = ? AND ts >= ?`],
  ['errSinceStmt', `SELECT COUNT(*) AS n FROM events WHERE service = ? AND ts >= ? AND (event = 'auth_failure' OR result LIKE 'error:%')`],
  ['lastEventStmt', `SELECT ts, identity, tool, path, result FROM events WHERE service = ? ORDER BY ts DESC LIMIT 1`],
  ['lastStatusChangeStmt', `SELECT ts, status FROM status_log WHERE service = ? ORDER BY id DESC LIMIT 1`],
  // /api/events 的動態 WHERE 片段（逐條）
  ['events.service', `where.push('service = ?')`],
  ['events.identity', `where.push('identity = ?')`],
  ['events.from', `where.push('ts >= ?')`],
  ['events.to', `where.push('ts <= ?')`],
  ['events.event', `where.push('event = ?')`],
  ['events.errors', `where.push("(event = 'auth_failure' OR result LIKE 'error:%')")`],
  ['events.toolOnly', `where.push('tool IS NOT NULL')`],
  ['events.q', `where.push('(tool LIKE ? OR path LIKE ? OR result LIKE ? OR source_ip LIKE ? OR agrabah_identifier LIKE ?)')`],
  ['events.before_id', `where.push('id < ?')`],
  [
    'events 主 SELECT',
    `SELECT id, service, ts, event, identity, source_ip, method, path, tool, result, agrabah_identifier, duration_ms, reason
               FROM events \${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
  ],
  [
    'sessions',
    `SELECT id, service, ts, identity, tool, path, result, source_ip, agrabah_identifier FROM events WHERE \${where.join(' AND ')} ORDER BY service, identity, ts, id`,
  ],
  ['stats.perDay', `SELECT substr(ts, 1, 10) AS day, service, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY day, service ORDER BY day`],
  ['stats.perHour', `SELECT substr(ts, 1, 13) AS hour, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY hour ORDER BY hour`],
  [
    'stats.topIdentities',
    `SELECT identity, service, COUNT(*) AS n, MAX(ts) AS last_ts FROM events WHERE ts >= ? AND identity IS NOT NULL GROUP BY identity, service ORDER BY last_ts DESC LIMIT 50`,
  ],
  [
    'stats.topTools',
    `SELECT tool, service, COUNT(*) AS n, SUM(CASE WHEN result LIKE 'error:%' THEN 1 ELSE 0 END) AS errors, ROUND(AVG(duration_ms)) AS avg_ms FROM events WHERE ts >= ? AND tool IS NOT NULL GROUP BY tool, service ORDER BY n DESC LIMIT 50`,
  ],
  [
    'stats.authFailures',
    `SELECT service, source_ip, reason, COUNT(*) AS n, MAX(ts) AS last_ts FROM events WHERE ts >= ? AND event = 'auth_failure' GROUP BY service, source_ip, reason ORDER BY n DESC LIMIT 50`,
  ],
  ['stats.total', `SELECT COUNT(*) AS n FROM events`],
  ['status-log（有 service）', `SELECT * FROM status_log WHERE service = ? ORDER BY id DESC LIMIT 200`],
  ['status-log（全部）', `SELECT * FROM status_log ORDER BY id DESC LIMIT 200`],
  ['attachAgentRuns 的 agent_runs', `SELECT * FROM agent_runs ORDER BY started_at`],
  ['pipelines 列表', `SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT `],
  ['pipelines/run 單筆', `SELECT * FROM pipeline_runs WHERE key = ?`],
  ['pipelines/run 同票', `SELECT * FROM pipeline_runs WHERE kind = ? AND ticket = ?`],
  [
    'retry 的最近一筆 bug run',
    `SELECT key FROM pipeline_runs WHERE kind = 'bug' AND ticket = ? ORDER BY started_at DESC LIMIT 1`,
  ],
  [
    'token-grants 的用量彙總',
    `SELECT identity, service, MAX(ts) AS last_ts, COUNT(*) AS n FROM events WHERE identity IS NOT NULL AND event = 'request' GROUP BY identity, service`,
  ],
]

describe('sqlite 讀取面與改動前的 server.ts 逐字一致', () => {
  for (const [label, sql] of BASELINE_SQL) {
    test(label, () => {
      expect(SQLITE_SRC).toContain(sql)
    })
  }
})

describe('兩個 reader 實作同一個介面', () => {
  test('方法集合完全相同（少一個就會在 mysql 模式執行期才炸）', () => {
    const a = Object.keys(sqliteReader).sort()
    const b = Object.keys(mysqlReader).sort()
    expect(b).toEqual(a)
  })

  test('source 欄位各自標明自己是誰', () => {
    expect(sqliteReader.source).toBe('sqlite')
    expect(mysqlReader.source).toBe('mysql')
  })
})

describe('server.ts 不再直接碰 sqlite', () => {
  const SERVER_SRC = readFileSync(new URL('../../server.ts', import.meta.url).pathname, 'utf8')

  test('沒有 db.prepare（所有 SQL 都在 lib/read/ 底下）', () => {
    expect(SERVER_SRC).not.toContain('db.prepare')
  })

  test('沒有從 lib/db.ts import db', () => {
    expect(SERVER_SRC).not.toMatch(/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*'\.\/lib\/db\.ts'/)
  })
})
