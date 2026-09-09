// lib/read/index.ts — 讀取面的單一入口。server.ts 只認識這一支。
//
//   import { getReader, initReader } from './lib/read/index.ts'
//   const rows = await getReader().pipelineRuns(300)
//
// sqlite 讀取面已於 2026-09-09 退役（維護協議紅區項目 6）：mysql 側
// （runs/agent_runs 等表）本來就是 telegram-dispatcher 另一套完全獨立的
// 寫入路徑產生，不是接力讀 tg-monitor 的 sqlite 表——退役後固定使用
// mysqlReader，MON_READ_SOURCE 不再生效。

import { mysqlReader, probeMysqlReadable } from './mysql.ts'
import type { MonitorReader } from './types.ts'

/**
 * 啟動探針的期限。
 *
 * server.ts 是用 **top-level await** 呼叫 initReader() 的，模組沒跑完就不會
 * `export default { fetch, port }`，Bun 也就不會開始 listen。而 pool 的
 * `connectTimeout: 500`（lib/mon-db.ts）只約束連線＋握手——握手成功、查詢卻
 * 掛住的話，這支探針會無限期不回，tg-monitor 變成「行程活著但一個請求都不服務」，
 * `KeepAlive=true` 完全救不了（它只重啟死掉的行程）。那正是本函式要避免的
 * 情況，所以探針自己一定要有期限。
 */
const PROBE_TIMEOUT_MS = 3_000

function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * 啟動時呼叫一次（server.ts 頂層 await）：跑一次 `SELECT 1` 探針確保監控 DB
 * 讀得到。
 *
 * sqlite 退役前，探針失敗會記一行 ERROR 並退回 sqlite（面板還能用，只是資料
 * 源不是想要的那個）；退役後沒有 sqlite 可以退，這裡改成**直接 throw**：
 *   - launchd 設定是 KeepAlive=true，throw 會讓行程結束、被立刻重啟，下一次
 *     啟動會重新跑一次探針——mysql 若只是暫時連不上（tunnel 還沒起、機器剛
 *     開機），這個 crash-loop 本身就是自動重試，一旦恢復下次啟動就會成功，
 *     不需要人工介入重啟服務。
 *   - 反過來若不 throw、讓 reader 停在未初始化狀態，行程會「看起來活著」
 *     （port 有 listen），但每一個 API 請求都要在真正呼叫到 mysql 時才各自
 *     炸開，錯誤分散在每個 request、不是一次清楚的啟動失敗事件，而且不會
 *     自動恢復（沒有人重啟就一直卡在這個「活著但全部端點都壞掉」的狀態）。
 * 兩害相權取其輕：失敗要失敗得明顯、而且失敗得會自己好。
 */
export async function initReader(): Promise<void> {
  await withDeadline(probeMysqlReadable(), PROBE_TIMEOUT_MS, `監控 DB 探針超過 ${PROBE_TIMEOUT_MS}ms 未回應`)
  console.error('tg-monitor: 讀取面資料源 = mysql（pipeline_monitor）')
}

/** 目前生效的 reader——sqlite 退役後恆為 mysqlReader。 */
export function getReader(): MonitorReader {
  return mysqlReader
}

export type { MonitorReader } from './types.ts'
export * from './types.ts'
