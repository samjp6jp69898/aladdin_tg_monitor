// 排隊機制（2026-08-28）的監控端讀取：
//  1) 排隊中的單：telegram-dispatcher 的 pipeline-queue.ts 每次佇列變動都把
//     快照原子性寫進 logs/pipeline-queue.{bug,demand}.json（tmp+rename，讀端
//     不會讀到寫一半的 JSON）——這裡唯讀，不新增別的事實來源。
//  2) 併發上限常數：啟動時經行程邊界呼叫 dispatcher 的
//     concurrency-limiter.ts CLI（`bun concurrency-limiter.ts` → 一行 JSON），
//     直接吃程式碼裡的真實常數，不再複製數字過來寫死（2026-08-28 前這裡的
//     複製品 demand 上限還停在 2，實際程式碼早已是 6——複製常數必漂移的
//     實例；使用者定案改為讀真實常數）。維持「兩個 repo 不互相 import」的
//     既有紀律（見 server.ts 檔頭註解），介面只有 argv + stdout JSON。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DISPATCHER_LOG_DIR } from './services.ts'

const execFileAsync = promisify(execFile)

const CONCURRENCY_LIMITER_TS = '/Users/user/aladdin/telegram-dispatcher/lib/pipeline-runner/concurrency-limiter.ts'

export type PipelineLimits = { bug: number; demand: number; source: 'code' | 'fallback' }

// CLI 讀不到時的後備值（啟動時 dispatcher repo 不在、bun 出錯等）：寧可顯示
// 帶標記的後備值也不要整個 overview 掛掉；source 欄位讓 UI 能標示「非即時
// 常數」。後備值只在這裡出現一次，不再散落各處。
const FALLBACK_LIMITS: PipelineLimits = { bug: 5, demand: 6, source: 'fallback' }

/** 啟動時呼叫一次（常數改了本來就要重啟 dispatcher，monitor 跟著重啟即可）。 */
export async function fetchPipelineLimits(): Promise<PipelineLimits> {
  try {
    const { stdout } = await execFileAsync('bun', [CONCURRENCY_LIMITER_TS], { encoding: 'utf8', timeout: 10_000 })
    const parsed = JSON.parse(stdout.trim()) as { bug?: number; demand?: number }
    if (typeof parsed.bug === 'number' && typeof parsed.demand === 'number') {
      return { bug: parsed.bug, demand: parsed.demand, source: 'code' }
    }
  } catch (err) {
    console.error(`fetchPipelineLimits: 讀取 dispatcher 併發上限常數失敗，改用後備值: ${err}`)
  }
  return FALLBACK_LIMITS
}

export type QueuedTicket = {
  kind: 'bug' | 'demand'
  ticket: string
  position: number
  enqueuedAt: string
  triggeredBy: string | null
}

/** 讀兩個佇列快照檔，攤平成帶順位的清單。檔案不存在/壞掉都當空佇列（監控
 * 顯示層，不因單一壞檔讓整個 API 掛掉）。 */
export function readQueuedTickets(): QueuedTicket[] {
  const out: QueuedTicket[] = []
  for (const kind of ['bug', 'demand'] as const) {
    const p = join(DISPATCHER_LOG_DIR, `pipeline-queue.${kind}.json`)
    if (!existsSync(p)) continue
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as {
        entries?: { ticket?: string; enqueuedAt?: string; triggeredBy?: { name?: string } | null }[]
      }
      if (!Array.isArray(parsed.entries)) continue
      parsed.entries.forEach((e, i) => {
        if (typeof e?.ticket !== 'string') return
        out.push({
          kind,
          ticket: e.ticket,
          position: i + 1,
          enqueuedAt: typeof e.enqueuedAt === 'string' ? e.enqueuedAt : '',
          triggeredBy: e.triggeredBy?.name ?? null,
        })
      })
    } catch (err) {
      console.error(`readQueuedTickets: 解析 ${p} 失敗: ${err}`)
    }
  }
  return out
}
