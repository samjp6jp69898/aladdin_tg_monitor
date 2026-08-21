// 監控對象登錄表：tg-dispatcher 本體 + 它 proxy 的五支 hosted MCP server + ngrok。
// port / 路徑皆對照 telegram-dispatcher/lib/webhook-server/mcp-proxy.ts 的 PROXY_ROUTES
// 與各 launchd/run-server*.sh 內的 export 值；改動那邊時這裡要同步。

const ALADDIN = '/Users/user/aladdin'
const MCPS = `${ALADDIN}/obsidian/mcps`
const DISPATCHER = `${ALADDIN}/telegram-dispatcher`

export type ServiceDef = {
  id: string
  name: string
  port: number
  /** 本機存活探測 URL（一律走 127.0.0.1，不經公網，見 telegram-dispatcher/README.md） */
  healthUrl: string
  /** proxy 對外前綴（dispatcher 自身 / ngrok 沒有） */
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
    id: 'ngrok',
    name: 'ngrok tunnel',
    port: 4040,
    healthUrl: 'http://127.0.0.1:4040/api/tunnels',
    launchdLabel: 'com.aladdin.tg-dispatch-tunnel',
    logs: [
      { label: 'launchd-tunnel.err', path: `${DISPATCHER}/logs/launchd-tunnel.err.log` },
      { label: 'launchd-tunnel.out', path: `${DISPATCHER}/logs/launchd-tunnel.out.log` },
    ],
  },
  {
    id: 'toolsmith',
    name: 'aladdin-toolsmith',
    port: 8788,
    healthUrl: 'http://127.0.0.1:8788/health',
    proxyPrefix: '/toolsmith',
    launchdLabel: 'com.aladdin.mcp-toolsmith-server',
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
