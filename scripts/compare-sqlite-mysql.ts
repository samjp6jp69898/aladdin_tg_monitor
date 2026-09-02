// scripts/compare-sqlite-mysql.ts — 讀取面雙軌對照（plan-db-as-truth-v3.md §10.2）。
//
//   cd /Users/user/aladdin/tg-monitor && bun run scripts/compare-sqlite-mysql.ts
//   （加 --verbose 印出每一筆差異的細節；預設只印摘要與前幾筆）
//
// 做什麼：把 lib/read/sqlite.ts 與 lib/read/mysql.ts **兩個 reader 在同一個行程裡**
// 對同一組查詢各跑一次，逐欄比對。之所以比 reader 而不是比 HTTP 端點：回應組裝
// 邏輯（server.ts 的 build*Payload）兩個模式共用同一份，只要 reader 交出的列一致，
// 端點回應就一致——比 reader 才定位得到「是哪一欄、哪一列不一樣」。
//
// 唯讀：本腳本只跑 SELECT，不寫 sqlite、不寫 MySQL、不動任何檔案。
//
// 退出碼：0＝全部一致；1＝有差異；2＝連不上監控 DB（環境沒設好，不算對照失敗）。
//
// ⚠️ 兩軌的資料**本來就可能不一致**（回填尚未跑完、collector 還沒遷移、
// MON_DB_ENABLED 還關著）。這支腳本回報的是「現況差多少」，不是「程式有沒有 bug」——
// 判讀時請一併看每一節印出的兩軌列數。

import { sqliteReader } from '../lib/read/sqlite.ts'
import type { MonitorReader } from '../lib/read/types.ts'
import { SERVICES } from '../lib/services.ts'

const verbose = process.argv.includes('--verbose')

let mysqlReader: MonitorReader
try {
  const m = await import('../lib/read/mysql.ts')
  await m.probeMysqlReadable()
  mysqlReader = m.mysqlReader
} catch (e) {
  console.error(`連不上監控 DB：${e instanceof Error ? e.message : String(e)}`)
  console.error('（tg-monitor/.env 的 MON_DB_* 要設好；本腳本必須在 tg-monitor 目錄下跑，Bun 才會載入該 .env）')
  process.exit(2)
}

let sections = 0
let mismatched = 0

/** 逐列逐欄比對兩個陣列；key 用來說明「這是哪一列」。 */
function compare(name: string, a: any[], b: any[], keyOf: (r: any) => string, ignore: string[] = []) {
  sections++
  const ma = new Map(a.map(r => [keyOf(r), r]))
  const mb = new Map(b.map(r => [keyOf(r), r]))
  const onlyA: string[] = []
  const onlyB: string[] = []
  const diffs: string[] = []
  for (const [k, ra] of ma) {
    const rb = mb.get(k)
    if (!rb) { onlyA.push(k); continue }
    // 兩邊 key 的聯集，不是只看 sqlite 的——只看 sqlite 的話，mysql 側多長出來的
    // 欄位永遠不會被回報（形狀驗收就漏了一半）。
    for (const col of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      if (ignore.includes(col)) continue
      const va = ra[col]
      const vb = rb[col]
      if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) {
        diffs.push(`${k} .${col}: sqlite=${JSON.stringify(va)} mysql=${JSON.stringify(vb)}`)
      }
    }
  }
  for (const k of mb.keys()) if (!ma.has(k)) onlyB.push(k)

  const bad = onlyA.length + onlyB.length + diffs.length
  if (bad > 0) mismatched++
  const head = bad === 0 ? 'OK  ' : 'DIFF'
  console.log(`${head} ${name.padEnd(28)} sqlite=${a.length} mysql=${b.length}` +
    (bad ? `  只在 sqlite=${onlyA.length} 只在 mysql=${onlyB.length} 欄位差異=${diffs.length}` : ''))
  if (bad && !verbose) {
    for (const k of onlyA.slice(0, 3)) console.log(`       只在 sqlite: ${k}`)
    for (const k of onlyB.slice(0, 3)) console.log(`       只在 mysql : ${k}`)
    for (const d of diffs.slice(0, 5)) console.log(`       ${d}`)
    if (onlyA.length + onlyB.length + diffs.length > 11) console.log('       …（--verbose 看全部）')
  } else if (bad && verbose) {
    for (const k of onlyA) console.log(`       只在 sqlite: ${k}`)
    for (const k of onlyB) console.log(`       只在 mysql : ${k}`)
    for (const d of diffs) console.log(`       ${d}`)
  }
}

/** 從列上拿掉指定欄位（比對前用）。 */
function strip(rows: any[], drop: string[]): any[] {
  if (drop.length === 0) return rows
  return rows.map(r => {
    const o: any = {}
    for (const k of Object.keys(r)) if (!drop.includes(k)) o[k] = r[k]
    return o
  })
}

/**
 * 順序也要一致的比對（session 串接、stats 的 ORDER BY 都吃順序）。
 *
 * `drop` 用來排掉「兩軌本來就不可能相同」的欄位，目前只有一個：**`id`**。
 * sqlite 的 `events.id` 與監控 DB 的 `mcp_usage.id` 是兩個各自獨立的
 * AUTOINCREMENT，回填時的插入順序不同 ⇒ 同一筆事件在兩邊的 id 必然不同。
 * 這不是缺陷：id 對外只是 `before_id` 分頁的不透明游標，同一軌內自洽即可
 * （實測 mcp_usage 的 id 與 ts 幾乎同序，1738 列只有 8 個倒退，與 sqlite
 * 逐服務分批匯入造成的倒退同一個量級）。
 */
function compareOrdered(name: string, a0: any[], b0: any[], drop: string[] = []) {
  sections++
  const a = strip(a0, drop)
  const b = strip(b0, drop)
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  const same = sa === sb
  if (!same) mismatched++
  console.log(`${same ? 'OK  ' : 'DIFF'} ${name.padEnd(28)} sqlite=${a.length} mysql=${b.length}`)
  if (!same) {
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      if (sa[i] !== sb[i]) {
        console.log(`       首個差異 @${i}\n         sqlite: ${sa.slice(Math.max(0, i - 60), i + 120)}\n         mysql : ${sb.slice(Math.max(0, i - 60), i + 120)}`)
        break
      }
    }
  }
}

/**
 * 集合比對（順序不計）。給 `ORDER BY n DESC LIMIT 50` 這種**同分列順序未定義**
 * 的結果用：sqlite 與 MySQL 對並列的列各自有各自的先後，那不是差異。
 * 內容集合本身仍然必須一模一樣。
 */
function compareSet(name: string, a: any[], b: any[]) {
  const key = (r: any) => JSON.stringify(r)
  const sa = a.map(key).sort()
  const sb = b.map(key).sort()
  sections++
  const same = JSON.stringify(sa) === JSON.stringify(sb)
  if (!same) mismatched++
  console.log(`${same ? 'OK  ' : 'DIFF'} ${name.padEnd(28)} sqlite=${a.length} mysql=${b.length}（順序不計）`)
  if (!same) {
    const setB = new Set(sb)
    const setA = new Set(sa)
    for (const x of sa.filter(x => !setB.has(x)).slice(0, verbose ? 999 : 5)) console.log(`       只在 sqlite: ${x}`)
    for (const x of sb.filter(x => !setA.has(x)).slice(0, verbose ? 999 : 5)) console.log(`       只在 mysql : ${x}`)
  }
}

/** 對照時一律取全量（server.ts 的 Math.min(limit,1000) 是端點層的事，不在 reader）。 */
const FULL = 1_000_000

// migration 004（2026-09-02 套用）已把 stderr_path / review_rounds /
// final_review_rounds 三欄補進 runs，讀取面改讀真欄位，所以 stderr_path 進入正常
// 對照。rounds 兩欄的**寫入端還沒接**（排在 health-monitor 批之後），mysql 側目前
// 一律是 NULL，留在忽略清單裡避免刷屏；寫入端接上後這個陣列要清空。
const RUNS_KNOWN_GAPS = ['review_rounds', 'final_review_rounds']

const now = Date.now()
const days30 = new Date(now - 30 * 86400_000).toISOString()
const days7 = new Date(now - 7 * 86400_000).toISOString()
const day1 = new Date(now - 86400_000).toISOString()

console.log('=== 讀取面雙軌對照（sqlite ↔ mysql）===\n')

// ── events ────────────────────────────────────────────────────────────────
// limit 一律開到全量。**不要用 1000 對照**：兩軌的 id 是各自獨立的
// AUTOINCREMENT，`ORDER BY id DESC LIMIT 1000` 在兩邊會切在資料集的不同位置，
// 比出來的「只在 sqlite / 只在 mysql」全是視窗邊界，不是資料差異。
// `q=` 的大小寫案例是本輪對抗審查抓到的 BLOCKER 的**回歸案例**：
// `JSON_UNQUOTE(JSON_EXTRACT(...))` 的 collation 是 utf8mb4_bin，而 sqlite 的 LIKE
// 對 ASCII 大小寫不敏感——沒有 likeable() 校正的話，`q=Admin` 在 mysql 模式會靜默
// 回 0 筆而 sqlite 回 7 筆。這幾行如果變紅，就是那個修法被人改掉了。
for (const [label, f] of [
  ['events(全量)', { errorsOnly: false, toolOnly: false, limit: FULL }],
  ['events(toolOnly)', { errorsOnly: false, toolOnly: true, limit: FULL }],
  ['events(errors)', { errorsOnly: true, toolOnly: false, limit: FULL }],
  ['events(30 天內)', { from: days30, errorsOnly: false, toolOnly: false, limit: FULL }],
  ['events(q=admin 小寫)', { q: 'admin', errorsOnly: false, toolOnly: false, limit: FULL }],
  ['events(q=Admin 混寫)', { q: 'Admin', errorsOnly: false, toolOnly: false, limit: FULL }],
  ['events(q=ADMIN 大寫)', { q: 'ADMIN', errorsOnly: false, toolOnly: false, limit: FULL }],
  ['events(q=/mcp 路徑)', { q: '/mcp', errorsOnly: false, toolOnly: false, limit: FULL }],
  ['events(to=garbage 退化輸入)', { to: 'garbage', errorsOnly: false, toolOnly: false, limit: FULL }],
  ['events(limit=-1 負數)', { errorsOnly: false, toolOnly: false, limit: -1 }],
] as const) {
  // 以「內容」當鍵而不是 id（見 compareOrdered 的 drop 說明）。
  const k = (r: any) => `${r.service}|${r.ts}|${r.event}|${r.identity}|${r.tool}|${r.path}|${r.result}`
  compare(label, await sqliteReader.queryEvents(f as any), await mysqlReader.queryEvents(f as any), k, ['id'])
}

// ── sessions（順序敏感）────────────────────────────────────────────────────
compareOrdered('sessionEvents(30 天)', await sqliteReader.sessionEvents({ since: days30 }), await mysqlReader.sessionEvents({ since: days30 }), ['id'])

// ── stats（順序敏感）──────────────────────────────────────────────────────
{
  const a = await sqliteReader.stats(days7, day1)
  const b = await mysqlReader.stats(days7, day1)
  compareOrdered('stats.perDay', a.perDay, b.perDay)
  compareOrdered('stats.perHour', a.perHour, b.perHour)
  compareOrdered('stats.topIdentities', a.topIdentities, b.topIdentities)
  // topTools / authFailures 是 `ORDER BY n DESC LIMIT 50`：同分列的先後兩邊各自
  // 未定義，比集合。
  compareSet('stats.topTools', a.topTools, b.topTools)
  compareSet('stats.authFailures', a.authFailures, b.authFailures)
  sections++
  const same = a.totalEvents === b.totalEvents
  if (!same) mismatched++
  console.log(`${same ? 'OK  ' : 'DIFF'} ${'stats.totalEvents'.padEnd(28)} sqlite=${a.totalEvents} mysql=${b.totalEvents}`)
}

// ── status_log ────────────────────────────────────────────────────────────
compare('statusLog', await sqliteReader.statusLog(), await mysqlReader.statusLog(), r => `${r.service}@${r.ts}`, ['id'])

// ── 總覽的逐服務統計 ───────────────────────────────────────────────────────
{
  const auditIds = SERVICES.filter(s => s.auditLog).map(s => s.id)
  const w = { activeSince: new Date(now - 5 * 60_000).toISOString(), hourAgo: new Date(now - 3600_000).toISOString(), dayAgo: day1 }
  const a = await sqliteReader.serviceAuditStats(auditIds, w)
  const b = await mysqlReader.serviceAuditStats(auditIds, w)
  compareOrdered('serviceAuditStats', auditIds.map(id => ({ id, ...a.get(id) })), auditIds.map(id => ({ id, ...b.get(id) })))
  const ids = SERVICES.map(s => s.id)
  const sa = await sqliteReader.lastStatusChanges(ids)
  const sb = await mysqlReader.lastStatusChanges(ids)
  compareOrdered('lastStatusChanges', ids.map(id => ({ id, ...(sa.get(id) ?? null) })), ids.map(id => ({ id, ...(sb.get(id) ?? null) })))
}

// ── pipeline_runs / agent_runs ─────────────────────────────────────────────
compare('pipelineRuns(300)', await sqliteReader.pipelineRuns(300), await mysqlReader.pipelineRuns(300), r => r.key, [...RUNS_KNOWN_GAPS, 'host', 'run_id'])
// 鍵只能用 path：sqlite 側沒有 run_id，把 run_id 放進鍵會讓兩軌的鍵**永遠對不上**
// （sqlite 是 ` | path`、mysql 是 `<uuid> | path`），整節變成「全部只在自己這邊」。
// mysql 側 agent_runs 的 PK 是 (run_id, path)，同一個 path 理論上可以出現在多個
// run 底下、被 Map 靜默併掉 —— 所以另外顯式檢查一次重複，不靠鍵去發現。
{
  const mysqlAgents = await mysqlReader.allAgentRuns()
  const seen = new Map<string, number>()
  for (const a of mysqlAgents) seen.set(a.path, (seen.get(a.path) ?? 0) + 1)
  const dup = [...seen].filter(([, n]) => n > 1)
  if (dup.length) console.log(`WARN mysql agent_runs 有 ${dup.length} 個 path 對到多個 run_id，下面的逐列比對會併掉重複：${dup.slice(0, 3).map(([p]) => p).join(', ')}`)
  compare('allAgentRuns', await sqliteReader.allAgentRuns(), mysqlAgents, r => r.path, ['file_mtime', 'run_id', 'host'])
}

// ── 逐票 / 逐 key 的查詢（審查指出這三支語意最刁鑽卻完全沒被覆蓋）──────────
{
  const sample = await sqliteReader.pipelineRuns(5)
  if (sample.length === 0) console.log('SKIP pipelineRunByKey / pipelineRunsByTicket / latestBugRunKey（sqlite 沒有 run 可取樣）')
  for (const r of sample) {
    const [a, b] = [await sqliteReader.pipelineRunByKey(r.key), await mysqlReader.pipelineRunByKey(r.key)]
    compareOrdered(`pipelineRunByKey(${r.ticket})`, a ? [a] : [], b ? [b] : [], [...RUNS_KNOWN_GAPS, 'host', 'run_id'])
    compare(
      `pipelineRunsByTicket(${r.kind}/${r.ticket})`,
      await sqliteReader.pipelineRunsByTicket(r.kind, r.ticket),
      await mysqlReader.pipelineRunsByTicket(r.kind, r.ticket),
      x => x.key,
      [...RUNS_KNOWN_GAPS, 'host', 'run_id'],
    )
  }
  for (const t of [...new Set(sample.filter(r => r.kind === 'bug').map(r => r.ticket))]) {
    compareOrdered(`latestBugRunKey(${t})`, [{ key: await sqliteReader.latestBugRunKey(t) }], [{ key: await mysqlReader.latestBugRunKey(t) }])
  }
}

// ── token-grants 的用量彙總 ────────────────────────────────────────────────
compare('identityUsage', await sqliteReader.identityUsage(), await mysqlReader.identityUsage(), r => `${r.identity} | ${r.service}`)

console.log(`\n共 ${sections} 節，${mismatched} 節有差異。`)
console.log(mismatched === 0 ? 'RESULT: PASS —— 兩軌一致' : 'RESULT: DIFF —— 見上方逐節明細（可能是回填/collector 進度，不必然是程式問題）')
process.exit(mismatched === 0 ? 0 : 1)
