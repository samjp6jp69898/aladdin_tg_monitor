// Pipeline 列表「發起人」欄位：沒有任何 log/DB 紀錄「誰在 Telegram 點的」
// （bug pipeline 的 spawnCreateMr 完全不傳身份，demand pipeline 的
// assigneeEmail 只活在 ps 命令列、process 結束就沒了），改用 Notion 當下的
// 指派人當代理值（跟 telegram-dispatcher/lib/pipeline-runner/post-run-notify.ts
// 同一個既有原則：認領判斷全程以 Notion 為準）。
//
// 全程只呼叫 scripts/notion.sh（唯讀 query-datasource），不自己 fetch
// Notion API、不碰 token。查詢用 execFile（非同步）＋背景 collector tick
// 分批補齊快取，避免請求路徑等 Notion 網路往返、也避免短時間內對同一票
// 重複打 API。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const NOTION_SH = '/Users/user/aladdin/scripts/notion.sh'
// 兩個 database 各自的 data source id / 單號屬性名 / 指派人屬性名，比照
// telegram-dispatcher/lib/notion-integration/{candidate-tickets,demand-pool-tickets}.ts。
const BUG_DATA_SOURCE_ID = '21c87d78-618a-817f-ae71-000baa9ab11b'
const DEMAND_DATA_SOURCE_ID = '21d87d78-618a-8135-ad4f-000b273e1293'

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_RESOLVE_PER_TICK = 3

type CacheEntry = { name: string | null; at: number }
const cache = new Map<string, CacheEntry>()
const inFlight = new Set<string>()

function ticketQuery(ticket: string): { dataSourceId: string; filter: object; peopleProp: string } | null {
  let m = /^FAQ-(\d+)$/.exec(ticket)
  if (m) return { dataSourceId: BUG_DATA_SOURCE_ID, filter: { property: '單號', unique_id: { equals: Number(m[1]) } }, peopleProp: '當前指派' }
  m = /^ALDREQ-(\d+)$/.exec(ticket)
  if (m) return { dataSourceId: DEMAND_DATA_SOURCE_ID, filter: { property: 'ID', unique_id: { equals: Number(m[1]) } }, peopleProp: '技術處理人員' }
  return null
}

async function resolveOne(ticket: string): Promise<string | null> {
  const q = ticketQuery(ticket)
  if (!q) return null
  try {
    const { stdout: raw } = await execFileAsync('bash', [NOTION_SH, 'query-datasource', q.dataSourceId, JSON.stringify(q.filter)], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    const parsed = JSON.parse(raw)
    const page = Array.isArray(parsed.results) ? parsed.results[0] : null
    const people = page?.properties?.[q.peopleProp]?.people
    if (!Array.isArray(people) || !people.length) return null
    return people.map((p: any) => p.name).filter(Boolean).join('、') || null
  } catch {
    return null
  }
}

/** 列表 API 直接讀快取，不等待 Notion；undefined = 還沒解析過。 */
export function getCachedAssignee(ticket: string): string | null | undefined {
  return cache.get(ticket)?.name
}

/** collector tick 呼叫：挑幾筆快取過期/沒快取的票補上，每次補少量避免打爆 Notion API。 */
export async function refreshAssignees(tickets: string[]): Promise<void> {
  const now = Date.now()
  const seen = new Set<string>()
  const stale = tickets.filter(t => {
    if (seen.has(t) || inFlight.has(t)) return false
    seen.add(t)
    const e = cache.get(t)
    return !e || now - e.at > CACHE_TTL_MS
  })
  for (const ticket of stale.slice(0, MAX_RESOLVE_PER_TICK)) {
    inFlight.add(ticket)
    try {
      const name = await resolveOne(ticket)
      cache.set(ticket, { name, at: Date.now() })
    } finally {
      inFlight.delete(ticket)
    }
  }
}
