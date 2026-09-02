// lib/read/index.ts — 讀取面的單一入口。server.ts 只認識這一支。
//
//   import { getReader, initReader } from './lib/read/index.ts'
//   const rows = await getReader().pipelineRuns(300)
//
// MON_READ_SOURCE 的解析與（mysql 模式的）啟動探針都在這裡；server.ts 不需要
// 知道現在讀的是 sqlite 還是 mysql。

import { currentReadSource, type ReadSource } from './source.ts'
import { sqliteReader } from './sqlite.ts'
import type { MonitorReader } from './types.ts'

let reader: MonitorReader = sqliteReader

/**
 * 啟動探針的期限。
 *
 * server.ts 是用 **top-level await** 呼叫 initReader() 的，模組沒跑完就不會
 * `export default { fetch, port }`，Bun 也就不會開始 listen。而 pool 的
 * `connectTimeout: 500`（lib/mon-db.ts）只約束連線＋握手——握手成功、查詢卻
 * 掛住的話，這支探針會無限期不回，tg-monitor 變成「行程活著但一個請求都不服務」，
 * `KeepAlive=true` 完全救不了（它只重啟死掉的行程）。那正是本函式的 fallback
 * 想避免的情況，所以探針自己一定要有期限。
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
 * 啟動時呼叫一次（server.ts 頂層 await）。
 *
 * - sqlite 模式：什麼都不做，連 mysql2 都不會被 import（lazy import 是
 *   MAJOR-D1「工作區即部署 + KeepAlive」推論的既有紀律：關閉狀態下新路徑的
 *   任何模組都不該被載入）。
 * - mysql 模式：lazy import lib/read/mysql.ts，跑一次 `SELECT 1` 探針。
 *   探針失敗（環境變數沒派送、tunnel 沒起、帳號權限不對）→ **記一行很大聲的
 *   ERROR 並退回 sqlite**。不 throw 的理由：plist 是 KeepAlive=true，啟動時
 *   throw 會變成無窮重啟迴圈，而且監控面板本身掛掉會讓人看不到「監控 DB 有
 *   問題」這件事——退回 sqlite 至少面板還在、log 裡有明確原因。
 *   （這條「探針失敗退回 sqlite」是實作裁量，已列進回報單請指揮官覆核。）
 */
export async function initReader(): Promise<ReadSource> {
  const want = currentReadSource()
  if (want === 'sqlite') {
    reader = sqliteReader
    return 'sqlite'
  }
  try {
    const m = await import('./mysql.ts')
    await withDeadline(m.probeMysqlReadable(), PROBE_TIMEOUT_MS, `監控 DB 探針超過 ${PROBE_TIMEOUT_MS}ms 未回應`)
    reader = m.mysqlReader
    console.error('tg-monitor: MON_READ_SOURCE=mysql —— 讀取面已切到監控 DB（pipeline_monitor）')
    return 'mysql'
  } catch (e) {
    console.error(
      `tg-monitor: ERROR MON_READ_SOURCE=mysql 但監控 DB 探針失敗，讀取面退回 sqlite：${e instanceof Error ? e.message : String(e)}`,
    )
    reader = sqliteReader
    return 'sqlite'
  }
}

/** 目前生效的 reader。initReader() 之前呼叫會拿到 sqlite（安全預設）。 */
export function getReader(): MonitorReader {
  return reader
}

export type { MonitorReader } from './types.ts'
export * from './types.ts'
