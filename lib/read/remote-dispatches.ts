// lib/read/remote-dispatches.ts — buildPipelinesPayload() 的 remote 陣列組裝
// （任務 1，2026-09-04）。
//
// 背景：`server.ts` 的 `buildPipelinesPayload()` 原本 `remote` 陣列讀的是
// telegram-dispatcher head 行程記憶體裡的登記表
// （`lib/cluster-state.ts` `listDispatchEntries()`，唯讀複製自
// `dispatch-registry.ts` 落盤的快照）——那份表只在「派工進行中」期間存在，
// 跟 `rows`（`runs` 表撈出的真實 run 記錄，worker 一開始執行就會寫入）是兩個
// 互不知情的資料源：worker 執行期間兩邊各存在一筆同票紀錄，前端 concat 出來
// 就是使用者看到的「列表出現兩筆相同資料」；worker 回報 job-done 後記憶體
// 登記被清掉，只剩 `rows` 那筆，「變回一筆」。
//
// 本檔負責「一張票只留一筆」的去重規則，純函式、不碰 DB，方便單測——實際的
// 候選資料來源（MON_READ_SOURCE=mysql 時查 `dispatch_attempts`，否則維持
// 讀取記憶體登記表）在 server.ts 組裝。

/** 去重前的候選列——`mysql.ts` 的 `readActiveDispatchAttempts()` 與
 * `cluster-state.ts` 的 `listDispatchEntries()` 兩種來源各自轉換成這個形狀。 */
export interface RemoteDispatchCandidate {
  ticket: string
  kind: 'bug' | 'demand'
  status: 'dispatching' | 'confirmed'
  worker: string
  workerUrl: string
  dispatchedAt: string
  triggeredBy: { name: string; email: string } | null
  /**
   * 只用於去重判斷，不進最終回應形狀（前端 `DispatchEntry` 型別沒有這個
   * 欄位）——`dispatch_attempts.remote_run_id` 一旦被填上，代表 worker 那邊
   * 的 `runs` 列已經確立，這張票已經有真實 run 記錄可看，見下方
   * `dedupRemoteDispatches` 說明。記憶體登記表（sqlite/舊路徑）沒有這個欄位，
   * 一律是 `undefined`。
   */
  remoteRunId?: string | null
}

/** 去重後的輸出形狀＝前端既有的 `DispatchEntry` 型別（frontend/src/api/types.ts）。 */
export interface DedupedRemoteDispatch {
  ticket: string
  kind: 'bug' | 'demand'
  status: 'dispatching' | 'confirmed'
  worker: string
  workerUrl: string
  dispatchedAt: string
  triggeredBy: { name: string; email: string } | null
}

/**
 * 一張票若已經在 `rows`（`runs` 表撈出的真實 run 記錄）出現，就不該再讓它
 * 同時出現在 `remote` 陣列。
 *
 * 判準雙重（任一成立即抑制）：
 *   1. `rowKeys`（`${kind}:${ticket}`）已涵蓋這張票——最直接的去重依據，
 *      `rows` 與候選列在同一次請求內撈出，時間點一致。
 *   2. `remote_run_id` 已被填上——即使因為 `rows` 上限 300 筆（`pipelineRuns(300)`）
 *      而這張票剛好沒被抓進 `rows`，`remote_run_id` 非空本身就是「worker 那邊
 *      的 runs 列已確立、有真實 run 記錄可看」的獨立訊號，同樣該抑制。
 *
 * 保留原本 remote 陣列僅存的獨特價值：「派工中、還沒有任何 run_id」的極短暫
 * 空窗期（`status='dispatching'` 且 `remoteRunId` 為 null/undefined）——這種
 * 候選兩個判準都不成立，照常保留在輸出裡。
 */
export function dedupRemoteDispatches(
  candidates: readonly RemoteDispatchCandidate[],
  rowKeys: ReadonlySet<string>,
): DedupedRemoteDispatch[] {
  return candidates
    .filter(e => !rowKeys.has(`${e.kind}:${e.ticket}`) && !e.remoteRunId)
    .map(({ ticket, kind, status, worker, workerUrl, dispatchedAt, triggeredBy }) => ({
      ticket,
      kind,
      status,
      worker,
      workerUrl,
      dispatchedAt,
      triggeredBy,
    }))
}
