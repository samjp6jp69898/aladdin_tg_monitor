// 監控對象登錄表：tg-dispatcher 本體 + 它 proxy 的九支 hosted MCP server + Cloudflare tunnel。
// port / 路徑皆對照 telegram-dispatcher/lib/webhook-server/mcp-proxy.ts 的 PROXY_ROUTES
// 與各 launchd/run-server*.sh 內的 export 值；改動那邊時這裡要同步。

import { execFileSync } from 'node:child_process'

const ALADDIN = '/Users/user/aladdin'
const MCPS = `${ALADDIN}/aladdin_mcps`
const DISPATCHER = `${ALADDIN}/telegram-dispatcher`

export type ServiceDef = {
  id: string
  name: string
  port: number
  /** 本機存活探測 URL（一律走 127.0.0.1，不經公網，見 telegram-dispatcher/README.md） */
  healthUrl: string
  /** proxy 對外前綴（dispatcher 自身 / cloudflare-tunnel 沒有） */
  proxyPrefix?: string
  launchdLabel?: string
  /** 稽核 JSONL（H32）；只有 hosted MCP server 有 */
  auditLog?: string
  /** Bearer token 名冊；用來把 identity 對回 id / issued_at */
  tokensPath?: string
  /** 可在 UI 裡 tail 的純文字 log */
  logs: { label: string; path: string }[]
}

export const SERVICES: ServiceDef[] = [
  {
    id: 'dispatcher',
    name: 'tg-dispatcher (webhook)',
    port: 8787,
    healthUrl: 'http://127.0.0.1:8787/health',
    launchdLabel: 'com.aladdin.tg-dispatch-server',
    logs: [
      { label: 'launchd-server.err', path: `${DISPATCHER}/logs/launchd-server.err.log` },
      { label: 'launchd-server.out', path: `${DISPATCHER}/logs/launchd-server.out.log` },
      { label: 'demand-pipeline', path: `${DISPATCHER}/logs/demand-pipeline.log` },
      { label: 'post-run-notify', path: `${DISPATCHER}/logs/post-run-notify.log` },
      { label: 'health-monitor', path: `${DISPATCHER}/logs/health-monitor.log` },
      { label: 'spawn-errors', path: `${DISPATCHER}/logs/spawn-errors.log` },
    ],
  },
  {
    // 2026-08-25：ngrok 已退役（com.aladdin.tg-dispatch-tunnel 已 bootout），
    // 改監控 Cloudflare Tunnel（aladdin-mcp）本機 connector，查 cloudflared
    // 自帶的 metrics /ready（見 telegram-dispatcher/lib/webhook-server/
    // health-monitor.ts 同一套判準）。
    id: 'cloudflare-tunnel',
    name: 'Cloudflare tunnel (aladdin-mcp)',
    port: 20241,
    healthUrl: 'http://127.0.0.1:20241/ready',
    launchdLabel: 'com.aladdin.tg-dispatch-tunnel-cloudflare',
    logs: [
      { label: 'launchd-tunnel-cloudflare.err', path: `${DISPATCHER}/logs/launchd-tunnel-cloudflare.err.log` },
      { label: 'launchd-tunnel-cloudflare.out', path: `${DISPATCHER}/logs/launchd-tunnel-cloudflare.out.log` },
    ],
  },
  {
    id: 'toolsmith',
    name: 'aladdin-toolsmith',
    port: 8788,
    healthUrl: 'http://127.0.0.1:8788/health',
    proxyPrefix: '/toolsmith',
    launchdLabel: 'com.aladdin.mcp-toolsmith-server',
    // 2026-08-31：toolsmith 補上 audit_log.ts（比照 aladdin-admin/aladdin-platform
    // 的 H32 稽核 log），從此有 per-request 稽核可讀，「使用 Session」「即時
    // 序列」等分頁不再只有 admin/platform 看得到 tool 使用紀錄。
    auditLog: `${MCPS}/aladdin-toolsmith/logs/audit.jsonl`,
    tokensPath: `${MCPS}/aladdin-toolsmith/tokens.json`,
    logs: [
      { label: 'launchd-server.err', path: `${MCPS}/aladdin-toolsmith/logs/launchd-server.err.log` },
      { label: 'launchd-server.out', path: `${MCPS}/aladdin-toolsmith/logs/launchd-server.out.log` },
    ],
  },
  {
    id: 'admin-dev',
    name: 'aladdin-admin (dev)',
    port: 8789,
    healthUrl: 'http://127.0.0.1:8789/health',
    proxyPrefix: '/mcp-admin-dev',
    launchdLabel: 'com.aladdin.mcp-admin-server',
    auditLog: `${MCPS}/aladdin-admin/logs/audit.jsonl`,
    tokensPath: `${MCPS}/aladdin-admin/tokens.json`,
    logs: [
      { label: 'launchd-server.err', path: `${MCPS}/aladdin-admin/logs/launchd-server.err.log` },
      { label: 'launchd-server.out', path: `${MCPS}/aladdin-admin/logs/launchd-server.out.log` },
    ],
  },
  {
    id: 'platform',
    name: 'aladdin-platform (dev-pk)',
    port: 8790,
    healthUrl: 'http://127.0.0.1:8790/health',
    proxyPrefix: '/mcp-platform',
    launchdLabel: 'com.aladdin.mcp-platform-server',
    auditLog: `${MCPS}/aladdin-platform/logs/audit.jsonl`,
    tokensPath: `${MCPS}/aladdin-platform/tokens.json`,
    logs: [
      { label: 'launchd-server.err', path: `${MCPS}/aladdin-platform/logs/launchd-server.err.log` },
      { label: 'launchd-server.out', path: `${MCPS}/aladdin-platform/logs/launchd-server.out.log` },
    ],
  },
  {
    // 2026-08-27：platform-dev-6t 上線（見 aladdin-platform/launchd/
    // run-server-dev-6t.sh、mcp-proxy.ts PROXY_ROUTES），跟 'platform'（dev-pk）
    // 是各自獨立的名冊/常駐服務，比照 admin-pre/admin-evi 的隔離慣例。
    id: 'platform-6t',
    name: 'aladdin-platform (dev-6t)',
    port: 8793,
    healthUrl: 'http://127.0.0.1:8793/health',
    proxyPrefix: '/mcp-platform-dev-6t',
    launchdLabel: 'com.aladdin.mcp-platform-dev-6t-server',
    auditLog: `${MCPS}/aladdin-platform/logs/audit.dev-6t.jsonl`,
    tokensPath: `${MCPS}/aladdin-platform/tokens.dev-6t.json`,
    logs: [
      { label: 'launchd-dev-6t-server.err', path: `${MCPS}/aladdin-platform/logs/launchd-dev-6t-server.err.log` },
      { label: 'launchd-dev-6t-server.out', path: `${MCPS}/aladdin-platform/logs/launchd-dev-6t-server.out.log` },
    ],
  },
  {
    // 2026-08-27：pre×PK/pre×6T/evi×6T 三個同批比照 platform-6t 開放。
    id: 'platform-pre-pk',
    name: 'aladdin-platform (pre-pk)',
    port: 8794,
    healthUrl: 'http://127.0.0.1:8794/health',
    proxyPrefix: '/mcp-platform-pre-pk',
    launchdLabel: 'com.aladdin.mcp-platform-pre-pk-server',
    auditLog: `${MCPS}/aladdin-platform/logs/audit.pre-pk.jsonl`,
    tokensPath: `${MCPS}/aladdin-platform/tokens.pre-pk.json`,
    logs: [
      { label: 'launchd-pre-pk-server.err', path: `${MCPS}/aladdin-platform/logs/launchd-pre-pk-server.err.log` },
      { label: 'launchd-pre-pk-server.out', path: `${MCPS}/aladdin-platform/logs/launchd-pre-pk-server.out.log` },
    ],
  },
  {
    id: 'platform-pre-6t',
    name: 'aladdin-platform (pre-6t)',
    port: 8795,
    healthUrl: 'http://127.0.0.1:8795/health',
    proxyPrefix: '/mcp-platform-pre-6t',
    launchdLabel: 'com.aladdin.mcp-platform-pre-6t-server',
    auditLog: `${MCPS}/aladdin-platform/logs/audit.pre-6t.jsonl`,
    tokensPath: `${MCPS}/aladdin-platform/tokens.pre-6t.json`,
    logs: [
      { label: 'launchd-pre-6t-server.err', path: `${MCPS}/aladdin-platform/logs/launchd-pre-6t-server.err.log` },
      { label: 'launchd-pre-6t-server.out', path: `${MCPS}/aladdin-platform/logs/launchd-pre-6t-server.out.log` },
    ],
  },
  {
    // evi 目前只有 6T 產品的後台網址，沒有 evi×PK（見 mcp-proxy.ts PROXY_ROUTES 註解）。
    id: 'platform-evi-6t',
    name: 'aladdin-platform (evi-6t)',
    port: 8796,
    healthUrl: 'http://127.0.0.1:8796/health',
    proxyPrefix: '/mcp-platform-evi-6t',
    launchdLabel: 'com.aladdin.mcp-platform-evi-6t-server',
    auditLog: `${MCPS}/aladdin-platform/logs/audit.evi-6t.jsonl`,
    tokensPath: `${MCPS}/aladdin-platform/tokens.evi-6t.json`,
    logs: [
      { label: 'launchd-evi-6t-server.err', path: `${MCPS}/aladdin-platform/logs/launchd-evi-6t-server.err.log` },
      { label: 'launchd-evi-6t-server.out', path: `${MCPS}/aladdin-platform/logs/launchd-evi-6t-server.out.log` },
    ],
  },
  {
    id: 'admin-pre',
    name: 'aladdin-admin (pre/cqa)',
    port: 8791,
    healthUrl: 'http://127.0.0.1:8791/health',
    proxyPrefix: '/mcp-admin-pre',
    launchdLabel: 'com.aladdin.mcp-admin-pre-server',
    auditLog: `${MCPS}/aladdin-admin/logs/audit.pre.jsonl`,
    tokensPath: `${MCPS}/aladdin-admin/tokens.pre.json`,
    logs: [
      { label: 'launchd-pre-server.err', path: `${MCPS}/aladdin-admin/logs/launchd-pre-server.err.log` },
      { label: 'launchd-pre-server.out', path: `${MCPS}/aladdin-admin/logs/launchd-pre-server.out.log` },
    ],
  },
  {
    id: 'admin-evi',
    name: 'aladdin-admin (evi)',
    port: 8792,
    healthUrl: 'http://127.0.0.1:8792/health',
    proxyPrefix: '/mcp-admin-evi',
    launchdLabel: 'com.aladdin.mcp-admin-evi-server',
    auditLog: `${MCPS}/aladdin-admin/logs/audit.evi.jsonl`,
    tokensPath: `${MCPS}/aladdin-admin/tokens.evi.json`,
    logs: [
      { label: 'launchd-evi-server.err', path: `${MCPS}/aladdin-admin/logs/launchd-evi-server.err.log` },
      { label: 'launchd-evi-server.out', path: `${MCPS}/aladdin-admin/logs/launchd-evi-server.out.log` },
    ],
  },
]

export const DISPATCHER_LOG_DIR = `${DISPATCHER}/logs`
export const AGENT_TRACE_DIR = `${DISPATCHER}/logs/agent-traces`
export const BUG_LOCK_DIR = '/tmp/bug-analysis-locks'
export const WORKTREES_DIR = `${ALADDIN}/worktrees`

/** UI 可 tail 的 log 路徑白名單（只允許登錄表內的檔案 + dispatcher 的 pipeline 逐票 log） */
export function isAllowedLogPath(p: string): boolean {
  if (SERVICES.some(s => s.logs.some(l => l.path === p))) return true
  return p.startsWith(`${DISPATCHER_LOG_DIR}/`) && !p.includes('..') && p.endsWith('.log')
}

/** agent trace 可讀範圍：agent-traces 目錄下的 .json，或 dispatcher logs 下的 stdout.log（bug pipeline） */
export function isAllowedTracePath(p: string): boolean {
  if (p.includes('..')) return false
  if (p.startsWith(`${AGENT_TRACE_DIR}/`) && p.endsWith('.json')) return true
  return p.startsWith(`${DISPATCHER_LOG_DIR}/`) && p.endsWith('.stdout.log')
}

/**
 * 重啟登錄表內的服務：只接受登錄表內、有 launchdLabel 的 id（不接受任意字串當
 * label，避免呼叫端亂傳字串就能重啟這台機器上任何 launchd job）。用
 * `launchctl kickstart -k` 而不是直接 kill——KeepAlive 的服務其實 kill 掉也會
 * 自動被拉回來，但 kickstart -k 語意明確（「我要它現在重開」），且對非
 * KeepAlive 的 job（目前登錄表內沒有，但未來若加）也一樣有效。
 *
 * 只接受本機請求（server.ts 只綁 127.0.0.1），呼叫端見 server.ts 的
 * POST /api/services/restart。
 */
export function restartService(id: string): { ok: boolean; result: string } {
  const svc = SERVICES.find(s => s.id === id)
  if (!svc) return { ok: false, result: `RESTART_ERR_UNKNOWN_ID: ${id}` }
  if (!svc.launchdLabel) return { ok: false, result: `RESTART_ERR_NO_LAUNCHD_LABEL: ${id}` }
  try {
    const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim()
    execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${svc.launchdLabel}`], { encoding: 'utf8', timeout: 10_000 })
    return { ok: true, result: `RESTART_OK: ${svc.launchdLabel}` }
  } catch (err: any) {
    return { ok: false, result: `RESTART_ERR_EXEC: ${err?.message ?? err}` }
  }
}
