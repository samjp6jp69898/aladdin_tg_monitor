import { describe, expect, test } from 'bun:test'
import { resolveReadSource } from './source.ts'

describe('resolveReadSource（MON_READ_SOURCE 的回滾槓桿）', () => {
  test('未設 / 空字串 / 只有空白 → sqlite（預設，行為與遷移前相同）', () => {
    expect(resolveReadSource(undefined)).toBe('sqlite')
    expect(resolveReadSource('')).toBe('sqlite')
    expect(resolveReadSource('   ')).toBe('sqlite')
  })

  test('明確寫 sqlite → sqlite；大小寫不敏感', () => {
    expect(resolveReadSource('sqlite')).toBe('sqlite')
    expect(resolveReadSource('SQLite')).toBe('sqlite')
  })

  test('mysql → mysql；大小寫不敏感', () => {
    expect(resolveReadSource('mysql')).toBe('mysql')
    expect(resolveReadSource('MySQL')).toBe('mysql')
  })

  test('run-monitor.sh 的 grep|cut 匯出手法會帶到尾隨空白，必須被容忍', () => {
    expect(resolveReadSource('mysql ')).toBe('mysql')
    expect(resolveReadSource(' mysql\t')).toBe('mysql')
  })

  test('打錯字一律退回 sqlite，不 throw——這是回滾按鈕，代價必須是退回舊行為而不是整個起不來', () => {
    expect(resolveReadSource('mysq')).toBe('sqlite')
    expect(resolveReadSource('postgres')).toBe('sqlite')
    expect(resolveReadSource('1')).toBe('sqlite')
  })
})
