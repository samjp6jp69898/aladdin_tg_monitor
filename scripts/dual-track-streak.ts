// scripts/dual-track-streak.ts — 讀 monitor-dual-track.log，算「連續達標」天數
// （phase9-readiness.md §6.3，a7-D37：達標定義要寫死，不能是「看起來還行」）。
//
// 達標定義：**連續 7 天 exit_code 全 0（全綠）**。中斷即重算——不接受「只有一天
// 紅、忽略它」；日期出現斷層（該天沒有記錄）同樣視為中斷。
// 不需要今天就有 7 天資料，只要邏輯正確、之後累積夠了能正確判斷即可（§6 交付要求）。
//
// 只讀 log 檔，不連任何 DB、不寫任何東西。

import { existsSync, readFileSync } from 'node:fs'

export interface DualTrackLogEntry {
  date: string
  exit_code: number
  [key: string]: unknown
}

/** 逐行解析 JSON log；壞行（非 JSON、缺必要欄位）略過但不拋錯。 */
export function parseLogLines(content: string): DualTrackLogEntry[] {
  const entries: DualTrackLogEntry[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (typeof obj?.date === 'string' && typeof obj?.exit_code === 'number') entries.push(obj)
    } catch {
      // 壞行跳過：log 是 append-only 結構化格式，壞行代表寫入意外中斷
      // （例如行程被殺在 JSON.stringify 中途），不是本函式要處理的錯誤。
    }
  }
  return entries
}

export interface StreakResult {
  streakDays: number
  met: boolean
  lastDate: string | null
}

/**
 * 由最新日期往回掃，遇到第一個 `exit_code !== 0` 或日期斷層就停止。
 * 同一天有多筆記錄（例如手動重跑）時，取當天**最後一筆**——log 是 append-only，
 * 後面的行覆蓋前面的判定。
 */
export function computeStreak(entries: DualTrackLogEntry[], requiredDays = 7): StreakResult {
  if (entries.length === 0) return { streakDays: 0, met: false, lastDate: null }

  const byDate = new Map<string, DualTrackLogEntry>()
  for (const e of entries) byDate.set(e.date, e) // 依 append 順序覆蓋，最後一筆生效

  const dates = [...byDate.keys()].sort() // YYYY-MM-DD 字串排序＝時間排序
  let streak = 0
  let expected: number | null = null
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i]
    const entry = byDate.get(d)!
    const curMs = Date.parse(d + 'T00:00:00Z')
    if (expected !== null && curMs !== expected) break // 日期不連續：中斷，之前累積的不算
    if (entry.exit_code !== 0) break // 當天紅：中斷
    streak++
    expected = curMs - 86_400_000
  }
  return { streakDays: streak, met: streak >= requiredDays, lastDate: dates[dates.length - 1] }
}

export function readStreakFromFile(logPath: string, requiredDays = 7): StreakResult {
  if (!existsSync(logPath)) return { streakDays: 0, met: false, lastDate: null }
  return computeStreak(parseLogLines(readFileSync(logPath, 'utf8')), requiredDays)
}

if (import.meta.main) {
  const logPath = process.argv[2] ?? '/Users/user/aladdin/telegram-dispatcher/logs/monitor-dual-track.log'
  const result = readStreakFromFile(logPath)
  console.log(JSON.stringify(result))
  process.exit(result.met ? 0 : 1)
}
