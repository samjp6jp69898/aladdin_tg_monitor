// scripts/switch-readiness.ts — 「可以切 MON_READ_SOURCE=mysql 了嗎」的可執行判準。
//
//   cd /Users/user/aladdin/tg-monitor && bun run scripts/switch-readiness.ts
//   （加 --skip-slow 略過要另起 server 的 B 組）
//   退出碼：0＝全綠可切／1＝有項目未過／2＝沒有未過但有未驗（--skip-slow）
//
// 這支是給總指揮調度切換時序用的**單一判準**：exit 0 才代表「切過去不會壞、
// 壞了退得回來」。它不切換任何東西、不寫任何檔案、對監控 DB 只有 SELECT。
//
// ⚠️ 「只有 SELECT」這句在 2026-09-03 之前**不真**（Reviewer B MAJOR-4）：B 組派生的
// `verify-stream.ts` 會另起一個 server，而它繼承了 live 的 `MON_DB_ENABLED=1`，
// 於是子行程的 collector 對 live 監控 DB 寫入（spool 基準列、心跳 upsert、runs
// UPDATE）。已修：spawn 時明確帶 `MON_DB_ENABLED='0'`。
//
// 判準分四組，任一組 FAIL 就不可切：
//   A. 回滾槓桿是通的（一票否決：這條不過，出事就退不回來，其他都不用談）
//   B. 端點行為在 mysql 模式下正確
//   B2. 契約驗收基準本身沒有涵蓋性缺口（基準有洞＝擋門有洞）
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
 *
 * **適用範圍（af 2026-09-02 提出，本輪查證後收斂）**：
 *   單向性的前提是「兩個時戳出自同一顆時鐘」。因此本判準**只適用
 *   `mysql.runs.host = 'head'` 的配對**：
 *   - **回填列**（`host = 'unknown_pre_migration'`）：`backfill-sqlite.ts` 的
 *     `mapPipelineRunToRunsRow` 是把 sqlite 的 `started_at` **原字串直通**寫進
 *     MySQL、不經任何重算，所以 Δ ≡ 0 by construction。它們不走 spawn 路徑，
 *     混進分布統計會讓「最大 Δ」失真（也會讓人拿 Δ=0 去質疑 2000ms 太寬）。
 *   - **worker 執行的 run**（`host = <worker 名>`）：那是 worker 端的時鐘，跨機
 *     偏差可以產生**合法的小幅負 Δ**，套「負差直接 FAIL」會誤報。
 *     不過本輪查證的結論是**這種配對結構上不會出現**：head 的 sqlite
 *     `pipeline_runs` 是 `scanPipelineRuns()` 掃**本機** `DISPATCHER_LOG_DIR`
 *     產生的（`lib/ingest.ts:460`），worker 執行的 run 其 log 檔在 worker 那台
 *     機器上，head 這份 sqlite 根本沒有對應列（`server.ts:250-253` 的既有註解
 *     講的就是這件事）。所以 sqlite 側永遠只有 head-local 的 run，配得起來的
 *     一定是 head 配 head。
 *     真的出現非 head 配對只有一種可能：worker 的 `legacy_key`（`<ticket>.<ISO>`）
 *     與 head 某列**撞了**——那是 key 碰撞、是真問題，所以本腳本不是把它靜靜
 *     跳過，而是**單獨列為異常回報**。
 */
export const STARTED_AT_TOLERANCE_MS = 2000

/**
 * `agent_runs.cost_usd` 的兩軌比對。
 *
 * **為什麼兩軌本來就不相等**（讀過原始碼與實測，不是推測）：
 *   - sqlite 的 `cost_usd` 是 `REAL`（`lib/db.ts:75`）＝ float64，值是把每則
 *     訊息的成本**累加**出來的，於是帶浮點累積誤差：實測
 *     `47.138961899999984`、`27.718337399999992`。
 *   - 監控 DB 的 `cost_usd` 是 `DECIMAL(12,6)`（`003-agent-runs-payload.sql:19`），
 *     寫入當下就被量化到小數第 6 位：`47.138962`、`27.718337`。
 *
 * 所以差異不是「雜訊」，是**已知且確定的量化**：mysql 值 ＝ round(sqlite 值, 6)。
 * 實測兩筆皆 `Number(s.toFixed(6)) === m` 成立。
 *
 * **為什麼用正規化而不是容差**（這是刻意的選擇，不要改成 epsilon）：
 *   1. 機制已知就不該用容差。容差是在「不知道差多少才算對」時的退路；這裡
 *      知道確切的變換，直接套用同一個變換再比是**精確**的，不放寬任何窗口。
 *   2. `1e-6` 這個數字是錯的。`DECIMAL(12,6)` 的量化誤差上界是半個量子
 *      ＝ `5e-7`，`1e-6` 是它的兩倍；而且 `1e-6` 正好是該欄**能表示的最小差**，
 *      拿它當容差等於把「真的差一個最小單位」的情況一起吞掉。
 *   3. 邊界誠實說明：`toFixed` 與 MySQL 的 half-up 在「剛好落在半個量子」時
 *      理論上可能取不同方向。float64 累加值精確落在該邊界屬測度零事件，且
 *      **萬一發生是判 FAIL（偏保守）而不是誤判為相等**，方向安全、且會被歸因看見。
 *
 * null 語意不放寬：一邊 null 一邊有值 → 不相等（那是真缺口，不是捨入）。
 */
export function costUsdEqual(sqliteVal: unknown, mysqlVal: unknown): boolean {
  const s = sqliteVal === null || sqliteVal === undefined ? null : Number(sqliteVal)
  const m = mysqlVal === null || mysqlVal === undefined ? null : Number(mysqlVal)
  if (s === null || m === null) return s === m
  if (!Number.isFinite(s) || !Number.isFinite(m)) return false
  return Number(s.toFixed(6)) === Number(m.toFixed(6))
}

/**
 * 列表回傳順序必須是嚴格的「時間新→舊」：`ts DESC`，同 `ts` 以 `id DESC` 破平手。
 *
 * **為什麼要單軌自檢，而不是拿兩軌比**（a7-D46）：
 *   - 兩軌的 `id` 是各自獨立的 AUTO_INCREMENT，逐列比對會因為**合法的**插入順序
 *     差異而紅（sqlite 側實測有 333 處相鄰對違反 ts 遞減，那不是 bug，是它的
 *     攝取順序）。所以「跟另一軌一樣」不是正確性的定義。
 *   - 正確性的定義是**這一軌自己對不對**：監控畫面的事件列表語意就是「最新在
 *     最上面」，那是使用者預期，與另一軌無關。
 *   - 附帶好處：這個判準**不依賴 sqlite**，Phase 9 退役 sqlite collector 之後
 *     仍然有效——正是 a7-D38 核定的單軌自洽方向。
 *
 * **為什麼需要它**：`queryEvents` 的 `ORDER BY e.id DESC`（lib/read/mysql.ts）
 * 假設 `id` 序 ≡ ts 序。`mcp_usage` 經 spool 寫入，該假設不成立；Phase 6 回填
 * 把歷史事件以更大的 id 寫進來之後會更嚴重。實測 mysql 側第一筆比內容上最新
 * 的那筆舊了約 19 小時，而 C1（`setEqual` 建 Set）對順序完全不敏感、判綠。
 *
 * 回傳違規的相鄰對描述（空陣列 ＝ 順序正確）。
 */
export function findOrderViolations(rows: { ts: string; id?: number }[]): string[] {
  const out: string[] = []
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    const cur = rows[i]
    const tp = Date.parse(prev.ts)
    const tc = Date.parse(cur.ts)
    if (Number.isNaN(tp) || Number.isNaN(tc)) { out.push(`[${i}] ts 無法解析：${prev.ts} → ${cur.ts}`); continue }
    if (tc > tp) { out.push(`[${i}] ts 遞增：${prev.ts} → ${cur.ts}`); continue }
    // 同 ts 時要求 id 遞減（穩定破平手）；id 缺席就不判這一格。
    if (tc === tp && prev.id !== undefined && cur.id !== undefined && cur.id > prev.id) {
      out.push(`[${i}] 同 ts(${cur.ts}) 但 id 遞增：${prev.id} → ${cur.id}`)
    }
  }
  return out
}

/**
 * 寫入端的已知缺口清單（D 組）。每一項補齊之前都判 FAIL——
 * 這些欄位一旦切過去就是畫面上真的看不到的東西，不是可以「之後再說」的。
 */
const WRITE_SIDE_GAPS = [
  { field: 'stderr_path', owner: '寫入端（spawn-create-mr → runs）', note: 'migration 004 已補欄', requireFinished: false },
  { field: 'triggered_by', owner: '寫入端（triggered_by_name / triggered_by_email）', note: '沒有它，列表「發起人」欄全空', requireFinished: false },
  // rounds 兩欄只有「已結束」的 run 才該有值——執行中的 run 本來就還沒有輪數，
  // 拿它們當樣本會把「還沒跑完」誤判成「寫入端沒接」。
  { field: 'review_rounds', owner: '97（排在 health-monitor 批之後）', note: '詳情頁的審查輪數', requireFinished: true },
  { field: 'final_review_rounds', owner: '同上', note: 'Step 6.5 的派工次數', requireFinished: true },
]

/** D 組的樣本數。樣本不足判 FAIL，不判跳過——樣本不足不等於通過。 */
export const WRITE_SIDE_SAMPLE_N = 5

/** 回填列的 host 哨兵（backfill-sqlite.ts 寫死的值）。 */
const BACKFILL_HOST = 'unknown_pre_migration'

/**
 * D 組判準：「寫入端有沒有真的在填這個欄位」。
 *
 * **修的是什麼**（Reviewer B MAJOR-1）：原判準是「`mysqlReader.pipelineRuns(FULL)`
 * 裡有任一筆該欄非 null」。而 `backfill-sqlite.ts:258,266-268` 把 sqlite 的
 * `stderr_path` / `triggered_by` / `review_rounds` / `final_review_rounds`
 * **原樣複製**進 mysql `runs`（`host='unknown_pre_migration'`）。所以 Phase 6 回填
 * 一跑，D 組四格全綠——**與 spawn-create-mr 有沒有真的寫這些欄位完全無關**，
 * 而驗證寫入端正是 D 組存在的唯一理由。
 *
 * **為什麼用「列舉 host='head'」而不是「排除 host='unknown_pre_migration'」**
 * （這兩者不等價，失敗方向相反，選擇要有理由）：
 *   - **排除法**：未來若出現第三種非 live 來源（另一支回填、匯入工具、測試灌檔），
 *     它的 host 不叫 `unknown_pre_migration`，就會被當成 live ⇒ **靜默轉綠**。
 *   - **列舉法**：新來源不被計入，最壞情況是樣本不足 ⇒ **紅燈，有人要解釋**。
 *   本專案這一輪拆掉的四個缺陷全是「形狀完好、實則空轉」的綠燈，
 *   所以在兩種失敗方向之間，**選會叫的那一種**。
 *
 * **worker run 為什麼不列入樣本**：worker 的 run 也是 live 寫入端產物，但
 * worker 名單是動態的（擴容就多一個），列舉它們會讓判準跟著名冊漂移。
 * head 的樣本足以回答「寫入端有沒有接」這個問題，而且是確定性的。
 * worker 列只計數、印在 detail 供人看，不參與判定——**這使 worker 擴容不會誤報**。
 *
 * **為什麼不是 `filled > 0`**：D 組註解自稱驗的是「切過去畫面上真的會看不到的
 * 東西」，但一筆有值就過的話，1/300 也算「已接」。改成「最近 N 筆全部有值」。
 */
export function judgeWriteSideField(
  rows: any[],
  opts: { field: string; requireFinished: boolean; sampleN?: number },
): { ok: boolean; detail: string } {
  const n = opts.sampleN ?? WRITE_SIDE_SAMPLE_N
  const backfill = rows.filter(r => r?.host === BACKFILL_HOST).length
  const otherHosts = rows.filter(r => r?.host !== 'head' && r?.host !== BACKFILL_HOST).length
  let live = rows.filter(r => r?.host === 'head')
  if (opts.requireFinished) live = live.filter(r => r?.finished_at !== null && r?.finished_at !== undefined)
  live = [...live].sort((a, b) => {
    const x = String(a?.started_at ?? '')
    const y = String(b?.started_at ?? '')
    return x === y ? 0 : x < y ? 1 : -1 // started_at 新→舊
  })
  const suffix =
    `｜樣本＝最近 ${n} 筆 host='head'${opts.requireFinished ? ' 且已結束' : ''} 的 run` +
    `（回填列 ${backfill} 筆、其他 host ${otherHosts} 筆不計入）`
  if (live.length < n) {
    return { ok: false, detail: `樣本不足：只有 ${live.length} 筆可用，需要 ${n} 筆${suffix}` }
  }
  const sample = live.slice(0, n)
  const missing = sample.filter(r => r[opts.field] === null || r[opts.field] === undefined)
  return {
    ok: missing.length === 0,
    detail: `${n - missing.length}/${n} 筆有值${suffix}`,
  }
}

// ─────────────────────────────────────────────────────────────────────────

let fails = 0
let checks = 0
/** 被略過（未驗）的項數。跳過 ≠ 通過，所以它會讓結論與退出碼都不同於全綠。 */
let skipped = 0

/**
 * 結論與退出碼（Reviewer B MINOR-5）。
 *
 * **修的是什麼**：舊版是 `fails === 0 ? '可以切' : '不可切'` 與
 * `process.exit(fails === 0 ? 0 : 1)`——`--skip-slow` 把 B 組整組略過時，
 * 結論列與退出碼**與全綠一模一樣**。於是讀到 exit 0 的人無從知道 B 組
 * 有沒有被驗過，而 B 組正是 BLOCKER-1 所在。
 *
 * 更糟的是兩個缺陷的交互：MAJOR-4 修好之前，跑完整模式會污染 live 監控 DB
 * ⇒ 大家的理性選擇就是 `--skip-slow` ⇒ **恰好跳過含 BLOCKER 的那一組**。
 * 任何一條單獨看都不致命，合起來讓「exit 0」這句話失去意義。
 *
 * 退出碼三態，1 與 2 分開是為了讓自動化也能區分：
 *   0 = 全部驗過且全過 → 可以切
 *   1 = 有項目未過
 *   2 = 沒有未過，但有項目未驗（跳過不等於通過）
 */
export function concludeVerdict(fails: number, checks: number, skipped: number): { verdict: string; exitCode: 0 | 1 | 2 } {
  if (fails > 0) {
    return {
      verdict: `**不可切**（${fails}/${checks} 項未過${skipped ? `，另有 ${skipped} 項未驗` : ''}）`,
      exitCode: 1,
    }
  }
  if (skipped > 0) {
    return {
      verdict: `**未完整驗證**（${checks} 項已過，但 ${skipped} 項被 --skip-slow 略過而未驗；跳過不等於通過）`,
      exitCode: 2,
    }
  }
  return { verdict: '**可以切** MON_READ_SOURCE=mysql', exitCode: 0 }
}
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

/**
 * 從 `run-monitor.sh` 的 `for KEY in <token 清單>; do` 抽出實際被逐一匯出的 key。
 *
 * **修的是什麼**（Reviewer B MAJOR-2）：舊判準是
 * `wrapper.includes('MON_READ_SOURCE')`，而 `run-monitor.sh:13` 有一行**註解**
 * 就含這個字：
 *   `# MON_READ_SOURCE（Phase 8，plan §8.1）：讀取面資料源 sqlite|mysql，預設 sqlite。`
 * 於是把 `:23` 迴圈裡那個 token 拿掉，這一格**仍然是綠的**——而 A 組的定位是
 * 「這條不過，出事就退不回來，其他都不用談」。**一票否決的關卡被一行註解滿足。**
 *
 * 注意 a7-D25 的更正範圍：使用者補 key 之前 A 組確實紅過，那是**歷史上的負面
 * 測試**，但它證明的是「`.env` 少 key」那一半，**不是** wrapper 白名單這一半。
 * 這一半在本次修好之前，從來沒有被證明會紅。
 *
 * 回空陣列 ＝ 找不到迴圈（wrapper 結構被改過），呼叫端應視為 FAIL 而不是通過。
 */
export function extractExportedEnvKeys(wrapperSrc: string): string[] {
  for (const rawLine of wrapperSrc.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('#')) continue // 註解不算數——這就是本條缺陷的成因
    const m = /^for\s+KEY\s+in\s+([^;]+?)\s*;\s*do/.exec(line)
    if (m) return m[1].trim().split(/\s+/).filter(Boolean)
  }
  return []
}

// ═════════════════════ A. 回滾槓桿（一票否決）═════════════════════
console.log('\n═══ A. 回滾槓桿（不通就不准切——出事會退不回來）═══')
{
  const envPath = `${REPO}/.env`
  const hasKey = existsSync(envPath) && /^MON_READ_SOURCE=/m.test(readFileSync(envPath, 'utf8'))
  judge(hasKey, 'tg-monitor/.env 有 MON_READ_SOURCE',
    hasKey ? '' : '那份 0600、不進 git 的 .env 少了這個 key，「改一個字 + kickstart」的回滾按鈕是假的')

  const wrapper = readFileSync(`${REPO}/launchd/run-monitor.sh`, 'utf8')
  const keys = extractExportedEnvKeys(wrapper)
  judge(keys.includes('MON_READ_SOURCE'), 'run-monitor.sh 逐 key 匯出白名單含 MON_READ_SOURCE',
    keys.length === 0
      ? '找不到 `for KEY in ...; do` 迴圈——wrapper 結構變了，這一格已經不知道自己在驗什麼'
      : `白名單＝[${keys.join(' ')}]`)

  // 一票否決還要確認 launchd 真的跑的是這支 wrapper——白名單寫得再對，
  // plist 指到別的地方就白搭。
  const plistPath = `${REPO}/launchd/com.aladdin.tg-monitor.plist`
  const plist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : ''
  const usesWrapper = plist.includes('/launchd/run-monitor.sh')
  judge(usesWrapper, 'plist 的 ProgramArguments 指向 run-monitor.sh',
    usesWrapper ? '' : 'launchd 起的不是這支 wrapper，上面那格驗的白名單與實際啟動路徑無關')
}

// ═════════════════════ B. 端點行為（mysql 模式）═════════════════════
console.log('\n═══ B. 端點行為（mysql 模式）═══')
if (skipSlow) {
  // 「跳過」不等於「通過」（Reviewer B MINOR-5）：B 組整組被略過時，舊版的結論列
  // 與退出碼與全綠**一模一樣**，於是讀到 exit 0 的人無從知道 B 組有沒有被驗過。
  // 而 B 組正是 BLOCKER-1 所在，且在 MAJOR-4 修好之前，跑完整模式會污染 live
  // ⇒ 大家的理性選擇就是 --skip-slow ⇒ **恰好跳過含 BLOCKER 的那一組**。
  skipped += 2
  console.log('[SKIP] --skip-slow：略過 sse-segfault-repro 與 verify-stream（此二項未驗，結論不會是「可以切」）')
} else {
  judge((await run(['bun', 'run', 'scripts/sse-segfault-repro.ts'])) === 0,
    'sse-segfault-repro.ts（§8.2 前置關卡）', 'FAIL 就維持輪詢、不上 SSE')
  judge((await run(['bun', 'run', 'scripts/verify-stream.ts', 'mysql'])) === 0,
    'verify-stream.ts mysql（27 項端點行為）')
}

// ═════════════════════ B2. 契約基準的涵蓋性 ═════════════════════
// `migration/00-api-inventory.md` 被定位成 Phase 9「回應形狀不變」的官方驗收基準
// （a7 裁定）。基準本身若有涵蓋性缺口——文件有小節但 server.ts 沒有那條路由（死條目）、
// 或 server.ts 有路由但文件沒有小節（未落檔）——那就**不是文件瑕疵，是擋門有洞**：
// 拿一份漏列端點的基準去驗「形狀不變」，漏掉的那些端點等於沒有被驗過。
// `sync-inventory-lines.ts --check` 只驗不寫，同時檢查雙向涵蓋性與行號漂移。
// （行號那部分也不是潔癖：2026-09-02 實測過一次失控案例，檔頭寫「一律 +15」而實際
// 漂移是非均勻的 +53~+91——壞掉的文件會被修，指錯的文件會被相信。）
// 不受 --skip-slow 影響：它只讀 server.ts 與契約檔兩個檔案、不起 server，
// 跑完不到一秒。`--skip-slow` 要略過的是「會另起行程的那些」。
console.log('\n═══ B2. 契約驗收基準的涵蓋性（00-api-inventory.md）═══')
judge((await run(['bun', 'run', 'scripts/sync-inventory-lines.ts', '--check'])) === 0,
  'sync-inventory-lines.ts --check（行號同步 + 路由/小節雙向涵蓋）',
  '缺口代表驗收基準本身漏了端點，不是文件小問題')

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

// C1c events 分頁自洽（單軌：逐頁走完必須等於一次 FULL）
//
// **這一格換過內容，換的理由本身值得記**（a7-D55）：
// 原本的 C1c 是「`queryEvents(FULL)` 回來的列是嚴格 ts DESC, id DESC」。它在
// `ORDER BY` 還是 `e.id DESC` 的時候是**真紅的**——它抓到了 mysql 軌第一筆比
// 內容上最新那筆舊 19 小時。但 `96cd9f2` 把 `ORDER BY` 改成 `ts DESC, id DESC`
// 之後，它就退化成**同義反覆**：MySQL 保證 ORDER BY 成立，所以除非有人改掉
// 那個子句，它永遠是綠的。
//
// **一個檢查在它所偵測的缺陷被修好之後，可能失去偵測力，而沒有人會發現——
// 因為它從此永遠是綠的，看起來像在工作。**（D47 的鏡像：D47 是「綠燈根本沒
// 測到這件事」，D55 是「檢查曾經有效，是因為修復而失效」。）
//
// 所以換成真正對應 D46 缺陷族的判準：**跨頁**重複／遺漏。那才是換游標的理由——
// 只比 id 的游標配上 ts 排序會跳頁與重複列，而那不會在單頁的 ORDER BY 上顯現。
// 這一格同時涵蓋舊判準：若有人把 ORDER BY 改回 id DESC 而游標仍是 (ts, id)，
// 逐頁的結果就會與 FULL 不一致。
//
// 單軌、不與 sqlite 比：兩軌 id 是各自獨立的 AUTO_INCREMENT，逐列比會因**合法的**
// 插入順序差異而紅。附帶好處是 Phase 9 退役 sqlite collector 之後仍然有效（D38）。
{
  const f = { errorsOnly: false, toolOnly: false } as any
  const full = (await mysqlReader.queryEvents({ ...f, limit: FULL })) as any[]
  const PAGE = 500
  const seen: any[] = []
  let cur: { ts: string; id: number } | undefined
  let pages = 0
  let runaway = false
  for (;;) {
    const page = (await mysqlReader.queryEvents(
      cur ? { ...f, limit: PAGE, beforeTs: cur.ts, beforeId: cur.id } : { ...f, limit: PAGE },
    )) as any[]
    seen.push(...page)
    pages++
    if (page.length < PAGE) break
    const last = page[page.length - 1]
    cur = { ts: last.ts, id: last.id }
    if (pages > Math.ceil(full.length / PAGE) + 5) { runaway = true; break }
  }
  const ids = seen.map(r => r.id)
  const dup = ids.length - new Set(ids).size
  const fullIds = new Set(full.map(r => r.id))
  const missing = [...fullIds].filter(id => !new Set(ids).has(id)).length
  const orderKept = JSON.stringify(ids) === JSON.stringify(full.map(r => r.id))
  judge(!runaway && dup === 0 && missing === 0 && orderKept,
    'C1c /api/events 逐頁走完 ＝ 一次 FULL（無重複、無遺漏、跨頁順序一致）',
    `${pages} 頁 / 分頁 ${seen.length} 列 / FULL ${full.length} 列｜重複 ${dup}｜遺漏 ${missing}` +
      `｜跨頁順序${orderKept ? '一致' : '不一致'}${runaway ? '｜⚠️ 頁數未收斂' : ''}`)
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
  let backfillPairs = 0
  const crossHostPairs: string[] = []
  for (const r of a) {
    const o = bk.get(r.key)
    if (!o) continue
    // Δ 判準只適用 host='head' 的配對（理由見 STARTED_AT_TOLERANCE_MS 的說明）。
    const host = (o as any).host
    if (host === 'unknown_pre_migration') {
      backfillPairs++ // 回填列 Δ≡0 by construction，不進分布統計
    } else if (host !== 'head') {
      // 結構上不該出現：head 的 sqlite 只有本機 run。出現＝legacy_key 撞了。
      crossHostPairs.push(`${r.key}（host=${host}）`)
    } else {
      const delta = Date.parse(o.started_at) - Date.parse(r.started_at)
      observedMaxDelta = Math.max(observedMaxDelta, delta)
      if (delta < 0 || delta > STARTED_AT_TOLERANCE_MS) badDelta.push(`${r.key} Δ=${delta}ms`)
    }
    for (const col of Object.keys(r)) {
      if (IGNORE.has(col)) continue
      if (JSON.stringify((r as any)[col] ?? null) !== JSON.stringify((o as any)[col] ?? null)) {
        fieldDiffs.push(`${r.key}.${col}: sqlite=${JSON.stringify((r as any)[col])} mysql=${JSON.stringify((o as any)[col])}`)
      }
    }
  }
  judge(badDelta.length === 0,
    `C5 runs.started_at 在容差內（0 ≤ Δ ≤ ${STARTED_AT_TOLERANCE_MS}ms，Δ = mysql − sqlite，僅 host='head' 配對）`,
    `實測最大 Δ=${Number.isFinite(observedMaxDelta) ? observedMaxDelta + 'ms' : "n/a（無 host='head' 交集樣本）"}` +
      `｜回填列已排除 ${backfillPairs} 筆（Δ≡0 by construction）` +
      (badDelta.length ? ` 逾差：${badDelta.slice(0, 3).join('; ')}` : ''))
  // 非 head 配對是 key 碰撞的訊號，不靜靜跳過。
  judge(crossHostPairs.length === 0,
    "C5b 沒有 host≠'head' 的配對（head 的 sqlite 結構上只有本機 run，配到別台＝legacy_key 撞了）",
    crossHostPairs.length ? crossHostPairs.slice(0, 3).join('; ') : '')
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
      // cost_usd 走 DECIMAL(12,6) 正規化：兩軌型別不同（sqlite REAL vs
      // mysql DECIMAL），逐字比會把已知的量化差報成資料不一致（實測假陽性）。
      const equal =
        col === 'cost_usd'
          ? costUsdEqual((r as any)[col], (o as any)[col])
          : JSON.stringify((r as any)[col] ?? null) === JSON.stringify((o as any)[col] ?? null)
      if (!equal) diffs.push(`${r.path.split('/').pop()}.${col}`)
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
      const r = judgeWriteSideField(b, { field: g.field, requireFinished: g.requireFinished })
      judge(r.ok, `D ${g.field} 寫入端已接`, `${r.detail}｜負責：${g.owner}｜${g.note}`)
    }
  }
}

// ═════════════════════ 結論 ═════════════════════
const { verdict, exitCode } = concludeVerdict(fails, checks, skipped)
console.log(`\n═══ 結論：${verdict} ═══`)
if (fails === 0 && skipped > 0) {
  console.log('要得到「可以切」必須不帶 --skip-slow 跑完整模式（B 組含 §8.2 前置關卡與 27 項端點行為）。')
}
if (fails === 0 && skipped === 0) {
  console.log('切換步驟：改 tg-monitor/.env 的 MON_READ_SOURCE=mysql → launchctl kickstart -k com.aladdin.tg-monitor')
  console.log('回滾步驟：同上改回 sqlite 再 kickstart（秒級，不需 commit / push / sync-workers）')
  console.log('切完立刻打 /api/read-source 確認 effective=mysql 且 degraded=false（探針失敗會靜默退回 sqlite）')
}
process.exit(exitCode)
