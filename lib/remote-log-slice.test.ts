// lib/remote-log-slice.test.ts — task 1（2026-09-04）：`/api/log/tail`、
// `/api/log/since` host-aware 化用的記憶體內切片，純函式、不碰檔案系統。
import { describe, expect, test } from 'bun:test'
import { sinceRemoteLogContent, tailRemoteLogContent } from './remote-log-slice.ts'

describe('tailRemoteLogContent', () => {
  test('內容小於 maxBytes：整份回傳，size = 內容長度', () => {
    const r = tailRemoteLogContent('hello\nworld', 1024)
    expect(r.text).toBe('hello\nworld')
    expect(r.size).toBe(11)
  })

  test('內容大於 maxBytes：只取最後 maxBytes bytes，並丟掉第一個可能被截斷的半行', () => {
    const content = 'line1\nline2\nline3\n'
    // 取最後 8 bytes：'line3\n' 前面還帶一小段 'e2\n' 的殘餘——驗證會丟掉第一個半行。
    const r = tailRemoteLogContent(content, 8)
    expect(r.text).toBe('line3\n')
    expect(r.size).toBe(content.length)
  })

  test('start === 0（maxBytes 剛好 >= 內容長度）：不做半行截斷', () => {
    const content = 'line1\nline2\n'
    const r = tailRemoteLogContent(content, content.length)
    expect(r.text).toBe(content)
  })

  test('防禦上限 capBytes：內容超過上限時先從頭截斷，行為不崩潰、size 反映截斷後的長度', () => {
    const content = 'x'.repeat(1000)
    const r = tailRemoteLogContent(content, 100, 500) // capBytes=500 遠小於 1000
    expect(r.size).toBe(500)
    expect(r.text.length).toBe(100)
  })
})

describe('sinceRemoteLogContent', () => {
  test('offset === size：沒有新內容，回傳空字串、offset 不動', () => {
    const content = 'hello'
    const r = sinceRemoteLogContent(content, content.length)
    expect(r).toEqual({ text: '', offset: content.length })
  })

  test('offset < size：回傳自 offset 起的新增內容，offset 推進到新的位置', () => {
    const content = 'hello world'
    const r = sinceRemoteLogContent(content, 5)
    expect(r.text).toBe(' world')
    expect(r.offset).toBe(content.length)
  })

  test('offset > size（檔案被截斷/輪替）：重置為從頭讀', () => {
    const content = 'short'
    const r = sinceRemoteLogContent(content, 999)
    expect(r.text).toBe('short')
    expect(r.offset).toBe(content.length)
  })

  test('offset = 0：回傳整份內容', () => {
    const content = 'abc'
    const r = sinceRemoteLogContent(content, 0)
    expect(r.text).toBe('abc')
    expect(r.offset).toBe(3)
  })

  test('單次最多 2MB（比照本機 /api/log/since 上限）：超過的部分留到下一輪', () => {
    const chunk = 'a'.repeat(2 * 1024 * 1024 + 100)
    const r = sinceRemoteLogContent(chunk, 0)
    expect(r.text.length).toBe(2 * 1024 * 1024)
    expect(r.offset).toBe(2 * 1024 * 1024)
    // 下一輪從新 offset 繼續，能讀到剩下的 100 bytes。
    const r2 = sinceRemoteLogContent(chunk, r.offset)
    expect(r2.text.length).toBe(100)
    expect(r2.offset).toBe(chunk.length)
  })

  test('防禦上限 capBytes：內容超過上限時不崩潰，offset 語意仍然自洽（不對真實檔案位置做保證）', () => {
    const content = 'y'.repeat(1000)
    const r = sinceRemoteLogContent(content, 0, 500)
    expect(r.offset).toBeLessThanOrEqual(500)
  })
})
