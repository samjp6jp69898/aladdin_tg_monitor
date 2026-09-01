// 多機派工（T37 head/worker cluster，telegram-dispatcher 2026-08-31 新增）的
// 監控端讀取。跟 pipeline-queue-state.ts 同一套紀律：唯讀 dispatcher 落地的
// 檔案，不 import 對方的模組（見 server.ts 檔頭「兩個 repo 沒有 package.json
// 依賴關係」註解）。
//
//  1) 已註冊 worker 名冊：telegram-dispatcher/logs/cluster-workers.json
//     （worker-registry.ts persist 的格式，tmp+rename 原子寫入）。
//  2) 目前派在遠端的票：telegram-dispatcher/logs/cluster-dispatched.json
//     （dispatch-registry.ts persist 的格式）。這份只有「進行中」的條目——
//     worker 回報 job-done 後 head 會立刻清掉，所以看不到遠端執行的歷史，
//     這是既有已知限制（README「已知限制」一節），這裡不試圖補。
//  3) 對 worker 本機的即時探測（GET /health、/capacity、/jobs/:ticket）：
//     完全比照 telegram-dispatcher/lib/cluster/worker-client.ts 的介面，
//     這裡重新實作一份（不 import）——監控是唯讀觀測，不需要對方的完整
//     型別/去重邏輯，複製這幾個小函式比拉一條跨 repo 依賴划算。
//
// CLUSTER_SHARED_SECRET 讀取衛生比照 telegram-dispatcher/launchd/run-server.sh
// 的 grep 手法：只從根目錄 .env 讀，不印出值、不寫死；tg-monitor 的
// launchd plist 沒有替它匯出這個變數（跟 dispatcher 是各自獨立的 launchd
// job），所以用同一招直接讀檔案。

import { existsSync, readFileSync } from 'node:fs'
import { DISPATCHER_LOG_DIR } from './services.ts'

const ENV_FILE = '/Users/user/aladdin/.env'
const MIN_SECRET_LENGTH = 32

let cachedSecret: string | null | undefined // undefined = 尚未讀過

/** 回傳 cluster 共用 secret；未設定或太短回 null（= 探測功能停用，名冊仍可看）。 */
export function getClusterSecret(): string | null {
  if (cachedSecret !== undefined) return cachedSecret
  cachedSecret = null
  try {
    const line = readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .find(l => l.startsWith('CLUSTER_SHARED_SECRET='))
    const raw = (line ?? '').slice('CLUSTER_SHARED_SECRET='.length).trim()
    if (raw.length >= MIN_SECRET_LENGTH) cachedSecret = raw
  } catch {
    // .env 讀不到就當未設定
  }
  return cachedSecret
}

export type WorkerInfo = { name: string; url: string; registeredAt: string; disabled?: boolean }

export function listWorkers(): WorkerInfo[] {
  const p = `${DISPATCHER_LOG_DIR}/cluster-workers.json`
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { workers?: WorkerInfo[] }
    return Array.isArray(parsed.workers) ? parsed.workers : []
  } catch {
    return []
  }
}

export type DispatchEntry = {
  ticket: string
  kind: 'bug' | 'demand'
  status: 'dispatching' | 'confirmed'
  worker: string
  workerUrl: string
  dispatchedAt: string
  triggeredBy: { name: string; email: string } | null
}

export function listDispatchEntries(): DispatchEntry[] {
  const p = `${DISPATCHER_LOG_DIR}/cluster-dispatched.json`
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { entries?: DispatchEntry[] }
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

const CLUSTER_TOKEN_HEADER = 'x-cluster-token'

export type QueueStats = { limit: number; running: number; queued: number }
export type CapacityReport = { worker: string; bug: QueueStats; demand: QueueStats; ticket?: { ticket: string; active: boolean } }
export type WorkerHealth = { status: string; uptime_seconds: number }
export type JobStatus = { locked: boolean; queueState: 'running' | 'queued' | null; progress: string | null }

/** 未帶認證（worker-agent.ts /health 比照 dispatcher 本體，不驗證）。 */
export async function fetchWorkerHealth(url: string, timeoutMs = 2_500): Promise<WorkerHealth | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as WorkerHealth
  } catch {
    return null
  }
}

export async function fetchWorkerCapacity(url: string, secret: string, ticket?: string, timeoutMs = 3_000): Promise<CapacityReport | null> {
  try {
    const qs = ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''
    const res = await fetch(`${url}/capacity${qs}`, { headers: { [CLUSTER_TOKEN_HEADER]: secret }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as CapacityReport
  } catch {
    return null
  }
}

export async function fetchWorkerJobStatus(url: string, secret: string, ticket: string, timeoutMs = 4_000): Promise<JobStatus | null> {
  try {
    const res = await fetch(`${url}/jobs/${encodeURIComponent(ticket)}`, { headers: { [CLUSTER_TOKEN_HEADER]: secret }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as JobStatus
  } catch {
    return null
  }
}

// ---------- worker 名冊管理（中斷／恢復／移除，2026-08-31）----------
// 這三個動作實際上是打「head 自己」（telegram-dispatcher server.ts，本機
// 8787）新增的 /cluster/worker/:name/* 端點——head 的 worker 名冊活在它
// process 記憶體裡（cluster-head.ts 模組層初始化），tg-monitor 唯讀直接改
// cluster-workers.json 檔案沒有用：head 不會重新讀檔，記憶體版本才是
// dispatch.ts 選 worker 時真正吃到的資料。head 就是跑在這台機器上的固定
// 服務，位址不需要探測（比照 services.ts 對本機各服務 port 的既有假設）。
const HEAD_URL = 'http://127.0.0.1:8787'

export type ClusterAdminResult = { ok: boolean; status: number }

async function postClusterAdmin(path: string, secret: string, timeoutMs = 5_000): Promise<ClusterAdminResult> {
  try {
    const res = await fetch(`${HEAD_URL}${path}`, { method: 'POST', headers: { [CLUSTER_TOKEN_HEADER]: secret }, signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

export const disableWorker = (name: string, secret: string) => postClusterAdmin(`/cluster/worker/${encodeURIComponent(name)}/disable`, secret)
export const enableWorker = (name: string, secret: string) => postClusterAdmin(`/cluster/worker/${encodeURIComponent(name)}/enable`, secret)
export const removeWorker = (name: string, secret: string) => postClusterAdmin(`/cluster/worker/${encodeURIComponent(name)}/remove`, secret)
