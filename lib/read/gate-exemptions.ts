// lib/read/gate-exemptions.ts — switch-readiness.ts 的 C5/C6 豁免判準（純函式）。
//
// **為什麼獨立成檔**：switch-readiness.ts 是一支腳本，模組頂層會直接連監控 DB、
// 印結果、`process.exit()`——import 它會把整個擋門當成副作用跑一次。這些判準是
// 純函式，本身該可以被單元測試安全 import，所以拆出來，不碰 db.ts、不連任何 DB。
//
// phase9-readiness.md §9.1/§9.2/§9.3，a7 核准；b5 設計、97 更正、
// aladdin-1d 派工實作，2026-09-03。每一條豁免都必須計數並逐列印出，不靜默——
// 這是本專案的硬性風格：豁免面越小越好，每一條都是日後可能吞掉真差異的地方。

/**
 * 從原始碼裡讀一個 `const NAME = <純算術運算式>` 的值（switch-readiness.ts 已在用
 * 的模式：A 組讀 `run-monitor.sh`、B2 比對 `server.ts`）。**讀不到就回 null，
 * 呼叫端必須判 FAIL、不給預設值**——給預設值的話，常數被改名或刪掉之後，
 * 這條防線會安靜地換成一個沒有人決定過的門檻（a7-D55 的形狀）。
 * 運算式只允許數字與 `+ - * ( )`，其餘字元一律視為讀取失敗（不 eval 任意碼）。
 */
export function extractIntConstant(src: string, constName: string): number | null {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*([0-9+\\-*()\\s]+)`)
  const m = re.exec(src)
  if (!m) return null
  const expr = m[1].trim()
  if (!/^[0-9+\-*()\s]+$/.test(expr)) return null
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${expr});`)()
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** agent_runs 骨架列的判別子（§9.1）：直接對應 collector 自己的 terminal 定義
 * （`agent-runs-collector.ts` 的 `terminal = endedAt !== null || errorObj !== null`），
 * 不在讀取端重新定義——兩邊各自定義一定會漂移。 */
export function isSkeletonAgentRun(mysqlRow: { ended_at: string | null; is_error: number }): boolean {
  return mysqlRow.ended_at === null && !mysqlRow.is_error
}

/** C6 骨架列豁免只涵蓋 payload 欄；非 payload 欄仍須逐欄相等。 */
export const SKELETON_EXEMPT_FIELDS = new Set([
  'ended_at', 'model', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_create_tokens', 'cost_usd', 'num_turns', 'tool_calls', 'result_preview',
])

/** C5 `finished_at` 豁免（§9.2-1）：mon_ui 無 `finished_at` 的 UPDATE 授權，
 * W6 reconcile 只能改 outcome/outcome_source，不改 finished_at。 */
export function isFinishedAtExempt(outcomeSource: string | null): boolean {
  return outcomeSource === 'tracker_reconcile'
}

/** C5 outcome「差異 3」豁免（§9.2-2）：sqlite 轉 recovered/人工判定，
 * mysql 停在 tier 1（依設計不被 W6 reconcile）。 */
const OUTCOME_TIER1_SQLITE_SHAPES = new Set(['recovered', 'failed（人工判定）', 'needs_qa_clarification（人工判定）'])
export function isOutcomeDifference3Exempt(sqliteOutcome: string | null, mysqlOutcomeTier: number | null): boolean {
  return sqliteOutcome !== null && OUTCOME_TIER1_SQLITE_SHAPES.has(sqliteOutcome) && mysqlOutcomeTier === 1
}

/**
 * rounds 兩欄（review_rounds/final_review_rounds）出窗歷史殘差的方向敏感豁免
 * （§9.3，97 提出、b5 採納）。**只豁免一個方向**：
 *   - 出窗 且 sqlite=N 且 mysql=NULL → 豁免（mysql 的窗限，by construction）
 *   - 出窗 且 sqlite=NULL 且 mysql=N → 不豁免（sqlite 無窗，這個形狀是「sqlite
 *     寫入端又死了」的偵測訊號——97 剛證明它能死 20 小時沒人發現）
 * `outOfWindow` 由呼叫端依 `finished_at` 與 `ROUNDS_MON_DB_RECENT_WINDOW_MS`
 * 算好傳入（執行中的 run 沒有 finished_at，不適用本豁免，交給自然收斂）。
 */
export function isRoundsExempt(sqliteVal: number | null, mysqlVal: number | null, outOfWindow: boolean): boolean {
  return outOfWindow && sqliteVal !== null && mysqlVal === null
}

/**
 * `outcome_source` 已知值域（2026-09-03 全庫 grep 逐一 file:line 核對，非窮盡
 * 防線——新值會持續出現，97 一小時內就從 12 個變 13 個）。**集合外的值只 WARN
 * 列出，不靜默歸類、不判 FAIL**（與豁免要會叫同構）。
 */
export const KNOWN_OUTCOME_SOURCES = new Set([
  'backfill', 'tracker_reconcile', 'run-demand-pipeline-finalize', 'post-run-demand-trap',
  'stale-lock-reaper', 'spawn-detached-error', 'spawn-no-pid', 'spawn-sync-exception',
  'backlog-dispatch', 'pipeline-queue-skip', 'post-run-notify', 'local-sweeper', 'restart-sweep',
  'cancel_late_fix',
])
