/**
 * Toolsmith 分頁專屬格式化 helper。對應舊版 index.html:618-629
 * （`TS_STATUS_LABEL`、`tsStatusPill()`、`tsGatePills()`）。
 *
 * 分頁專屬、不放共用層——契約 `02-frontend-contract.md` §5 明確把
 * `tsStatusPill()` / `tsGatePills()` 列為「分頁專屬」。
 */
import type { ToolsmithGate, ToolsmithStatus } from '../../api/types'
import type { PillVariant } from '../../lib/format'

/** 狀態中文標籤。對應舊版 index.html:618 `TS_STATUS_LABEL`。 */
export const TS_STATUS_LABEL: Record<ToolsmithStatus, string> = {
  queued: '排隊中',
  researching: '研究/寫代碼中',
  needs_clarification: '待澄清',
  deploying: '部署中',
  done: '完成',
  failed: '失敗',
}

/** 狀態徽章文字。對應舊版 `tsStatusPill()` 的 label 部分（index.html:619-621）。 */
export function tsStatusLabel(status: ToolsmithStatus): string {
  return TS_STATUS_LABEL[status] ?? status
}

/**
 * 狀態徽章顏色。對應舊版 `tsStatusPill()`（index.html:619-625）：
 * `done` → 綠（ok）；`failed` → 紅（bad）；`needs_clarification` → 橘（warn）；
 * 其餘（`queued`/`researching`/`deploying`，仍在跑）→ 橘（warn）。
 */
export function tsStatusVariant(status: ToolsmithStatus): PillVariant {
  if (status === 'done') return 'ok'
  if (status === 'failed') return 'bad'
  return 'warn' // needs_clarification / queued / researching / deploying
}

/** 部署關卡 pill 顏色。對應舊版 `tsGatePills()`（index.html:626-629）：pass→綠、fail→紅、pending→無色。 */
export function tsGateVariant(status: ToolsmithGate['status']): PillVariant {
  if (status === 'pass') return 'ok'
  if (status === 'fail') return 'bad'
  return 'default'
}

/** 部署關卡 pill 內文符號。pass→✓、fail→✗、pending→…。 */
export function tsGateSymbol(status: ToolsmithGate['status']): string {
  if (status === 'pass') return '✓'
  if (status === 'fail') return '✗'
  return '…'
}
