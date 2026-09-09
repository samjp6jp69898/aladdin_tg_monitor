/**
 * Pipelines 分頁專屬格式化 helper。
 *
 * 分頁專屬、不放共用層——outcome 的語意跟 EventsPage 用的「result」（見
 * `ResultBadge`/`resultPillVariant`，lib/format.ts）是完全不同的兩套值域，
 * 不可混用同一顆顏色函式：`resultPillVariant` 只認 success/recovered→綠、
 * 其餘一律紅，pipeline outcome 直接借用它會讓 `analysis_done` 這種非成功也
 * 非失敗的中性結果被誤判成紅色（2026-09-09 使用者回報，telegram-dispatcher/
 * lib/ops-ui 同一天也修過同類問題）。
 *
 * outcome 值域參考 telegram-dispatcher/lib/monitor-db/types.ts 的
 * KNOWN_OUTCOME_TIER（該檔註明非權威清單，仍可能有新值落入下面的 bad fallback）。
 */
import type { PillVariant } from '../../lib/format'

const OK = new Set(['success', 'already_fixed', 'recovered', 'already_satisfied'])
const INFO = new Set(['dispatched_to_worker'])
const DONE = new Set(['analysis_done'])
const WARN = new Set(['needs_qa_clarification', 'needs_clarification', 'i18n', 'insufficient_spec'])
const SKIP = new Set(['skipped', 'skipped_locked', 'skipped_expired'])

/**
 * outcome → pill 顏色：成功綠、進行中藍、分析完成紫、待澄清橘、略過灰，
 * 其餘（failed/timeout/infra_failure 等未列舉者）一律紅。
 * `cancelled` 不在這裡處理——PipelinesListView 沿用既有的 warn 特例。
 */
export function pipelineOutcomeVariant(outcome: string): PillVariant {
  if (OK.has(outcome)) return 'ok'
  if (INFO.has(outcome)) return 'info'
  if (DONE.has(outcome)) return 'done'
  if (WARN.has(outcome)) return 'warn'
  if (SKIP.has(outcome)) return 'default'
  return 'bad'
}
