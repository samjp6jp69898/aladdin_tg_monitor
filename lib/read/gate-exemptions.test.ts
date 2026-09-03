// lib/read/gate-exemptions.test.ts — 純函式測試，不 import db.ts、不碰任何 DB。
import { describe, expect, test } from 'bun:test'
import {
  extractIntConstant, isFinishedAtExempt, isOutcomeDifference3Exempt,
  isRoundsExempt, isSkeletonAgentRun, KNOWN_OUTCOME_SOURCES, SKELETON_EXEMPT_FIELDS,
} from './gate-exemptions.ts'

describe('extractIntConstant', () => {
  test('讀單一整數常數', () => {
    expect(extractIntConstant('const CREATE_MR_TIMEOUT_SECONDS = 10800', 'CREATE_MR_TIMEOUT_SECONDS')).toBe(10800)
  })
  test('讀乘法運算式常數（真實碼裡 ROUNDS_MON_DB_RECENT_WINDOW_MS 就是這個形狀）', () => {
    expect(extractIntConstant('const ROUNDS_MON_DB_RECENT_WINDOW_MS = 6 * 3600 * 1000', 'ROUNDS_MON_DB_RECENT_WINDOW_MS')).toBe(21_600_000)
  })
  test('常數不存在回 null（不給預設值，呼叫端必須判 FAIL）', () => {
    expect(extractIntConstant('const OTHER = 5', 'MISSING_NAME')).toBeNull()
  })
  test('常數名相同但值含危險字元（不 eval 任意碼）回 null', () => {
    expect(extractIntConstant('const X = require("fs")', 'X')).toBeNull()
  })
  test('突變：常數被改名（模擬 a7-D55 的形狀）——讀不到必須是 null 不是舊值', () => {
    const renamed = 'const CREATE_MR_TIMEOUT_SECONDS_V2 = 10800'
    expect(extractIntConstant(renamed, 'CREATE_MR_TIMEOUT_SECONDS')).toBeNull()
  })
})

describe('isSkeletonAgentRun', () => {
  test('未終態（ended_at=null 且非錯誤）＝骨架列', () => {
    expect(isSkeletonAgentRun({ ended_at: null, is_error: 0 })).toBe(true)
  })
  test('已終態（ended_at 有值）不是骨架列', () => {
    expect(isSkeletonAgentRun({ ended_at: '2026-09-03T00:00:00.000Z', is_error: 0 })).toBe(false)
  })
  test('ended_at=null 但 is_error=1（以錯誤收場也算終態）不是骨架列', () => {
    expect(isSkeletonAgentRun({ ended_at: null, is_error: 1 })).toBe(false)
  })
})

describe('SKELETON_EXEMPT_FIELDS', () => {
  test('只涵蓋 payload 欄，非 payload 欄（path/ticket/kind/stage/started_at）不在其中', () => {
    for (const nonPayload of ['path', 'ticket', 'kind', 'stage', 'started_at']) {
      expect(SKELETON_EXEMPT_FIELDS.has(nonPayload)).toBe(false)
    }
    for (const payload of ['ended_at', 'model', 'cost_usd', 'result_preview']) {
      expect(SKELETON_EXEMPT_FIELDS.has(payload)).toBe(true)
    }
  })
})

describe('isFinishedAtExempt', () => {
  test('outcome_source=tracker_reconcile 才豁免', () => {
    expect(isFinishedAtExempt('tracker_reconcile')).toBe(true)
  })
  test('其他 outcome_source 或 null 都不豁免', () => {
    expect(isFinishedAtExempt('backfill')).toBe(false)
    expect(isFinishedAtExempt(null)).toBe(false)
  })
})

describe('isOutcomeDifference3Exempt', () => {
  test('sqlite 已轉 recovered 且 mysql 仍 tier1 → 豁免', () => {
    expect(isOutcomeDifference3Exempt('recovered', 1)).toBe(true)
  })
  test('人工判定兩種形狀也豁免', () => {
    expect(isOutcomeDifference3Exempt('failed（人工判定）', 1)).toBe(true)
    expect(isOutcomeDifference3Exempt('needs_qa_clarification（人工判定）', 1)).toBe(true)
  })
  test('mysql tier=2（已被正常 reconcile）不豁免——這才是真差異該抓的情況', () => {
    expect(isOutcomeDifference3Exempt('recovered', 2)).toBe(false)
  })
  test('sqlite outcome 不在集合內不豁免', () => {
    expect(isOutcomeDifference3Exempt('success', 1)).toBe(false)
  })
  test('sqlite outcome 為 null 不豁免', () => {
    expect(isOutcomeDifference3Exempt(null, 1)).toBe(false)
  })
})

describe('isRoundsExempt（方向敏感，97 更正後定案）', () => {
  test('出窗 + sqlite=N + mysql=NULL → 豁免', () => {
    expect(isRoundsExempt(3, null, true)).toBe(true)
  })
  test('反方向：出窗 + sqlite=NULL + mysql=N → 不豁免（這是寫入端又死了的訊號）', () => {
    expect(isRoundsExempt(null, 3, true)).toBe(false)
  })
  test('未出窗 → 不豁免，即使方向對', () => {
    expect(isRoundsExempt(3, null, false)).toBe(false)
  })
  test('兩側皆有值但不同 → 不豁免（真差異）', () => {
    expect(isRoundsExempt(3, 2, true)).toBe(false)
  })
  test('兩側皆 NULL → 不豁免（呼叫端本來就不會為相等值呼叫這支，但函式本身要誠實）', () => {
    expect(isRoundsExempt(null, null, true)).toBe(false)
  })
})

describe('KNOWN_OUTCOME_SOURCES', () => {
  test('已知全庫 grep 到的值都在集合內', () => {
    for (const v of ['tracker_reconcile', 'backfill', 'backlog-dispatch', 'cancel_late_fix']) {
      expect(KNOWN_OUTCOME_SOURCES.has(v)).toBe(true)
    }
  })
  test('捏造的新值不在集合內（呼叫端據此印 WARN，不是這支函式的職責）', () => {
    expect(KNOWN_OUTCOME_SOURCES.has('some-brand-new-source-2026')).toBe(false)
  })
})
