// lib/cluster-state.test.ts — 2026-09-04 安全審查 finding 修正：worker 探測
// 逾時/連不上（fetchWorkerJobStatus() 回傳 null）時要 fail-closed（視為「無法
// 確認」），不能 fail-open（視為「確定沒在跑」）。純函式，不打真實 worker、
// 不碰 DB/檔案。
import { describe, expect, test } from 'bun:test'
import { applyRemoteJobStatus, evaluateRemoteRetryBlock, type JobStatus } from './cluster-state.ts'

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
