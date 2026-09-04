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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sqliteReader } from '../lib/read/sqlite.ts'
import type { MonitorReader } from '../lib/read/types.ts'
import { SERVICES, DISPATCHER_LOG_DIR, AGENT_TRACE_DIR } from '../lib/services.ts'
// S 組（單軌自洽性檢查，Phase 9 §3.1，a7-D38 核定方向）的純函式判準，同理由
// 拆在 lib/read/single-track-consistency.ts（2026-09-04，設計稿
// phase9-single-track-design-62.md，使用者核准後接線）。
import {
  collectFsRunLogs, judgeRunCoverage, isAgentRunSourcePath, judgeAgentRunCoverage,
  judgeLegacyKeyCoherence, judgeRetryLineage, KEY_TO_STARTED_AT_TOLERANCE_MS,
  judgeStatusLogOrderSelfConsistency,
} from '../lib/read/single-track-consistency.ts'

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
 * `finished_at` 的兩軌容差（a7-D28→D36 定案；aladdin-1d 2026-09-03 定值）。
 *
 * **為什麼兩軌本來就不相等**（讀碼＋因果順序確認，不是推測）：
 *   - sqlite 的 `pipeline_runs.finished_at` 不是輪詢當下的時間，是
 *     `post-run-notify.log` 那一行**自己的時間戳**：`lib/ingest.ts:580` 的
 *     `finishedAt = cls.loggedAt`，`cls.loggedAt` 來自
 *     `telegram-dispatcher/lib/pipeline-runner/post-run-notify.ts:91` 的
 *     `log()` helper 寫那一行時取的 `new Date().toISOString()`。
 *   - 監控 DB 的 `runs.finished_at` 是**同一支行程稍後**另一次 `new Date()`
 *     （同檔 `:200`）。程式順序上 `:387` 先 `log(classification=…)`，
 *     `:394` 才 `await writeAuthoritativeOutcome(...)`。
 *   兩者中間隔著「`appendFileSync` 返回 + 幾行同步檢查（`isMonitorDbEnabled`、
 *     讀 `MON_RUN_ID`）」——**跟 `started_at` 同構**：兩次獨立 `new Date()`，
 *     因果順序決定方向，量級是同行程內同步程式碼的抖動，不是輪詢週期。
 *
 * 因此：
 *   - **方向是單向的**：mysql 的值必然 **≥** sqlite 的值（因果順序決定，不是統計
 *     傾向）。負差代表配對錯誤或時鐘倒退，一律 FAIL，不給容差（同 D6 的立場）。
 *   - **樣本**（2026-09-03，n=5，`host='head'`）：4 筆 Δ=1ms、1 筆 Δ=2ms，
 *     無離群值，方向 100% 一致。
 *   - **取 200ms，不是實測上界（2ms）本身**：機制雖與 `started_at` 同構，但涉及
 *     的 I/O 更輕（一次已完成的 `appendFileSync` 之後幾行同步碼，沒有 `started_at`
 *     那條的行程 spawn），所以不套用 `STARTED_AT_TOLERANCE_MS` 那個為 spawn 抖動
 *     設的 2000ms（**兩者不共用常數**——這是 a7 已經論證過的立場：合併會讓其中
 *     一條失去可檢驗的理由）。200ms 是實測上界的 100 倍安全係數，用來吸收
 *     GC 暫停與磁碟寫入在負載下的偶發抖動，同時遠小於「對錯列」或「timeout
 *     真正延後結束」會產生的差距（分鐘級）。**這是判斷，不是量出來的**——
 *     樣本更多之後如果經常貼著上界，要收緊或放寬都改這個常數，不要改判準本身。
 *   - 本腳本會印出**實測到的最大差值**，同 `started_at` 的做法。
 *
 * **適用範圍（a7-D36 §2.3 定案）**：
 *   - 僅適用 `host='head'` 的配對（同 `started_at` 的單一時鐘前提）。
 *   - **`outcome='timeout'` 的列整條排除、不進本容差、也不進逐字相等**：
 *     `ingest.ts:585-588` 對 timeout 走 `startedAt + CREATE_MR_TIMEOUT_SECONDS`
 *     推算出的 finished_at，不是真實結束時間；mysql 記的是真正 exit 時間。
 *     差到分鐘級是**設計如此**，跟這條容差要抓的「同步程式碼抖動」不是同一種
 *     現象，硬套會把第一筆 timeout run 直接打爆容差——所以是整列豁免，不是
 *     放寬容差去吞它。
 *   - 與既有的 `outcome_source='tracker_reconcile'` 豁免（§9.2-1）**不是同一類、
 *     不共用判準**：那條是 mon_ui 結構上永遠沒有 UPDATE `finished_at` 的授權，
 *     屬於永久性缺口，差值可以是分鐘到小時級；這條是兩次時鐘讀取的正常抖動，
 *     差值恆定在個位數到低兩位數毫秒。
 */
export const FINISHED_AT_TOLERANCE_MS = 200

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

// C5/C6 豁免（phase9-readiness.md §9.1/§9.2/§9.3）的純函式判準，拆在
// lib/read/gate-exemptions.ts（原因見該檔頭註解：純函式才能安全被單元測試 import，
// 這支腳本本身 import 就會連 DB、跑判定、process.exit）。
import {
  extractIntConstant, isSkeletonAgentRun, SKELETON_EXEMPT_FIELDS,
  isFinishedAtExempt, isOutcomeDifference3Exempt, isRoundsExempt, KNOWN_OUTCOME_SOURCES,
} from '../lib/read/gate-exemptions.ts'
// D 組（寫入端已知缺口）純函式判準，同一理由拆在 lib/read/write-side-gaps.ts
// （2026-09-04，migration/review/rounds-write-side-investigation.md 的修法）。
import { judgeWriteSideField, isRoundsEligible } from '../lib/read/write-side-gaps.ts'

/**
 * 寫入端的已知缺口清單（D 組）。每一項補齊之前都判 FAIL——
 * 這些欄位一旦切過去就是畫面上真的看不到的東西，不是可以「之後再說」的。
 */
const WRITE_SIDE_GAPS = [
  { field: 'stderr_path', owner: '寫入端（spawn-create-mr → runs）', note: 'migration 004 已補欄', requireFinished: false },
  { field: 'triggered_by', owner: '寫入端（triggered_by_name / triggered_by_email）', note: '沒有它，列表「發起人」欄全空', requireFinished: false },
  // rounds 兩欄只有「已結束」的 run 才該有值——執行中的 run 本來就還沒有輪數，
  // 拿它們當樣本會把「還沒跑完」誤判成「寫入端沒接」。另加 eligible 過濾
  // （2026-09-04，見 lib/read/write-side-gaps.ts 的 isRoundsEligible 註解）。
  { field: 'review_rounds', owner: '97（排在 health-monitor 批之後）', note: '詳情頁的審查輪數', requireFinished: true, eligible: isRoundsEligible },
  { field: 'final_review_rounds', owner: '同上', note: 'Step 6.5 的派工次數', requireFinished: true, eligible: isRoundsEligible },
]

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
let outcomeMeta: Map<string, { outcome_source: string | null; outcome_tier: number | null }>
let gateRuns: Awaited<ReturnType<typeof import('../lib/read/mysql.ts')['readAllRunsForGate']>>
// gateRuns 的快照時刻：S1 的時序競態解法（見 single-track-consistency.ts 檔頭）
// 要求「DB 快照時刻」是一個確定值，在真的發 SELECT 之前先記下來，比查詢本身
// 開始時間更早沒關係（結構性下界，越早越安全，不會誤放過真漏收）。
let gateRunsSnapshotAtMs: number
// S9 專用：service_status_log 未折疊全量列（見 lib/read/mysql.ts 的
// readAllStatusLogForGate 檔頭理由）。
let gateStatusLog: Awaited<ReturnType<typeof import('../lib/read/mysql.ts')['readAllStatusLogForGate']>>
try {
  const m = await import('../lib/read/mysql.ts')
  await m.probeMysqlReadable()
  mysqlReader = m.mysqlReader
  outcomeMeta = await m.readOutcomeMeta()
  gateRunsSnapshotAtMs = Date.now()
  gateRuns = await m.readAllRunsForGate()
  gateStatusLog = await m.readAllStatusLogForGate()
} catch (e) {
  fail('連得上監控 DB', e instanceof Error ? e.message : String(e))
  console.log(`\n═══ 結論：不可切（${fails}/${checks} 項未過）═══`)
  process.exit(1)
}

const FULL = 1_000_000
const now = Date.now()
const iso = (t: number) => new Date(t).toISOString()

// C5/C6 豁免要用到的兩個私有常數，從原始碼讀（不 import：CREATE_MR_TIMEOUT_SECONDS
// 在 lib/ingest.ts 也沒 export，import 整支會拉進 collector 模組圖且它 import
// 當下就開 sqlite）。讀不到就判 FAIL，不給預設值（見 extractIntConstant 說明）。
const ingestSrc = readFileSync(`${REPO}/lib/ingest.ts`, 'utf8')
const createMrTimeoutSec = extractIntConstant(ingestSrc, 'CREATE_MR_TIMEOUT_SECONDS')
const roundsWindowMs = extractIntConstant(ingestSrc, 'ROUNDS_MON_DB_RECENT_WINDOW_MS')
judge(createMrTimeoutSec !== null, 'C6 骨架列年齡上界常數可讀（CREATE_MR_TIMEOUT_SECONDS）',
  createMrTimeoutSec !== null ? `${createMrTimeoutSec}s` : 'lib/ingest.ts 讀不到這個常數，C6 骨架列年齡判準無法執行')
judge(roundsWindowMs !== null, 'rounds 豁免窗常數可讀（ROUNDS_MON_DB_RECENT_WINDOW_MS）',
  roundsWindowMs !== null ? `${roundsWindowMs}ms` : 'lib/ingest.ts 讀不到這個常數，rounds 方向敏感豁免無法執行')

// outcome_source 值域監看（§9.2，97 建議、b5 採納）：集合外的值只 WARN，不判 FAIL。
{
  const unknown = new Set<string>()
  for (const meta of outcomeMeta.values()) {
    if (meta.outcome_source !== null && !KNOWN_OUTCOME_SOURCES.has(meta.outcome_source)) unknown.add(meta.outcome_source)
  }
  if (unknown.size > 0) console.log(`[WARN] outcome_source 出現已知值域外的值（不影響判定，僅提醒維護清單）：${[...unknown].join(', ')}`)
}

/** 內容集合相等（忽略指定欄位）。 */
function setEqual(a: any[], b: any[], drop: string[] = []): { equal: boolean; onlyA: number; onlyB: number } {
  const k = (r: any) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([c]) => !drop.includes(c))))
  const sa = new Set(a.map(k))
  const sb = new Set(b.map(k))
  const onlyA = [...sa].filter(x => !sb.has(x)).length
  const onlyB = [...sb].filter(x => !sa.has(x)).length
  return { equal: onlyA === 0 && onlyB === 0, onlyA, onlyB }
}

/**
 * C4/C5/C6 用 `new Map(rows.map(r => [key(r), r]))` 建索引比對——若鍵不是唯一
 * （Reviewer B MINOR-3）：`legacy_key` 不是唯一索引（mysql.ts 自己的註解），
 * `agent_runs` PK 是 `(run_id, path)`、同一個 path 理論上可以對到多個 run_id。
 * 重複時 Map 留最後一筆，比對用的是任意一筆，而不是「有沒有重複」本身被看見。
 *
 * 這支只印 `[WARN]`、不判 FAIL：這條路徑目前資料是否真的有重複未知，先讓它
 * 會叫（比照 compare-sqlite-mysql.ts 既有對 agent_runs path 重複的處理方式）。
 */
function warnDuplicateKeys(rows: any[], keyFn: (r: any) => string, label: string): void {
  const seen = new Map<string, number>()
  for (const r of rows) {
    const k = keyFn(r)
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const dup = [...seen].filter(([, n]) => n > 1)
  if (dup.length) {
    console.log(
      `[WARN] ${label} 有 ${dup.length} 個鍵對到多筆列，Map 索引會靜默併掉重複、比對只用任意一筆：` +
        dup.slice(0, 5).map(([k, n]) => `${k}×${n}`).join(', '),
    )
  }
}

// C 組／D 組整段包 try/catch（Reviewer B MINOR-4b）：C1 先讀 sqlite 再讀
// mysql、之後每一格都對 mysql 下 FULL 查詢，`READ_QUERY_TIMEOUT_MS=5000`
// （mysql.ts）一到就 throw。這些都是頂層 await，原本沒有 try/catch 接住，
// 逾時或其他例外會變成 unhandled rejection、exit 1 但沒有「結論」列——
// 總指揮看到的是 stack trace，不是判準結果。catch 到之後印出結構化的
// [FAIL] 並繼續往下跑到「結論」區塊，不讓例外裸露。
try {

// C1 events：全量內容必須完全一致（`id` 是各自獨立的 AUTOINCREMENT，不比）
//
// 加 `to: iso(now)` 上界（Reviewer B MINOR-4a）：sqlite 與 mysql 是先後兩次
// 獨立查詢，中間若有 live ingest 寫入新事件，會被其中一軌看到、另一軌看不到，
// 誤判成 onlyA/onlyB > 0。`now` 在兩次查詢之前就已經取好（:431），把它當上界
// 讓兩次查詢共用同一個「當下」快照，中間才寫入的事件（ts 必然晚於 now）不會
// 進入任一邊的結果，兩邊比較的就是同一個時間切片。
{
  const f = { errorsOnly: false, toolOnly: false, limit: FULL, to: iso(now) } as any
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

// C4/C5 runs：覆蓋率 + 逐欄（started_at/finished_at 走容差）
let observedMaxDelta = Number.NEGATIVE_INFINITY
let observedMaxFinishedDelta = Number.NEGATIVE_INFINITY
{
  const [a, b] = [await sqliteReader.pipelineRuns(FULL), await mysqlReader.pipelineRuns(FULL)]
  warnDuplicateKeys(b, r => r.key, 'C4/C5 mysql pipelineRuns.key')
  const bk = new Map(b.map(r => [r.key, r]))
  const missing = a.filter(r => !bk.has(r.key))
  // 只要求「sqlite 有的 mysql 都要有」；mysql 多出來的是合理的（遠端 worker 的 run
  // 本來就不在這台 head 的 sqlite 裡，那正是切過去的目的之一）。
  judge(missing.length === 0, 'C4 sqlite 的每一筆 run 在 mysql 都找得到',
    `sqlite=${a.length} mysql=${b.length} 缺=${missing.length}${missing.length ? '（例：' + missing.slice(0, 3).map(r => r.key).join(', ') + '）' : ''}`)

  const IGNORE = new Set(['started_at', 'finished_at', 'host', 'run_id', 'agents', 'agent_count', 'total_input', 'total_output', 'total_cost'])
  const fieldDiffs: string[] = []
  const badDelta: string[] = []
  const badFinishedDelta: string[] = []
  let backfillPairs = 0
  const crossHostPairs: string[] = []
  const finishedAtExempt: string[] = []
  const finishedAtTimeoutExempt: string[] = []
  const finishedAtTolerated: string[] = []
  const outcomeDiff3Exempt: string[] = []
  const roundsExempt: string[] = []
  for (const r of a) {
    const o = bk.get(r.key)
    if (!o) continue
    const meta = outcomeMeta.get(r.key) ?? { outcome_source: null, outcome_tier: null }
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

    // finished_at：獨立於通用逐欄迴圈之外處理（同 started_at 的位置與理由，見
    // FINISHED_AT_TOLERANCE_MS 說明）。三層判斷依序試：既有的 tracker_reconcile
    // 永久性豁免 → D36 的 timeout 整列豁免 → head-host 容差 → 其餘真差異。
    {
      const sVal = r.finished_at ?? null
      const mVal = (o as any).finished_at ?? null
      if (JSON.stringify(sVal) !== JSON.stringify(mVal)) {
        if (isFinishedAtExempt(meta.outcome_source)) {
          finishedAtExempt.push(`${r.key}（outcome_source=${meta.outcome_source}）`)
        } else if (r.outcome === 'timeout') {
          finishedAtTimeoutExempt.push(`${r.key}：sqlite=${JSON.stringify(sVal)} mysql=${JSON.stringify(mVal)}`)
        } else if (host === 'head' && sVal !== null && mVal !== null) {
          const fDelta = Date.parse(mVal as string) - Date.parse(sVal as string)
          observedMaxFinishedDelta = Math.max(observedMaxFinishedDelta, fDelta)
          if (fDelta < 0 || fDelta > FINISHED_AT_TOLERANCE_MS) {
            badFinishedDelta.push(`${r.key} Δ=${fDelta}ms`)
          } else {
            finishedAtTolerated.push(`${r.key} Δ=${fDelta}ms`)
          }
        } else {
          // 非 head 配對，或一邊為 null 一邊有值：不在本容差適用範圍內，維持嚴格判定。
          fieldDiffs.push(`${r.key}.finished_at: sqlite=${JSON.stringify(sVal)} mysql=${JSON.stringify(mVal)}`)
        }
      }
    }

    // rounds 出窗方向敏感豁免（§9.3）：以這一筆 run 的 finished_at 判斷是否出窗。
    // 執行中的 run（finished_at 為 null）不適用——交給自然收斂，不是本豁免的範圍。
    const finishedAtMs = (o as any).finished_at ? Date.parse((o as any).finished_at) : null
    const outOfWindow = roundsWindowMs !== null && finishedAtMs !== null && finishedAtMs < now - roundsWindowMs
    for (const col of Object.keys(r)) {
      if (IGNORE.has(col)) continue
      const sVal = (r as any)[col] ?? null
      const mVal = (o as any)[col] ?? null
      if (JSON.stringify(sVal) === JSON.stringify(mVal)) continue
      if (col === 'outcome' && isOutcomeDifference3Exempt(sVal, meta.outcome_tier)) {
        outcomeDiff3Exempt.push(`${r.key}: sqlite=${JSON.stringify(sVal)} mysql=${JSON.stringify(mVal)}（tier=${meta.outcome_tier}）`)
        continue
      }
      if ((col === 'review_rounds' || col === 'final_review_rounds') && isRoundsExempt(sVal, mVal, outOfWindow)) {
        roundsExempt.push(`${r.key}.${col}: sqlite=${sVal} mysql=NULL（出窗）`)
        continue
      }
      fieldDiffs.push(`${r.key}.${col}: sqlite=${JSON.stringify(sVal)} mysql=${JSON.stringify(mVal)}`)
    }
  }
  judge(badDelta.length === 0,
    `C5 runs.started_at 在容差內（0 ≤ Δ ≤ ${STARTED_AT_TOLERANCE_MS}ms，Δ = mysql − sqlite，僅 host='head' 配對）`,
    `實測最大 Δ=${Number.isFinite(observedMaxDelta) ? observedMaxDelta + 'ms' : "n/a（無 host='head' 交集樣本）"}` +
      `｜回填列已排除 ${backfillPairs} 筆（Δ≡0 by construction）` +
      (badDelta.length ? ` 逾差：${badDelta.slice(0, 3).join('; ')}` : ''))
  judge(badFinishedDelta.length === 0,
    `C5 runs.finished_at 在容差內（0 ≤ Δ ≤ ${FINISHED_AT_TOLERANCE_MS}ms，Δ = mysql − sqlite，僅 host='head' 且 outcome≠'timeout' 配對）`,
    `實測最大 Δ=${Number.isFinite(observedMaxFinishedDelta) ? observedMaxFinishedDelta + 'ms' : "n/a（無符合資格樣本）"}` +
      (badFinishedDelta.length ? ` 逾差：${badFinishedDelta.slice(0, 3).join('; ')}` : ''))
  // 非 head 配對是 key 碰撞的訊號，不靜靜跳過。
  judge(crossHostPairs.length === 0,
    "C5b 沒有 host≠'head' 的配對（head 的 sqlite 結構上只有本機 run，配到別台＝legacy_key 撞了）",
    crossHostPairs.length ? crossHostPairs.slice(0, 3).join('; ') : '')
  judge(fieldDiffs.length === 0, 'C5 runs 其餘每一欄逐字相等',
    fieldDiffs.length ? fieldDiffs.slice(0, 4).join(' | ') : '')
  // 豁免與容差內差異逐列印出，不靜默（每一條都是日後可能吞掉真差異的地方）。
  if (finishedAtExempt.length) console.log(`[EXEMPT] C5 finished_at（outcome_source=tracker_reconcile，共 ${finishedAtExempt.length} 筆）：${finishedAtExempt.slice(0, 10).join('; ')}`)
  if (finishedAtTimeoutExempt.length) console.log(`[EXEMPT] C5 finished_at（outcome=timeout，a7-D36 §2.3 條件3，共 ${finishedAtTimeoutExempt.length} 筆）：${finishedAtTimeoutExempt.slice(0, 10).join('; ')}`)
  if (finishedAtTolerated.length) console.log(`[TOLERATED] C5 finished_at 容差內差異（共 ${finishedAtTolerated.length} 筆，非靜默僅供追蹤）：${finishedAtTolerated.slice(0, 10).join('; ')}`)
  if (outcomeDiff3Exempt.length) console.log(`[EXEMPT] C5 outcome 差異3（sqlite 已 reconcile、mysql 仍 tier1，共 ${outcomeDiff3Exempt.length} 筆）：${outcomeDiff3Exempt.slice(0, 10).join('; ')}`)
  if (roundsExempt.length) console.log(`[EXEMPT] C5 rounds 出窗歷史殘差（共 ${roundsExempt.length} 筆）：${roundsExempt.slice(0, 10).join('; ')}`)
}

// C6 agent_runs
{
  const [a, b] = [await sqliteReader.allAgentRuns(), await mysqlReader.allAgentRuns()]
  warnDuplicateKeys(b, r => r.path, 'C6 mysql agent_runs.path')
  const bk = new Map(b.map(r => [r.path, r]))
  const missing = a.filter(r => !bk.has(r.path))
  judge(missing.length === 0, 'C6 sqlite 的每一筆 agent_run 在 mysql 都找得到',
    `sqlite=${a.length} mysql=${b.length} 缺=${missing.length}`)
  const IGNORE = new Set(['file_mtime', 'run_id', 'host'])
  const diffs: string[] = []
  const skeletonExempt: string[] = []
  const skeletonTooOld: string[] = []
  for (const r of a) {
    const o = bk.get(r.path)
    if (!o) continue
    // 骨架列豁免（§9.1）：mysql 未終態只寫骨架（payload 十欄全 NULL），這是
    // 兩軌「該不該早寫」的已接受分岔，不是寫入端缺陷。判別子直接對應
    // collector 自己的 terminal 定義。
    const skeleton = isSkeletonAgentRun({ ended_at: (o as any).ended_at ?? null, is_error: (o as any).is_error ?? 0 })
    if (skeleton) {
      const ageMs = now - Date.parse(r.started_at)
      skeletonExempt.push(`${r.path.split('/').pop()}（started_at=${r.started_at}，已停 ${Math.round(ageMs / 1000)}s）`)
      // 骨架列年齡超過 pipeline 可能持續的最長時間 ⇒ 不可能是合法地還在跑。
      if (createMrTimeoutSec !== null && ageMs > createMrTimeoutSec * 1000) {
        skeletonTooOld.push(`${r.path.split('/').pop()}：已停 ${Math.round(ageMs / 1000)}s > 上界 ${createMrTimeoutSec}s`)
      }
    }
    for (const col of Object.keys(r)) {
      if (IGNORE.has(col)) continue
      if (skeleton && SKELETON_EXEMPT_FIELDS.has(col)) continue
      // cost_usd 走 DECIMAL(12,6) 正規化：兩軌型別不同（sqlite REAL vs
      // mysql DECIMAL），逐字比會把已知的量化差報成資料不一致（實測假陽性）。
      const equal =
        col === 'cost_usd'
          ? costUsdEqual((r as any)[col], (o as any)[col])
          : JSON.stringify((r as any)[col] ?? null) === JSON.stringify((o as any)[col] ?? null)
      if (!equal) diffs.push(`${r.path.split('/').pop()}.${col}`)
    }
  }
  judge(diffs.length === 0, 'C6 agent_runs 逐欄相等（file_mtime 不比：collector 私有游標，刻意不進權威表；骨架列 payload 欄豁免見下）',
    diffs.length ? [...new Set(diffs)].slice(0, 6).join(', ') : '')
  judge(skeletonTooOld.length === 0, `C6 骨架列年齡未逾上界（${createMrTimeoutSec ?? 'n/a'}s，逾期＝結構上不可能合法還在跑）`,
    skeletonTooOld.length ? skeletonTooOld.slice(0, 5).join('; ') : '')
  if (skeletonExempt.length) console.log(`[EXEMPT] C6 骨架列 payload 欄豁免（共 ${skeletonExempt.length} 筆）：${skeletonExempt.slice(0, 10).join('; ')}`)
}

// C7 status_log：只在「兩軌都有資料」的時間窗內比對翻轉
//
// **統計基準要用 FULL，不能用 API 端點的預設 200**（Reviewer B MINOR-2）：
// 下面用 mysql 側「每個 service 的最早一列」當 collector 起步基準，若兩軌各
// 自只拿最近 200 筆折疊後的樣本，兩軌的截斷邊界不同（sqlite 是全服務共用
// 200、mysql 是折疊後 200），會系統性誤判起步基準。API 端點呼叫處
// （server.ts）維持原本的預設 200，不受此影響。
{
  const [a, b] = [await sqliteReader.statusLog(undefined, FULL), await mysqlReader.statusLog(undefined, FULL)]
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
      const r = judgeWriteSideField(b, { field: g.field, requireFinished: g.requireFinished, eligible: (g as any).eligible })
      judge(r.ok, `D ${g.field} 寫入端已接`, `${r.detail}｜負責：${g.owner}｜${g.note}`)
    }
  }
}

// ═════════════════════ S. 單軌自洽性檢查（Phase 9 §3.1，a7-D38 核定方向）═════════════════════
// 與 sqlite 完全無關——對照來源是檔案系統事實（DISPATCHER_LOG_DIR / AGENT_TRACE_DIR）
// 與 mysql 自己，sqlite collector 退役後仍然成立。**新增，與 C 組並存顯示，不取代**
// （使用者 2026-09-04 裁定：現在就接線，7 天觀察期後退役時只需把 C 組拿掉）。
// 完整設計見 monitor-db-project-docs/phase9-single-track-design-62.md。
console.log('\n═══ S. 單軌自洽性檢查（不依賴 sqlite，phase9-single-track-design-62.md）═══')
{
  // S1：DISPATCHER_LOG_DIR 的 pipeline stdout log 清單 ⇔ runs.legacy_key。
  const fsSnapshotAtMs1 = Date.now()
  const fsLogs = collectFsRunLogs(readdirSync(DISPATCHER_LOG_DIR))
  const s1 = judgeRunCoverage(fsLogs, gateRuns, { dbSnapshotAtMs: gateRunsSnapshotAtMs, fsSnapshotAtMs: fsSnapshotAtMs1 })
  judge(s1.missingInDb.length === 0, 'S1 runs 覆蓋率：log 檔案 → runs 無漏收（取代 C4）',
    `counted fs=${s1.counted.fs} db=${s1.counted.db}` + (s1.missingInDb.length ? `｜缺：${s1.missingInDb.slice(0, 5).join(', ')}` : ''))
  judge(s1.ghostInDb.length === 0, 'S1 runs 覆蓋率：runs → log 檔案無幽靈列',
    s1.ghostInDb.length ? s1.ghostInDb.slice(0, 5).join(', ') : '')
  judge(s1.undatedRows.length === 0, 'S1 runs 無法定位的孤兒列（legacy_key/started_at 為 NULL，兩軌對照結構性看不到）',
    s1.undatedRows.length ? s1.undatedRows.slice(0, 5).join(', ') : '')
  if (s1.deferredNewerThanDbSnapshot.length) console.log(`[DEFERRED] S1（晚於 DB 快照才開始，共 ${s1.deferredNewerThanDbSnapshot.length} 筆，不判紅）：${s1.deferredNewerThanDbSnapshot.slice(0, 5).join(', ')}`)
  if (s1.deferredNewerThanFsSnapshot.length) console.log(`[DEFERRED] S1（晚於 FS 快照才寫入，共 ${s1.deferredNewerThanFsSnapshot.length} 筆，不判紅）：${s1.deferredNewerThanFsSnapshot.slice(0, 5).join(', ')}`)

  // S2：agent trace / bug stdout 檔案清單 ⇔ agent_runs.path（取代 C6 覆蓋率一半，
  // 逐欄相等沒有單軌對應，是刻意的偵測力淨損失，見設計稿 §1）。
  const dirs = { dispatcherLogDir: DISPATCHER_LOG_DIR, agentTraceDir: AGENT_TRACE_DIR }
  const dispatcherTopLevel = readdirSync(DISPATCHER_LOG_DIR)
    .map(f => join(DISPATCHER_LOG_DIR, f))
    .filter(p => { try { return statSync(p).isFile() } catch { return false } })
  const agentTraceJson: string[] = []
  if (existsSync(AGENT_TRACE_DIR)) {
    for (const ticket of readdirSync(AGENT_TRACE_DIR)) {
      const ticketDir = join(AGENT_TRACE_DIR, ticket)
      let isDir = false
      try { isDir = statSync(ticketDir).isDirectory() } catch { isDir = false }
      if (!isDir) continue
      for (const f of readdirSync(ticketDir)) if (f.endsWith('.json')) agentTraceJson.push(join(ticketDir, f))
    }
  }
  const agentRunRows = (await mysqlReader.allAgentRuns()).map(r => ({ path: r.path, host: (r.host as string) ?? '', ended_at: r.ended_at, is_error: r.is_error }))
  // localHosts 明確帶 host + 回填哨兵（judgeAgentRunCoverage 的預設只有 ['head']，
  // 與 S1/S4 的 DEFAULT_LOCAL_HOSTS 不同，這裡要覆寫成一致）——回填列
  // （host='unknown_pre_migration'）對應的是真實存在的舊 trace/stdout 檔案，
  // 漏算會把 41 筆健康的回填列全部誤報成漏收（見設計稿 §2.2 的 counted{fs:89,db:84}）。
  const s2 = judgeAgentRunCoverage([...dispatcherTopLevel, ...agentTraceJson], agentRunRows, dirs, { localHosts: ['head', 'unknown_pre_migration'] })
  judge(s2.missingInDb.length === 0, 'S2 agent_runs 覆蓋率：trace/stdout 檔案 → agent_runs 無漏收（取代 C6 覆蓋率一半）',
    `counted fs=${s2.counted.fs} db=${s2.counted.db}` + (s2.missingInDb.length ? `｜缺：${s2.missingInDb.slice(0, 5).join(', ')}` : ''))
  judge(s2.foreignPaths.length === 0, 'S2 agent_runs.path 無不合法來源（寫入端沒有寫它不該寫的東西）',
    s2.foreignPaths.length ? s2.foreignPaths.slice(0, 5).join(', ') : '')
  if (s2.ghostInDb.length) console.log(`[EXEMPT] S2 幽靈列（檔案已被 cleanup-worktree 清掉，正常結局，不判紅，共 ${s2.ghostInDb.length} 筆）：${s2.ghostInDb.slice(0, 3).join(', ')}`)

  // S4：runs 單列欄位自洽（legacy_key / stdout_path / started_at 三者互為可逆推導）。
  const s4 = judgeLegacyKeyCoherence(gateRuns)
  judge(s4.keyPathMismatch.length === 0, 'S4 legacy_key 與 stdout_path 自洽（新判準，兩軌時代看不見）',
    s4.keyPathMismatch.length ? s4.keyPathMismatch.slice(0, 5).join(', ') : '')
  judge(s4.keyStartedAtMismatch.length === 0, `S4 legacy_key 內嵌時間戳與 started_at 在容差內（0 ≤ Δ ≤ ${KEY_TO_STARTED_AT_TOLERANCE_MS}ms，與 C5 started_at 同一物理量）`,
    s4.keyStartedAtMismatch.length ? s4.keyStartedAtMismatch.slice(0, 5).join(', ') : (s4.observedMaxDeltaMs === null ? '無樣本' : `實測最大 Δ=${s4.observedMaxDeltaMs}ms`))
  judge(s4.duplicateKeys.length === 0, 'S4 同 host 下 legacy_key 無重複（idx_legacy_key 非 UNIQUE，等價 C5b）',
    s4.duplicateKeys.length ? s4.duplicateKeys.slice(0, 5).join(', ') : '')
  judge(s4.orphanRows.length === 0, 'S4 無孤兒列（lifecycle_rank≥30 但 stdout_path/started_at 為 NULL，兩軌對照結構性看不到）',
    s4.orphanRows.length ? s4.orphanRows.slice(0, 3).join('; ') : '')

  // S6：retry/resume 血緣自洽（新判準，phase9-readiness.md §1.3 缺口2，sqlite 無此概念、
  // 兩軌對照定義上不可能檢查）。
  const s6 = judgeRetryLineage(gateRuns)
  judge(s6.dangling.length === 0 && s6.ticketMismatch.length === 0 && s6.notLaterThanParent.length === 0 && s6.cycles.length === 0 && s6.forkedParents.length === 0,
    `S6 retry_of_run_id 血緣自洽（共 ${s6.counted.withLineage}/${s6.counted.total} 筆有血緣）`,
    [
      s6.dangling.length ? `dangling ${s6.dangling.length}` : '',
      s6.ticketMismatch.length ? `ticketMismatch ${s6.ticketMismatch.length}` : '',
      s6.notLaterThanParent.length ? `notLaterThanParent ${s6.notLaterThanParent.length}` : '',
      s6.cycles.length ? `cycles ${s6.cycles.length}` : '',
      s6.forkedParents.length ? `forkedParents ${s6.forkedParents.length}` : '',
    ].filter(Boolean).join('｜') || (s6.counted.withLineage === 0 ? '目前零真實樣本，這格從未被觸發過（a7-D14）' : ''))
  if (s6.unexpectedParentOutcome.length) console.log(`[WARN] S6 父列 outcome 不在自動重試值域內（手動重試值域不封閉，只列不判紅，共 ${s6.unexpectedParentOutcome.length} 筆）：${s6.unexpectedParentOutcome.slice(0, 3).join('; ')}`)

  // S9：service_status_log 排序自洽性（a7-D43 修法的可重跑健康信號，非一次性
  // 回歸測試——見 single-track-consistency.ts 的 judgeStatusLogOrderSelfConsistency
  // 檔頭：D43 在今天的資料上是 no-op，這一格讓「現在有沒有動搖」變成每次都能
  // 重新問一次的問題）。
  const s9 = judgeStatusLogOrderSelfConsistency(gateStatusLog)
  judge(s9.flipCountMismatch.length === 0, `S9 status_log 折疊翻轉數：ts,id 序與 id 序一致（共 ${s9.checked} 筆原始列）`,
    s9.flipCountMismatch.length ? s9.flipCountMismatch.slice(0, 5).join('; ') : '')
  judge(s9.lastChangeMismatch.length === 0, 'S9 lastStatusChanges：ts,id 序與 id 序選中同一列（總覽卡片顯示值不受排序影響）',
    s9.lastChangeMismatch.length ? s9.lastChangeMismatch.slice(0, 5).join('; ') : '')
}

} catch (e) {
  // C/D 組任何一格中途拋出例外（最典型：mysql 側 FULL 查詢撞
  // READ_QUERY_TIMEOUT_MS 逾時 throw）—— 印出結構化的 [FAIL]（含原始錯誤
  // 訊息），不讓例外裸露成 unhandled rejection；已經跑過的格子計數保留，
  // 往下仍會印出「結論」列（Reviewer B MINOR-4b）。
  fail('C/D 組完整跑完（沒有中途拋出例外）', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
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
