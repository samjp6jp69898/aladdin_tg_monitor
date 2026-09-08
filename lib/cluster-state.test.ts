// lib/cluster-state.test.ts — 2026-09-04 安全審查 finding 修正：worker 探測
// 逾時/連不上（fetchWorkerJobStatus() 回傳 null）時要 fail-closed（視為「無法
// 確認」），不能 fail-open（視為「確定沒在跑」）。純函式，不打真實 worker、
// 不碰 DB/檔案。
import { describe, expect, test } from 'bun:test'
import { applyRemoteJobStatus, evaluateRemoteRetryBlock, readHeadMaintenance, type JobStatus } from './cluster-state.ts'

// readHeadMaintenance() 讀的是 telegram-dispatcher/logs/maintenance-mode.json
// ——這台機器上 head 實際讀寫的同一份檔案，不是測試專用的隔離路徑，所以這裡
// 只驗證「不管檔案現況是什麼，函式都回一個 boolean、不拋例外」，不斷言具體
// 值（那是這台機器當下的真實維護模式狀態，測試不該對它有任何假設，也不該
// 去改它）。read/write 語意本身已經在 dispatcher 側的
// lib/maintenance/mode-store.test.ts 用隔離的暫存檔完整覆蓋。
describe('readHeadMaintenance（唯讀，不碰真實檔案內容）', () => {
  test('回傳值是 boolean，不拋例外', () => {
    expect(typeof readHeadMaintenance()).toBe('boolean')
  })
})

describe('applyRemoteJobStatus（correctRemoteRunningFlags / buildPipelineRunPayload 共用）', () => {
  test('status === null（worker 逾時/連不上）：不把 running 誤判成確定的 false，改標記 runningStatusUnknown', () => {
    const row = { running: false, runningStatusUnknown: undefined as boolean | undefined }
    applyRemoteJobStatus(row, null)
    // running 停留在呼叫端傳入的值（這裡是 ps 掃描帶來的預設 false）——重點是
    // 不能靜默把它「確定化」，必須額外標記無法確認。
    expect(row.running).toBe(false)
    expect(row.runningStatusUnknown).toBe(true)
  })

  test('status.queueState === "running"：確定在跑，running=true，不標記 unknown', () => {
    const row = { running: false, runningStatusUnknown: undefined as boolean | undefined }
    const status: JobStatus = { locked: true, queueState: 'running', progress: null }
    applyRemoteJobStatus(row, status)
    expect(row.running).toBe(true)
    expect(row.runningStatusUnknown).toBeUndefined()
  })

  test('status.queueState === "queued"：也算 running=true（既有語意，佇列中視同執行）', () => {
    const row = { running: false, runningStatusUnknown: undefined as boolean | undefined }
    const status: JobStatus = { locked: true, queueState: 'queued', progress: null }
    applyRemoteJobStatus(row, status)
    expect(row.running).toBe(true)
    expect(row.runningStatusUnknown).toBeUndefined()
  })

  test('status.queueState === null（worker 查得到但確定沒在跑）：running=false，不標記 unknown', () => {
    const row = { running: false, runningStatusUnknown: undefined as boolean | undefined }
    const status: JobStatus = { locked: false, queueState: null, progress: null }
    applyRemoteJobStatus(row, status)
    expect(row.running).toBe(false)
    expect(row.runningStatusUnknown).toBeUndefined()
  })
})

describe('evaluateRemoteRetryBlock（/api/pipelines/retry 用）', () => {
  test('status === null（worker 逾時/連不上）：擋下重試（fail-closed），不是放行', () => {
    const result = evaluateRemoteRetryBlock('worker-a', null)
    expect(result.blocked).toBe(true)
    if (result.blocked) expect(result.reason).toContain('連不上')
  })

  test('status.queueState === "running"：擋下重試，理由提到還在跑', () => {
    const status: JobStatus = { locked: true, queueState: 'running', progress: null }
    const result = evaluateRemoteRetryBlock('worker-a', status)
    expect(result.blocked).toBe(true)
    if (result.blocked) expect(result.reason).toContain('還在')
  })

  test('status.queueState === "queued"：擋下重試', () => {
    const status: JobStatus = { locked: true, queueState: 'queued', progress: null }
    const result = evaluateRemoteRetryBlock('worker-a', status)
    expect(result.blocked).toBe(true)
  })

  test('status.queueState === null（查得到、確定沒在跑）：放行，不擋', () => {
    const status: JobStatus = { locked: false, queueState: null, progress: null }
    const result = evaluateRemoteRetryBlock('worker-a', status)
    expect(result).toEqual({ blocked: false })
  })
})
