// lib/ingest.cancel.test.ts — cancelPipeline 的 async 化契約測試。
//
// cachedRunning 是 lib/ingest.ts 內部私有變數，只有 startCollectors() 的
// collector tick（呼叫 scanRunningPipelineProcs，內含 Bun.spawnSync 對 ps
// 做同步快照）才會填入；本檔不呼叫 startCollectors()，所以 cachedRunning
// 在整個測試行程生命週期內恆為空陣列——這讓「ps 上沒有這張票」這條既有拒絕
// 路徑（K9 事實：today 就有的行為，非新增）可以被確定性地測到，不需要
// sleep/計時去等 ps 快照。
//
// 五段解析 / W4a-W4b / spool 落地 / 逾時退路的核心邏輯已在 lib/mon-db.test.ts
// 完整覆蓋（純函式、假 pool，不依賴 cachedRunning 這個私有狀態）；本檔只驗證
// cancelPipeline 本身的「契約」沒有因為 async 化而跑掉。
import { describe, expect, test } from 'bun:test'
import { cancelPipeline } from './ingest.ts'

describe('cancelPipeline — async 化後的契約（plan-db-as-truth-v3.2.md §6.4(2) 修訂）', () => {
  test('回傳的是一個 Promise（呼叫端必須 await，見 server.ts 的呼叫點）', () => {
    const p = cancelPipeline('bug', 'FAQ-999999')
    expect(p).toBeInstanceOf(Promise)
  })

  test('ps 上沒有這張票 → 唯一的拒絕路徑，reason 文字與既有行為逐字相同（K9：這是今天就有的行為，不是新增的拒絕路徑）', async () => {
    const r = await cancelPipeline('bug', 'FAQ-999999')
    expect(r).toEqual({ ok: false, killed: [], reason: 'not running（可能剛結束，或 ps 快照尚未更新，3 秒後再試）' })
    // 這條路徑完全不觸碰 MON_DB（isMonitorDbEnabled 判斷都還沒執行到），
    // 所以不會有 runId/runIdResolvedBy/flagWritten 這三個欄位——回應形狀
    // 與遷移前的同步版本逐位元組相同。
    expect(r).not.toHaveProperty('runId')
    expect(r).not.toHaveProperty('runIdResolvedBy')
    expect(r).not.toHaveProperty('flagWritten')
  })

  test('demand kind 同樣套用「not running」拒絕路徑', async () => {
    const r = await cancelPipeline('demand', 'FAQ-888888')
    expect(r.ok).toBe(false)
    expect(r.killed).toEqual([])
  })
})
