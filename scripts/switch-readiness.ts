// scripts/switch-readiness.ts — 「可以切 MON_READ_SOURCE=mysql 了嗎」的可執行判準。
//
//   cd /Users/user/aladdin/tg-monitor && bun run scripts/switch-readiness.ts
//   （加 --skip-slow 略過要另起 server 的 B 組；退出碼 0 = 全綠 = 可以切）
//
// 這支是給總指揮調度切換時序用的**單一判準**：exit 0 才代表「切過去不會壞、
// 壞了退得回來」。它不切換任何東西、不寫任何檔案、對監控 DB 只有 SELECT。
//
// 判準分四組，任一組 FAIL 就不可切：
//   A. 回滾槓桿是通的（一票否決：這條不過，出事就退不回來，其他都不用談）
//   B. 端點行為在 mysql 模式下正確
//   C. 資料面已收斂（§10.2 雙軌對照）
//   D. 寫入端的已知缺口都補齊了
//
// Phase 9（退役 sqlite collector）會再用一次同一組 C 判準，所以容差定義寫在這裡
// 當單一來源，不要在別處各寫一份。

import { existsSync, readFileSync } from 'node:fs'
import { sqliteReader } from '../lib/read/sqlite.ts'
import type { MonitorReader } from '../lib/read/types.ts'
import { SERVICES } from '../lib/services.ts'

const skipSlow = process.argv.includes('--skip-slow')
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// ─────────────────────────────────────────────────────────────────────────
// 容差定義（單一來源；Phase 9 沿用）
// ─────────────────────────────────────────────────────────────────────────

/**
 * `started_at` 的兩軌容差。
 *
 * **為什麼兩軌本來就不相等**（讀過原始碼，不是推測）：
 *   - sqlite 的 `pipeline_runs.started_at` 是從 **log 檔名** 的時間戳推導的
 *     （`lib/ingest.ts` 的 `fileTsToIso`），那個時間戳產生在
 *     `telegram-dispatcher/lib/pipeline-runner/spawn-create-mr.ts:322`
 *     （`const timestamp = new Date()...`）。
 *   - 監控 DB 的 `runs.started_at` 是**另一次** `new Date()`，在同檔 `:430` / `:445`
 *     寫進 runs 列。
 *   兩者中間隔著「建 log 檔 + 寫 triggered-by sidecar（`:337`）+ 真正 spawn」。
 *
 * 因此：
 *   - **方向是單向的**：MySQL 的值必然 **≥** sqlite 的值。負差代表 run 被對到了
 *     錯的列（或時鐘倒退），那是真問題，一律 FAIL，不給容差。
 *   - **上界**取決於那段 I/O 有多慢。實測（2026-09-02，n=2）是 1ms 與 2ms，
 *     但樣本太小、且這台機器同時在跑多條 pipeline，負載高時建檔＋spawn 花掉
 *     幾十到幾百毫秒是正常的。**所以不採用實測值當容差**——那會在忙的時候誤報。
 *   - 取 2000ms：足夠涵蓋負載下的 spawn 抖動，又遠小於「對錯列」會產生的差距
 *     （同票的不同次執行至少差幾分鐘），所以擋得住真正的誤配對。
 *   - 本腳本會印出**實測到的最大差值**；樣本夠多之後要收緊，改這個常數即可。
 */
export const STARTED_AT_TOLERANCE_MS = 2000

/**
 * 寫入端的已知缺口清單（D 組）。每一項補齊之前都判 FAIL——
 * 這些欄位一旦切過去就是畫面上真的看不到的東西，不是可以「之後再說」的。
 */
const WRITE_SIDE_GAPS = [
  { field: 'stderr_path', owner: '寫入端（spawn-create-mr → runs）', note: 'migration 004 已補欄' },
  { field: 'triggered_by', owner: '寫入端（triggered_by_name / triggered_by_email）', note: '沒有它，列表「發起人」欄全空' },
  { field: 'review_rounds', owner: '97（排在 health-monitor 批之後）', note: '詳情頁的審查輪數' },
  { field: 'final_review_rounds', owner: '同上', note: 'Step 6.5 的派工次數' },
]

// ─────────────────────────────────────────────────────────────────────────

let fails = 0
let checks = 0
function ok(label: string, detail = '') {
  checks++
  console.log(`[OK]   ${label}${detail ? '  — ' + detail : ''}`)
}
function fail(label: string, detail = '') {
  checks++
  fails++
  console.log(`[FAIL] ${label}${detail ? '  — ' + detail : ''}`)
}
function judge(cond: boolean, label: string, detail = '') {
  cond ? ok(label, detail) : fail(label, detail)
}

async function run(cmd: string[], cwd = REPO): Promise<number> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  await p.exited
  return p.exitCode ?? 1
}

// ═════════════════════ A. 回滾槓桿（一票否決）═════════════════════
console.log('\n═══ A. 回滾槓桿（不通就不准切——出事會退不回來）═══')
{
  const envPath = `${REPO}/.env`
  const hasKey = existsSync(envPath) && /^MON_READ_SOURCE=/m.test(readFileSync(envPath, 'utf8'))
  judge(hasKey, 'tg-monitor/.env 有 MON_READ_SOURCE',
    hasKey ? '' : '那份 0600、不進 git 的 .env 少了這個 key，「改一個字 + kickstart」的回滾按鈕是假的')

  const wrapper = readFileSync(`${REPO}/launchd/run-monitor.sh`, 'utf8')
  judge(wrapper.includes('MON_READ_SOURCE'), 'run-monitor.sh 逐 key 匯出白名單含 MON_READ_SOURCE',
    wrapper.includes('MON_READ_SOURCE') ? '' : 'launchd 起的行程永遠讀不到它')
}

// ═════════════════════ B. 端點行為（mysql 模式）═════════════════════
console.log('\n═══ B. 端點行為（mysql 模式）═══')
if (skipSlow) {
  console.log('[SKIP] --skip-slow：略過 sse-segfault-repro 與 verify-stream')
} else {
  judge((await run(['bun', 'run', 'scripts/sse-segfault-repro.ts'])) === 0,
    'sse-segfault-repro.ts（§8.2 前置關卡）', 'FAIL 就維持輪詢、不上 SSE')
  judge((await run(['bun', 'run', 'scripts/verify-stream.ts', 'mysql'])) === 0,
    'verify-stream.ts mysql（27 項端點行為）')
}

// ═════════════════════ C. 資料面收斂（§10.2）═════════════════════
console.log('\n═══ C. 資料面收斂（§10.2 雙軌對照）═══')
let mysqlReader: MonitorReader
try {
  const m = await import('../lib/read/mysql.ts')
  await m.probeMysqlReadable()
  mysqlReader = m.mysqlReader
} catch (e) {
  fail('連得上監控 DB', e instanceof Error ? e.message : String(e))
  console.log(`\n═══ 結論：不可切（${fails}/${checks} 項未過）═══`)
  process.exit(1)
}

const FULL = 1_000_000
const now = Date.now()
const iso = (t: number) => new Date(t).toISOString()

/** 內容集合相等（忽略指定欄位）。 */
function setEqual(a: any[], b: any[], drop: string[] = []): { equal: boolean; onlyA: number; onlyB: number } {
  const k = (r: any) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([c]) => !drop.includes(c))))
  const sa = new Set(a.map(k))
  const sb = new Set(b.map(k))
  const onlyA = [...sa].filter(x => !sb.has(x)).length
  const onlyB = [...sb].filter(x => !sa.has(x)).length
  return { equal: onlyA === 0 && onlyB === 0, onlyA, onlyB }
}

// C1 events：全量內容必須完全一致（`id` 是各自獨立的 AUTOINCREMENT，不比）
{
  const f = { errorsOnly: false, toolOnly: false, limit: FULL } as any
  const [a, b] = [await sqliteReader.queryEvents(f), await mysqlReader.queryEvents(f)]
  const r = setEqual(a, b, ['id'])
  judge(r.equal, 'C1 events 全量內容一致', `sqlite=${a.length} mysql=${b.length} 只在 sqlite=${r.onlyA} 只在 mysql=${r.onlyB}`)
}

// C1b events 的大小寫敏感性（collation 回歸；兩軌筆數必須一致）
for (const q of ['admin', 'Admin', 'ADMIN']) {
  const f = { q, errorsOnly: false, toolOnly: false, limit: FULL } as any
  const [a, b] = [await sqliteReader.queryEvents(f), await mysqlReader.queryEvents(f)]
  judge(a.length === b.length, `C1b events?q=${q} 筆數一致`, `sqlite=${a.length} mysql=${b.length}`)
}

// C2 sessions：順序也要一致（session 串接吃順序）
{
  const p = { since: iso(now - 30 * 86400_000) }
  const [a, b] = [await sqliteReader.sessionEvents(p), await mysqlReader.sessionEvents(p)]
  const strip = (rows: any[]) => JSON.stringify(rows.map(r => ({ ...r, id: undefined })))
  judge(strip(a) === strip(b), 'C2 sessionEvents(30 天) 逐列逐欄一致', `sqlite=${a.length} mysql=${b.length}`)
}

// C3 stats
{
  const [a, b] = [
    await sqliteReader.stats(iso(now - 7 * 86400_000), iso(now - 86400_000)),
    await mysqlReader.stats(iso(now - 7 * 86400_000), iso(now - 86400_000)),
  ]
  judge(JSON.stringify(a.perDay) === JSON.stringify(b.perDay), 'C3 stats.perDay 一致')
  judge(JSON.stringify(a.perHour) === JSON.stringify(b.perHour), 'C3 stats.perHour 一致')
  judge(JSON.stringify(a.topIdentities) === JSON.stringify(b.topIdentities), 'C3 stats.topIdentities 一致')
  // topTools / authFailures 是 ORDER BY n DESC LIMIT 50，同分列的先後兩邊各自未定義 → 比集合
  judge(setEqual(a.topTools, b.topTools).equal, 'C3 stats.topTools 一致（順序不計）')
  judge(setEqual(a.authFailures, b.authFailures).equal, 'C3 stats.authFailures 一致（順序不計）')
  judge(a.totalEvents === b.totalEvents, 'C3 stats.totalEvents 一致', `${a.totalEvents} vs ${b.totalEvents}`)
}

// C4/C5 runs：覆蓋率 + 逐欄（started_at 走容差）
let observedMaxDelta = Number.NEGATIVE_INFINITY
{
  const [a, b] = [await sqliteReader.pipelineRuns(FULL), await mysqlReader.pipelineRuns(FULL)]
  const bk = new Map(b.map(r => [r.key, r]))
  const missing = a.filter(r => !bk.has(r.key))
  // 只要求「sqlite 有的 mysql 都要有」；mysql 多出來的是合理的（遠端 worker 的 run
  // 本來就不在這台 head 的 sqlite 裡，那正是切過去的目的之一）。
  judge(missing.length === 0, 'C4 sqlite 的每一筆 run 在 mysql 都找得到',
    `sqlite=${a.length} mysql=${b.length} 缺=${missing.length}${missing.length ? '（例：' + missing.slice(0, 3).map(r => r.key).join(', ') + '）' : ''}`)

  const IGNORE = new Set(['started_at', 'host', 'run_id', 'agents', 'agent_count', 'total_input', 'total_output', 'total_cost'])
  const fieldDiffs: string[] = []
  const badDelta: string[] = []
  for (const r of a) {
    const o = bk.get(r.key)
    if (!o) continue
    const delta = Date.parse(o.started_at) - Date.parse(r.started_at)
    observedMaxDelta = Math.max(observedMaxDelta, delta)
    if (delta < 0 || delta > STARTED_AT_TOLERANCE_MS) badDelta.push(`${r.key} Δ=${delta}ms`)
    for (const col of Object.keys(r)) {
      if (IGNORE.has(col)) continue
      if (JSON.stringify((r as any)[col] ?? null) !== JSON.stringify((o as any)[col] ?? null)) {
        fieldDiffs.push(`${r.key}.${col}: sqlite=${JSON.stringify((r as any)[col])} mysql=${JSON.stringify((o as any)[col])}`)
      }
    }
  }
  judge(badDelta.length === 0,
    `C5 runs.started_at 在容差內（0 ≤ Δ ≤ ${STARTED_AT_TOLERANCE_MS}ms，Δ = mysql − sqlite）`,
    `實測最大 Δ=${Number.isFinite(observedMaxDelta) ? observedMaxDelta + 'ms' : 'n/a（無交集樣本）'}${badDelta.length ? ' 逾差：' + badDelta.slice(0, 3).join('; ') : ''}`)
  judge(fieldDiffs.length === 0, 'C5 runs 其餘每一欄逐字相等',
    fieldDiffs.length ? fieldDiffs.slice(0, 4).join(' | ') : '')
}

// C6 agent_runs
{
  const [a, b] = [await sqliteReader.allAgentRuns(), await mysqlReader.allAgentRuns()]
  const bk = new Map(b.map(r => [r.path, r]))
  const missing = a.filter(r => !bk.has(r.path))
  judge(missing.length === 0, 'C6 sqlite 的每一筆 agent_run 在 mysql 都找得到',
    `sqlite=${a.length} mysql=${b.length} 缺=${missing.length}`)
  const IGNORE = new Set(['file_mtime', 'run_id', 'host'])
  const diffs: string[] = []
  for (const r of a) {
    const o = bk.get(r.path)
    if (!o) continue
    for (const col of Object.keys(r)) {
      if (IGNORE.has(col)) continue
      if (JSON.stringify((r as any)[col] ?? null) !== JSON.stringify((o as any)[col] ?? null)) {
        diffs.push(`${r.path.split('/').pop()}.${col}`)
      }
    }
  }
  judge(diffs.length === 0, 'C6 agent_runs 逐欄相等（file_mtime 不比：collector 私有游標，刻意不進權威表）',
    diffs.length ? [...new Set(diffs)].slice(0, 6).join(', ') : '')
}

// C7 status_log：只在「兩軌都有資料」的時間窗內比對翻轉
{
  const [a, b] = [await sqliteReader.statusLog(), await mysqlReader.statusLog()]
  if (b.length === 0) {
    fail('C7 status_log 有資料可比', 'mysql 側一筆都沒有（collector 尚未遷移）')
  } else {
    // 公平的比法要**逐 service** 決定時間窗，而且要排掉 mysql 側的起步基準列：
    //   - mysql 只有 collector 啟用之後的歷史，更早的翻轉只在 sqlite（除非回填）；
    //   - 每個 service 在 mysql 的**第一列**是 collector 起步時記的基準（讀取層的
    //     折疊 CTE 會把它當成「該狀態的最早觀測」＝看起來像一次翻轉），但 sqlite
    //     在那之前就已經知道同一個狀態、不會記這一筆。整組拿去比一定不相等。
    // 所以：窗起點取該 service 在 mysql 的第一列**之後**，兩軌都只看窗內。
    const firstByService = new Map<string, string>()
    for (const r of [...b].sort((x, y) => (x.ts < y.ts ? -1 : 1))) {
      if (!firstByService.has(r.service)) firstByService.set(r.service, r.ts)
    }
    const inWin = (rows: any[]) =>
      rows
        .filter(r => { const f = firstByService.get(r.service); return f !== undefined && r.ts > f })
        .map(r => `${r.service}@${r.ts}|${r.status}`)
        .sort()
    const wa = inWin(a)
    const wb = inWin(b)
    const services = [...firstByService.keys()].length
    if (wa.length === 0 && wb.length === 0) {
      fail('C7 status_log 在共同時間窗內的翻轉一致',
        `窗內兩軌都還沒有翻轉可比（mysql 只有 ${services} 個 service 的起步基準列）——` +
        '要等 collector 跑到至少發生一次真實 up/down 翻轉才判得出來')
    } else {
      judge(JSON.stringify(wa) === JSON.stringify(wb),
        'C7 status_log 在共同時間窗內的翻轉一致',
        `逐 service 排除 mysql 起步基準列後：sqlite=${wa.length} mysql=${wb.length}`)
    }
  }
}

// C8 identityUsage（/api/token-grants 的用量彙總）
{
  const [a, b] = [await sqliteReader.identityUsage(), await mysqlReader.identityUsage()]
  judge(setEqual(a, b).equal, 'C8 identityUsage 一致', `sqlite=${a.length} mysql=${b.length}`)
}

// C9 lastStatusChanges（總覽卡片的狀態翻轉時間）
{
  const ids = SERVICES.map(s => s.id)
  const [a, b] = [await sqliteReader.lastStatusChanges(ids), await mysqlReader.lastStatusChanges(ids)]
  const diff = ids.filter(id => JSON.stringify(a.get(id) ?? null) !== JSON.stringify(b.get(id) ?? null))
  judge(diff.length === 0, 'C9 lastStatusChanges 一致',
    diff.length
      ? `不一致 ${diff.length}/${ids.length} 個 service：${diff.slice(0, 4).join(', ')}${diff.length > 4 ? ' …' : ''}` +
        '（收斂前這是預期的：mysql 回的是該 service 在監控 DB 裡最早的觀測，sqlite 回的是真正那次翻轉，' +
        '要等每個 service 在 collector 啟用後都真的翻轉過一次才會對上）'
      : '')
}

// ═════════════════════ D. 寫入端已知缺口 ═════════════════════
console.log('\n═══ D. 寫入端已知缺口（切過去之後畫面上真的會看不到的東西）═══')
{
  const b = await mysqlReader.pipelineRuns(FULL)
  if (b.length === 0) {
    fail('D 有 run 可檢查', 'mysql runs 表是空的')
  } else {
    for (const g of WRITE_SIDE_GAPS) {
      const filled = b.filter(r => (r as any)[g.field] !== null && (r as any)[g.field] !== undefined).length
      judge(filled > 0, `D ${g.field} 寫入端已接`,
        `${filled}/${b.length} 筆有值｜負責：${g.owner}｜${g.note}`)
    }
  }
}

// ═════════════════════ 結論 ═════════════════════
console.log(`\n═══ 結論：${fails === 0 ? '**可以切** MON_READ_SOURCE=mysql' : `**不可切**（${fails}/${checks} 項未過）`} ═══`)
if (fails === 0) {
  console.log('切換步驟：改 tg-monitor/.env 的 MON_READ_SOURCE=mysql → launchctl kickstart -k com.aladdin.tg-monitor')
  console.log('回滾步驟：同上改回 sqlite 再 kickstart（秒級，不需 commit / push / sync-workers）')
  console.log('切完立刻打 /api/read-source 確認 effective=mysql 且 degraded=false（探針失敗會靜默退回 sqlite）')
}
process.exit(fails === 0 ? 0 : 1)
