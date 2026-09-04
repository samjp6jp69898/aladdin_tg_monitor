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
import './test-tmp-db.ts' // 必須排在 ./ingest.ts 之前：把 sqlite 導向暫存檔（NB-7）
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelPipeline, deriveCancelFlagFields } from './ingest.ts'

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

// 2026-09-04：W4b 六欄修復（impl-errata-g2.md 對應項）——負面測試，退回舊碼
// （只填 runId/ticket/kind/cancelRequestedAt/resolvedBy/legacyKey 六欄）會打紅，
// 因為下面每一項都斷言六個新欄位真的有值，不是 undefined。
describe('deriveCancelFlagFields（W4b 六欄推導，純函式）', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  test('bug kind + 合法 legacyKey + 無 triggered-by sidecar → 六欄有值，triggerSource=cli', () => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-cancel-'))
    const extra = '/Users/user/aladdin/telegram-dispatcher/logs/FAQ-1234.2026-09-04T10-00-00-000Z.stdout.log'
    const legacyKey = 'FAQ-1234.2026-09-04T10-00-00-000Z'
    const r = deriveCancelFlagFields('bug', extra, legacyKey, dir)
    expect(r.stdoutPath).toBe(extra)
    expect(r.stderrPath).toBe('/Users/user/aladdin/telegram-dispatcher/logs/FAQ-1234.2026-09-04T10-00-00-000Z.stderr.log')
    expect(r.startedAt).toBe('2026-09-04T10:00:00.000Z')
    expect(r.triggerSource).toBe('cli')
    expect(r.triggeredByEmail).toBeNull()
    expect(r.triggeredByName).toBeNull()
  })

  test('bug kind + 有 triggered-by sidecar → triggerSource=telegram，email/name 真的填進來', () => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-cancel-'))
    const legacyKey = 'FAQ-5678.2026-09-04T11-30-00-000Z'
    writeFileSync(
      join(dir, `${legacyKey}.triggered-by.json`),
      JSON.stringify({ name: '測試人員', email: 'tester@example.com', at: '2026-09-04T11:30:00.000Z' }),
    )
    const extra = `/Users/user/aladdin/telegram-dispatcher/logs/${legacyKey}.stdout.log`
    const r = deriveCancelFlagFields('bug', extra, legacyKey, dir)
    expect(r.triggerSource).toBe('telegram')
    expect(r.triggeredByEmail).toBe('tester@example.com')
    expect(r.triggeredByName).toBe('測試人員')
  })

  test('demand kind：extra 是 assigneeEmail 不是路徑，legacyKey 已由呼叫端 deriveLegacyKey 判為 null → 六欄全 null/cli，不誤把 email 塞進 stdout_path', () => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-cancel-'))
    const r = deriveCancelFlagFields('demand', 'someone@example.com', null, dir)
    expect(r.stdoutPath).toBeNull()
    expect(r.stderrPath).toBeNull()
    expect(r.startedAt).toBeNull()
    expect(r.triggerSource).toBe('cli')
    expect(r.triggeredByEmail).toBeNull()
    expect(r.triggeredByName).toBeNull()
  })

  test('bug kind 但 legacyKey 為 null（deriveLegacyKey 判定格式不合法）→ 不信任 extra，六欄全 null/cli', () => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-cancel-'))
    const r = deriveCancelFlagFields('bug', '/some/unexpected/path.log', null, dir)
    expect(r.stdoutPath).toBeNull()
    expect(r.stderrPath).toBeNull()
    expect(r.startedAt).toBeNull()
    expect(r.triggerSource).toBe('cli')
  })
})
