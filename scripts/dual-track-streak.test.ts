// scripts/dual-track-streak.test.ts — computeStreak 的判定邏輯（不連 DB、不連檔案）。
import { describe, expect, test } from 'bun:test'
import { computeStreak, parseLogLines } from './dual-track-streak.ts'

function entry(date: string, exit_code: number) {
  return { date, exit_code }
}

describe('parseLogLines', () => {
  test('解析多行 JSON', () => {
    const content = `${JSON.stringify(entry('2026-09-01', 0))}\n${JSON.stringify(entry('2026-09-02', 1))}\n`
    expect(parseLogLines(content)).toEqual([entry('2026-09-01', 0), entry('2026-09-02', 1)])
  })

  test('壞行略過、不拋錯', () => {
    const content = `not json\n${JSON.stringify(entry('2026-09-01', 0))}\n{"date":"x"}\n`
    expect(parseLogLines(content)).toEqual([entry('2026-09-01', 0)])
  })

  test('空檔回空陣列', () => {
    expect(parseLogLines('')).toEqual([])
  })
})

describe('computeStreak', () => {
  test('空 log：未達標', () => {
    expect(computeStreak([])).toEqual({ streakDays: 0, met: false, lastDate: null })
  })

  test('連續 7 天全綠：達標', () => {
    const dates = ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03']
    const entries = dates.map(d => entry(d, 0))
    const result = computeStreak(entries)
    expect(result).toEqual({ streakDays: 7, met: true, lastDate: '2026-09-03' })
  })

  test('連續 6 天全綠：未達標（差一天）', () => {
    const dates = ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03']
    const entries = dates.map(d => entry(d, 0))
    const result = computeStreak(entries)
    expect(result.streakDays).toBe(6)
    expect(result.met).toBe(false)
  })

  test('中間有一天紅：streak 從紅天之後重新算，不因「只紅一天」被忽略', () => {
    const entries = [
      entry('2026-08-25', 0), entry('2026-08-26', 0), entry('2026-08-27', 0),
      entry('2026-08-28', 1), // 紅
      entry('2026-08-29', 0), entry('2026-08-30', 0), entry('2026-08-31', 0),
      entry('2026-09-01', 0), entry('2026-09-02', 0), entry('2026-09-03', 0),
    ]
    // 紅天之後到今天只有 6 天（08-29 ~ 09-03 共 6 天），未達標
    const result = computeStreak(entries)
    expect(result.streakDays).toBe(6)
    expect(result.met).toBe(false)
  })

  test('日期斷層（漏了一天沒跑）：視為中斷', () => {
    const entries = [
      entry('2026-08-25', 0), entry('2026-08-26', 0),
      // 08-27 缺記錄
      entry('2026-08-28', 0), entry('2026-08-29', 0), entry('2026-08-30', 0),
      entry('2026-08-31', 0), entry('2026-09-01', 0),
    ]
    const result = computeStreak(entries)
    // 由最新往回數：09-01 ~ 08-28 共 5 天連續，08-27 缺，斷在那裡
    expect(result.streakDays).toBe(5)
    expect(result.met).toBe(false)
  })

  test('今天紅：streak 歸零', () => {
    const entries = [
      entry('2026-08-27', 0), entry('2026-08-28', 0), entry('2026-08-29', 0),
      entry('2026-08-30', 0), entry('2026-08-31', 0), entry('2026-09-01', 0),
      entry('2026-09-02', 1), // 今天紅
    ]
    const result = computeStreak(entries)
    expect(result.streakDays).toBe(0)
    expect(result.met).toBe(false)
    expect(result.lastDate).toBe('2026-09-02')
  })

  test('同一天多筆：取最後一筆（重跑修正判定）', () => {
    const entries = [
      entry('2026-08-28', 0), entry('2026-08-29', 0), entry('2026-08-30', 0),
      entry('2026-08-31', 0), entry('2026-09-01', 0), entry('2026-09-02', 0),
      entry('2026-09-03', 1), // 第一次跑：紅
      entry('2026-09-03', 0), // 手動重跑：綠——應以這筆為準
    ]
    const result = computeStreak(entries)
    expect(result.streakDays).toBe(7)
    expect(result.met).toBe(true)
  })

  test('requiredDays 可覆寫（例如驗證邏輯本身，不必真的等 7 天）', () => {
    const entries = [entry('2026-09-01', 0), entry('2026-09-02', 0), entry('2026-09-03', 0)]
    expect(computeStreak(entries, 3).met).toBe(true)
    expect(computeStreak(entries, 4).met).toBe(false)
  })
})
