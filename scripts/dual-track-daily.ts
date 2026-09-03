// scripts/dual-track-daily.ts — Phase 9 七天雙軌觀察排程（phase9-readiness.md §6，
// 缺口 3，a7-D37：「應在切換當天就開始，不是切換之後才想」）。
//
// **內容 = 現行 C 組，不另寫一支**：直接子行程呼叫 scripts/switch-readiness.ts
// 完整版（不加 --skip-slow——B 組含 §8.2 前置關卡與 27 項端點行為，全模式才是
// §10.2 的可執行版本；--skip-slow 是給互動除錯用的捷徑，不是給觀察期用的）。
// 重複實作比對邏輯會產生第二份判準，違反單一來源（§6.1）。
//
// 每天一次、append 一行結構化 JSON 到 telegram-dispatcher/logs/monitor-dual-track.log
// （落點在 telegram-dispatcher 不是 tg-monitor：只有前者 .gitignore 有 `logs/` 規則，
// tg-monitor 沒有，寫在這邊會被 git 追蹤）。每行含：日期、exit code、未過項清單、
// started_at/finished_at 實測最大 Δ（§6.2——逐日保留 Δ 是重點：§2.3 的容差常數要
// 靠它才定得出來）。
//
// **不做的事（§6.4）**：不自動切換、不自動退役、不改任何資料。純觀察，只 append。
//
// 排程載體：launchd（com.aladdin.tg-monitor-dual-track.plist），每天一次。
// **不掛進 doctor 巡檢**——doctor 的契約是「不做任何寫入」（a7-D2），這支要寫 log
// 檔，硬性區隔。
//
// **可測試性**：實際呼叫的指令由 DUAL_TRACK_READINESS_CMD（JSON 陣列字串）覆寫，
// 預設 ["bun","run","scripts/switch-readiness.ts"]；log 路徑與 cwd 同樣可由
// DUAL_TRACK_LOG_PATH / DUAL_TRACK_CWD 覆寫。scripts/dual-track-daily.test.ts 用這組
// 掛鉤做負面測試（D14）——不改動 switch-readiness.ts 本身來偽造失敗。

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
export const DEFAULT_LOG_PATH = '/Users/user/aladdin/telegram-dispatcher/logs/monitor-dual-track.log'
export const DEFAULT_CMD = ['bun', 'run', 'scripts/switch-readiness.ts']

export interface ReadinessRunResult {
  exitCode: number
  output: string
  durationMs: number
}

/** 子行程跑 switch-readiness.ts（或測試用的替身指令），回傳合併輸出與耗時。 */
export async function runReadinessCheck(cmd: string[], cwd: string): Promise<ReadinessRunResult> {
  const started = Date.now()
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const exitCode = await p.exited
  return { exitCode: exitCode ?? 1, output: stdout + stderr, durationMs: Date.now() - started }
}

/**
 * 從 switch-readiness.ts 的輸出擷取 `[FAIL]` 項目清單與 started_at/finished_at
 * 實測最大 Δ。純函式，不連任何行程或 DB，可單元測試。
 *
 * `[FAIL]` 行格式固定為 `[FAIL]   <label>  — <detail>`（label 與 detail 之間是
 * 兩個以上空白 + em dash）；沒有 detail 的行也要抓到 label。
 */
export function parseReadinessOutput(output: string): {
  failedItems: string[]
  startedAtMaxDeltaMs: number | null
  finishedAtMaxDeltaMs: number | null
} {
  const lines = output.split('\n')
  const failedItems: string[] = []
  for (const line of lines) {
    const m = /^\[FAIL\]\s+(.+?)(?:\s{2,}—.*)?$/.exec(line)
    if (m) failedItems.push(m[1].trim())
  }
  const extractDelta = (needle: string): number | null => {
    const line = lines.find(l => l.includes(needle))
    if (!line) return null
    const m = /實測最大\s*Δ=(\d+)ms/.exec(line)
    return m ? Number(m[1]) : null
  }
  return {
    failedItems,
    startedAtMaxDeltaMs: extractDelta('C5 runs.started_at'),
    finishedAtMaxDeltaMs: extractDelta('C5 runs.finished_at'),
  }
}

export interface DualTrackLogEntry {
  date: string
  timestamp: string
  exit_code: number
  ok: boolean
  failed_items: string[]
  started_at_max_delta_ms: number | null
  finished_at_max_delta_ms: number | null
  duration_ms: number
}

export function buildLogEntry(result: ReadinessRunResult, now = new Date()): DualTrackLogEntry {
  const parsed = parseReadinessOutput(result.output)
  return {
    date: now.toISOString().slice(0, 10),
    timestamp: now.toISOString(),
    exit_code: result.exitCode,
    ok: result.exitCode === 0,
    failed_items: parsed.failedItems,
    started_at_max_delta_ms: parsed.startedAtMaxDeltaMs,
    finished_at_max_delta_ms: parsed.finishedAtMaxDeltaMs,
    duration_ms: result.durationMs,
  }
}

/** append 一行 JSON；目錄不存在就建立。只 append，不覆寫、不刪既有內容。 */
export function appendLogEntry(logPath: string, entry: DualTrackLogEntry): void {
  const dir = dirname(logPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(logPath, JSON.stringify(entry) + '\n')
}

async function main() {
  const cmdOverride = process.env.DUAL_TRACK_READINESS_CMD
  const cmd: string[] = cmdOverride ? JSON.parse(cmdOverride) : DEFAULT_CMD
  const logPath = process.env.DUAL_TRACK_LOG_PATH ?? DEFAULT_LOG_PATH
  const cwd = process.env.DUAL_TRACK_CWD ?? REPO

  const result = await runReadinessCheck(cmd, cwd)
  const entry = buildLogEntry(result)
  appendLogEntry(logPath, entry)

  console.log(
    `[dual-track] ${entry.date} exit=${entry.exit_code} ok=${entry.ok} ` +
    `failed=${entry.failed_items.length} startedΔ=${entry.started_at_max_delta_ms}ms ` +
    `finishedΔ=${entry.finished_at_max_delta_ms}ms duration=${entry.duration_ms}ms`,
  )
  console.log(`[dual-track] appended to ${logPath}`)

  // wrapper 本身的退出碼延續 switch-readiness.ts 的退出碼：launchd 的
  // StandardErrorPath / exit status 才能反映當天是否真的紅，不吞成 always-0。
  process.exit(result.exitCode)
}

if (import.meta.main) {
  main()
}
