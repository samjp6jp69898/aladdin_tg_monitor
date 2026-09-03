// lib/db.named-binding.test.ts — bun:sqlite 具名參數綁定的兩道防線（2026-09-03）。
//
// 背景：bun:sqlite 對「SQL 用 @x 具名參數、綁定物件卻用裸 key」不報錯，而是
// **靜默綁 NULL**（實驗：changes=0、值不變）。db.ts 的 bumpReviewRounds 因此
// 從 2026-09-02 誕生起一次都沒寫入過（53 列全 NULL），而同檔 upsertAgentRun
// 早就踩過並**註記**了這個坑——證明註記防不了它，防得住的是測試。所以這裡
// 釘兩層：
//   1. 綁定形式掃描（針對**這一類**，不只 bumpReviewRounds）：db.ts 內任何
//      物件字面量綁定的第一個 key 必須帶 @ 前綴——物件綁定在 bun:sqlite 只有
//      具名參數一種用途，裸 key 必然是本坑。
//   2. bumpReviewRounds 行為迴歸（針對這一次的實例）：真的寫得進去、單調
//      不回退、null 參數表示該欄不動。
import './test-tmp-db.ts' // 必須排在 ./db.ts 之前：把 sqlite 導向暫存檔（NB-7）
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, upsertRun, bumpReviewRounds } from './db.ts'

describe('綁定形式掃描 — db.ts 物件字面量綁定必須帶 @ 前綴', () => {
  test('db.ts 內 .run({/.get({/.all({ 的物件字面量，第一個 key 不得是裸識別字', () => {
    const src = readFileSync(join(import.meta.dir, 'db.ts'), 'utf8')
    const violations: string[] = []
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      // 抓「.run({ 後緊接裸識別字」的形式；合法寫法要嘛 '@key'（帶引號前綴）、
      // 要嘛傳變數（如 upsertAgentRun 的 bound as any，不是物件字面量）。
      const m = /\.(run|get|all)\(\{\s*([^\s}])/.exec(lines[i]!)
      if (!m) continue
      const firstChar = m[2]!
      // 合法：'@ / "@ / `@ 開頭（帶前綴的字串 key）。違規：裸識別字或不帶 @ 的字串。
      if (firstChar === "'" || firstChar === '"' || firstChar === '`') {
        if (!/\.(run|get|all)\(\{\s*['"`]@/.test(lines[i]!)) violations.push(`db.ts:${i + 1}: ${lines[i]!.trim()}`)
      } else {
        violations.push(`db.ts:${i + 1}: ${lines[i]!.trim()}`)
      }
    }
    // 違規清單直接進斷言訊息，紅的時候一眼看到在哪。
    expect(violations).toEqual([])
  })
})

describe('bumpReviewRounds — 行為迴歸（裸 key 綁定的靜默 no-op 不得重現）', () => {
  test('真的寫得進去；單調不回退；null 參數＝該欄不動', () => {
    const key = `FAQ-BIND.${Date.now()}`
    upsertRun(key, 'bug', 'FAQ-BIND', '2026-09-03T00:00:00.000Z', '/tmp/x.stdout.log', '/tmp/x.stderr.log')
    const read = () => db.prepare('SELECT review_rounds, final_review_rounds FROM pipeline_runs WHERE key = ?').get(key) as { review_rounds: number | null; final_review_rounds: number | null }

    bumpReviewRounds(key, 2, 1)
    expect(read()).toEqual({ review_rounds: 2, final_review_rounds: 1 }) // 修法前這裡是 {null, null}——寫入端整個死掉

    bumpReviewRounds(key, 1, null) // review 回退值不生效、final null 不動
    expect(read()).toEqual({ review_rounds: 2, final_review_rounds: 1 })

    bumpReviewRounds(key, null, 3) // review null 不動、final 前進
    expect(read()).toEqual({ review_rounds: 2, final_review_rounds: 3 })
  })
})
