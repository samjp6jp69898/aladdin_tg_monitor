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
// 的 grep 手法：只從 telegram-dispatcher/.env 讀（2026-09-01 起 CLUSTER_SHARED_SECRET
// 的唯一來源，根目錄 .env 已退役），不印出值、不寫死；tg-monitor 的
// launchd plist 沒有替它匯出這個變數（跟 dispatcher 是各自獨立的 launchd
// job），所以用同一招直接讀檔案。

import { existsSync, readFileSync } from 'node:fs'
import { DISPATCHER_LOG_DIR } from './services.ts'

const ENV_FILE = '/Users/user/aladdin/telegram-dispatcher/.env'
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

/**
 * head 自己的維護模式現況（2026-09-08，tg-monitor 手動控制）：跟上面
 * listWorkers()／listDispatchEntries() 同一套讀法——head 落地到
 * telegram-dispatcher/logs/maintenance-mode.json（tmp+rename 原子寫入，見
 * dispatcher lib/maintenance/mode-store.ts），tg-monitor 跟 head 同一台機器，
 * 直讀檔案比再開一支 GET /cluster/maintenance 划算（head 記憶體單例才是
 * claim.ts／demand-claim.ts 真正吃到的權威值，這裡讀檔案只是給 UI 顯示用，
 * 兩者理論上應該一致——head 每次 setOn 都會落盤，唯一的落後窗口是 head 剛
 * 收到請求但檔案 write 還沒完成的那一瞬間，可忽略）。檔案不存在／壞掉一律
 * 當非維護，跟 dispatcher 端 createMaintenanceModeStore 的預設一致。
 */
export function readHeadMaintenance(): boolean {
  const p = `${DISPATCHER_LOG_DIR}/maintenance-mode.json`
  if (!existsSync(p)) return false
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { on?: unknown }
    return parsed.on === true
  } catch {
    return false
  }
}

/** 切換 head 自己的維護模式：打 head 自己新增的 POST /cluster/maintenance
 * （同一台機器；帶 JSON body，寫法比照下面 retryRemoteDispatch 打
 * /cluster/retry，而非 postClusterAdmin——後者不帶 body，worker 名冊管理三個
 * 動作靠 path 帶參數就夠，這裡需要 `{on}`）。 */
export async function setHeadMaintenance(on: boolean, secret: string, timeoutMs = 5_000): Promise<ClusterAdminResult> {
  try {
    const res = await fetch(`${HEAD_URL}/cluster/maintenance`, {
      method: 'POST',
      headers: { [CLUSTER_TOKEN_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ on }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

/** 讀某台 worker 自己的維護模式現況（worker 是遠端機器，沒有本機檔案可讀，
 * 跟 head 那份不同，必須即時打 GET /maintenance）。打不通/逾時回 null——
 * 呼叫端據此顯示「無法確認」，不能當成「確定關閉」。 */
export async function fetchWorkerMaintenance(url: string, secret: string, timeoutMs = 2_500): Promise<boolean | null> {
  try {
    const res = await fetch(`${url}/maintenance`, { headers: { [CLUSTER_TOKEN_HEADER]: secret }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as { on?: unknown }
    return body?.on === true
  } catch {
    return null
  }
}

/** 切換某台 worker 自己的維護模式：直接打該 worker 的 POST /maintenance
 * （不經 head 轉發，見 telegram-dispatcher cluster-head.ts /cluster/maintenance
 * 端點註解「兩邊各自收各自的請求」）。 */
export async function setWorkerMaintenance(url: string, secret: string, on: boolean, timeoutMs = 5_000): Promise<ClusterAdminResult> {
  try {
    const res = await fetch(`${url}/maintenance`, {
      method: 'POST',
      headers: { [CLUSTER_TOKEN_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ on }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

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
export type ProgressStage = { key: string; label: string; done: boolean; current: boolean; at: string | null }
export type JobStatus = { locked: boolean; queueState: 'running' | 'queued' | null; progress: string | null; stages?: ProgressStage[] }

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

/**
 * `fetchWorkerJobStatus()` 結果套用到一列 pipeline run 的 running 旗標——純
 * 函式，抽出來單獨給 server.ts 的 `correctRemoteRunningFlags()` /
 * `buildPipelineRunPayload()` 共用，也讓下面這個 fail-closed 分支能不靠打
 * 真實 worker 就單元測試（2026-09-04 安全審查 finding 修正，見兩處呼叫端的
 * 註解）。
 *
 * fail-closed：`status === null` 代表 worker 逾時/連不上，是「無法確認」，
 * 不是「確定沒在跑」——不能讓 `running` 靜默停留在呼叫端傳進來的預設值
 * （通常是本機 ps 掃描帶來的錯誤 `false`），改標記 `runningStatusUnknown`，
 * 前端據此顯示「無法確認執行狀態」而非可誤按的重試/取消按鈕。
 */
export function applyRemoteJobStatus(row: { running: boolean; runningStatusUnknown?: boolean }, status: JobStatus | null): void {
  if (status) row.running = status.queueState === 'running' || status.queueState === 'queued'
  else row.runningStatusUnknown = true
}

export type RemoteRetryBlock = { blocked: true; reason: string } | { blocked: false }

/**
 * `/api/pipelines/retry` 用：worker 探測結果換算成是否該擋下這次重試——純
 * 函式，理由同上抽出來單獨測試。
 *
 * fail-closed（2026-09-04 安全審查 finding 修正）：`status === null` 時比照
 * 「還在跑」擋下（回 409），不放行到 `retryRemoteDispatch()`——原本的判斷式
 * `status?.queueState === 'running' || status?.queueState === 'queued'` 對
 * `null` 是 `false`，會直接放行（雖然 `dispatchBug()` 內部的同步
 * dispatch-registry 檢查仍會擋下真正的雙跑，但使用者體驗上會先看到一個不該
 * 出現的操作入口）。
 */
export function evaluateRemoteRetryBlock(workerName: string, status: JobStatus | null): RemoteRetryBlock {
  if (status?.queueState === 'running' || status?.queueState === 'queued') {
    return { blocked: true, reason: `這張票目前還在 worker「${workerName}」上跑，不能重複觸發` }
  }
  if (status === null) {
    return { blocked: true, reason: `worker「${workerName}」連不上，無法確認是否還在執行，暫不允許重試` }
  }
  return { blocked: false }
}

/** worker-agent.ts 的 `POST /jobs/:ticket/cancel` 回應形狀（見
 * telegram-dispatcher/lib/pipeline-runner/local-cancel.ts 的
 * `CancelLocalPipelineResult`）——與本機 `cancelPipeline()`
 * （lib/ingest.ts）的 `CancelPipelineResult` 同形，`/api/pipelines/cancel`
 * 轉發時可以直接把回應原樣往前端送，不用另外轉譯。 */
export type RemoteCancelResult = {
  ok: boolean
  killed: number[]
  wrapperPid?: number
  reason?: string
  runId?: string
  runIdResolvedBy?: string
  flagWritten?: boolean
}

/**
 * 轉發取消請求給 worker（任務 3，2026-09-04）：本機 `ps` 快照查不到這張票時
 * （`server.ts` 的 `/api/pipelines/cancel` 先查本機，查不到才會呼叫這支），
 * 改打 worker-agent.ts 新增的 `POST /jobs/:ticket/cancel`。打不通/逾時一律回
 * `{ok:false}`，不重試——使用者按取消按鈕時逾時，重按一次即可，沒有雙跑風險
 * （取消不像派工，兩台各自嘗試取消同一張票是安全的，被砍過一次的 wrapper
 * 再收到一次 SIGTERM 沒有副作用）。
 */
export async function cancelRemoteJob(url: string, secret: string, ticket: string, timeoutMs = 8_000): Promise<RemoteCancelResult> {
  try {
    const res = await fetch(`${url}/jobs/${encodeURIComponent(ticket)}/cancel`, {
      method: 'POST',
      headers: { [CLUSTER_TOKEN_HEADER]: secret },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json().catch(() => null)) as RemoteCancelResult | null
    if (!body || typeof body.ok !== 'boolean') return { ok: false, killed: [], reason: `worker 回應格式不對（HTTP ${res.status}）` }
    return body
  } catch {
    return { ok: false, killed: [], reason: 'worker 連不上或逾時未回應' }
  }
}

/**
 * 讀取 worker 白名單目錄下某個檔案的內容（task 1，2026-09-04）：`/api/agent-trace`
 * 對 worker 執行的 run proxy 用。白名單規則在 worker 那一端（見
 * telegram-dispatcher/lib/pipeline-runner/local-trace-read.ts 的
 * isAllowedTracePath，逐字比照 lib/services.ts 的 isAllowedTracePath——兩邊
 * 各自獨立宣告，改動任一邊都要同步）。打不通/逾時/被拒絕都回 `{ok:false}`，
 * reason 帶可讀訊息，不拋例外。
 */
export type RemoteFileResult = { ok: true; content: string } | { ok: false; reason: string }

export async function fetchRemoteFile(url: string, secret: string, path: string, timeoutMs = 8_000): Promise<RemoteFileResult> {
  try {
    const res = await fetch(`${url}/files?path=${encodeURIComponent(path)}`, { headers: { [CLUSTER_TOKEN_HEADER]: secret }, signal: AbortSignal.timeout(timeoutMs) })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; content?: string; reason?: string } | null
    if (!body || body.ok !== true || typeof body.content !== 'string') {
      return { ok: false, reason: body?.reason ?? `worker 回應格式不對（HTTP ${res.status}）` }
    }
    return { ok: true, content: body.content }
  } catch {
    return { ok: false, reason: 'worker 連不上或逾時未回應' }
  }
}

/** worker `GET /jobs/:ticket/stage-files` 的回應形狀（task 1）——見
 * telegram-dispatcher/lib/pipeline-runner/local-stage-files.ts 的
 * LocalStageFiles，與 lib/ingest.ts computeBugStages() 的 RemoteStageFiles
 * 參數同形狀。 */
export type RemoteStageFiles = { debugFiles: Record<string, string | null>; worktreeBootstrapLog: string | null }

/** 這張 bug 票在 worker 上的階段產物檔 mtime 原始資料（task 1：
 * `/api/pipelines/run` 組裝 computeBugStages() 用）。打不通/逾時/格式不對回
 * null——呼叫端據此顯示「暫時無法取得階段進度」，不當作「沒有任何產物」
 * （那會誤導成好像這步驟真的什麼都沒做）。 */
export async function fetchRemoteStageFiles(url: string, secret: string, ticket: string, timeoutMs = 8_000): Promise<RemoteStageFiles | null> {
  try {
    const res = await fetch(`${url}/jobs/${encodeURIComponent(ticket)}/stage-files`, { headers: { [CLUSTER_TOKEN_HEADER]: secret }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; debugFiles?: unknown; worktreeBootstrapLog?: unknown }
    if (body?.ok !== true || typeof body.debugFiles !== 'object' || body.debugFiles === null) return null
    return { debugFiles: body.debugFiles as Record<string, string | null>, worktreeBootstrapLog: (body.worktreeBootstrapLog as string | null) ?? null }
  } catch {
    return null
  }
}

/** worker `GET /jobs/:ticket/current-stage` 的回應形狀（task 2，2026-09-04）——
 * 見 telegram-dispatcher/lib/pipeline-runner/local-current-stage.ts 的
 * CurrentBugStage，與 lib/ingest.ts 的同名 type 同形狀（兩個 repo 各自獨立宣告，
 * 沒有 import 關係，見該檔頭「跨 repo 用複製對齊邏輯」的既定模式）。 */
export type RemoteCurrentBugStage = { stageKey: string; agent: string; since: string; reviewRound?: number }

/** fail-closed 的探測結果：`ok:false` 代表打不到／逾時／回應格式不對——呼叫端
 * 據此顯示「無法確認」，絕不能把它當成「stage:null（確定沒有任何 agent 正在
 * 跑）」——那是完全不同的語意，見 server.ts buildPipelineRunPayload 呼叫處與
 * lib/ingest.ts computeBugStages 的 remoteCurrentStage 參數註解。 */
export type RemoteCurrentStageResult = { ok: true; stage: RemoteCurrentBugStage | null } | { ok: false }

/** 這張 bug 票在 worker 上「目前正在跑哪個 stage／哪位 agent」的即時推定
 * （task 2）。`startedAt` 須是這次 run 的 started_at（ISO 字串），worker 用它
 * 錨定該掃哪一份 transcript。打不通/逾時/格式不對一律回 `{ ok: false }`。 */
export async function fetchRemoteCurrentStage(url: string, secret: string, ticket: string, startedAt: string, timeoutMs = 8_000): Promise<RemoteCurrentStageResult> {
  try {
    const res = await fetch(`${url}/jobs/${encodeURIComponent(ticket)}/current-stage?startedAt=${encodeURIComponent(startedAt)}`, {
      headers: { [CLUSTER_TOKEN_HEADER]: secret },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false }
    const body = (await res.json()) as { ok?: boolean; stage?: unknown }
    if (body?.ok !== true) return { ok: false }
    return { ok: true, stage: (body.stage ?? null) as RemoteCurrentBugStage | null }
  } catch {
    return { ok: false }
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

// ---------- 續跑改走一般派工的分派判斷（task 2，2026-08-31 觀察／2026-09-04 修）----------
// `/api/pipelines/retry` 原本寫死呼叫本機 CLI 版 submitCreateMr()，完全繞過
// head（telegram-dispatcher server.ts）的 dispatchBug()（worker 分派判斷）。
// 這裡打 head 自己新增的 POST /cluster/retry（見 cluster-head.ts），跟上面
// 三個 worker 名冊管理動作同一種模式——同一個長駐 head 行程、同一份記憶體
// 狀態，不會有雙份登記表競態（詳細理由見 cluster-head.ts /cluster/retry
// 端點註解）。CLUSTER_SHARED_SECRET 未設定（單機部署）時這條路由整個沒掛，
// 呼叫端（server.ts）要自行 fallback 回原本的本機 CLI 路徑，不是本函式的
// 職責。

/** DispatchResult（telegram-dispatcher/lib/cluster/dispatch.ts）的最小形狀——
 * 本檔不 import 對方型別，只聲明呼叫端需要的欄位（同上方 RemoteCancelResult
 * 等既有慣例）。*/
export type RetryDispatchResult =
  | { ok: true; status: 'started'; pid: number | undefined; runId?: string }
  | { ok: true; status: 'queued'; position: number; ahead: number; runId?: string }
  | { ok: true; status: 'already_queued'; position: number; ahead: number }
  | { ok: true; status: 'already_running' }
  | { ok: true; status: 'remote_started'; worker: string }
  | { ok: true; status: 'already_running_remote'; worker: string }
  | { ok: false; reason: string }

export async function retryRemoteDispatch(secret: string, ticket: string, triggeredByEmail: string | null, timeoutMs = 15_000): Promise<RetryDispatchResult> {
  try {
    const res = await fetch(`${HEAD_URL}/cluster/retry`, {
      method: 'POST',
      headers: { [CLUSTER_TOKEN_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, ...(triggeredByEmail ? { triggeredByEmail } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await res.json().catch(() => null)) as RetryDispatchResult | null
    if (!body || typeof body.ok !== 'boolean') return { ok: false, reason: `head 回應格式不對（HTTP ${res.status}）` }
    return body
  } catch {
    return { ok: false, reason: 'head 連不上或逾時未回應（/cluster/retry）' }
  }
}
