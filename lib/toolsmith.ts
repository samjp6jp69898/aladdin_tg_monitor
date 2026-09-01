// aladdin_toolsmith_generate_tool 的即時進度來源：直接讀 scratch/<requestId>/
// 底下的 conversation.json（唯一真相來源，背景任務每個階段轉換都會存檔，見
// aladdin_mcps/aladdin-toolsmith/src/agent/conversation.ts）。不落地成 SQLite——
// 目錄數量小（未清理但也就幾百筆等級），每次請求即時 readdir+JSON.parse 比額外
// 維護一份收集器與資料表簡單，且天生沒有「收集器還沒掃到」的落後問題。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLSMITH_LOGS_DIR, TOOLSMITH_SCRATCH_DIR } from './services.ts'

interface ConversationRound { questions: string[]; answers?: string }
interface ConversationState {
  target: 'admin' | 'platform'
  request: string
  notes?: string
  rounds: ConversationRound[]
  codingStarted: boolean
  completed: boolean
  requestedBy: string
  createdAt: string
  updatedAt: string
  status: 'queued' | 'researching' | 'needs_clarification' | 'deploying' | 'done' | 'failed'
  finalResult?: { success: boolean; errorKind?: string; stage?: string; message: string; warnings?: string[] }
}

// 對照 aladdin_mcps/aladdin-toolsmith/src/agent/deploy-pipeline.ts 的 log() 字面文字。
// 那邊沒有結構化的逐關卡狀態欄位，deploy.log 是唯一的進度來源，這裡用它固定
// 會寫出的關鍵字反推每個關卡的 pass/fail/pending——那些字面文字是這支監控頁面
// 對 deploy-pipeline.ts 的唯一耦合點，deploy-pipeline.ts 改了訊息文字要同步改這裡。
const GATE_DEFS: { key: string; label: string; fail: RegExp; pass: RegExp }[] = [
  { key: 'precondition', label: 'precondition', fail: /precondition 失敗/, pass: /precondition：/ },
  { key: 'tsc', label: 'Gate A（tsc）', fail: /(套用檔案失敗|tsc 出現新錯誤)/, pass: /Gate A（tsc）通過/ },
  { key: 'adversarial', label: 'Gate B（對抗性覆核）', fail: /Gate B（對抗性覆核）未通過/, pass: /Gate B（對抗性覆核）通過/ },
  { key: 'commit', label: 'commit', fail: /commit 失敗/, pass: /commit 完成/ },
  { key: 'reload', label: 'reload', fail: /reload 失敗/, pass: /reload 完成/ },
  { key: 'push', label: 'push', fail: /push 失敗/, pass: /push 完成/ },
]

function parseGates(deployLogText: string): { key: string; label: string; status: 'pass' | 'fail' | 'pending' }[] {
  const lines = deployLogText.split('\n')
  return GATE_DEFS.map(def => {
    for (const line of lines) {
      if (def.fail.test(line)) return { key: def.key, label: def.label, status: 'fail' as const }
    }
    for (const line of lines) {
      if (def.pass.test(line)) return { key: def.key, label: def.label, status: 'pass' as const }
    }
    return { key: def.key, label: def.label, status: 'pending' as const }
  })
}

export interface ToolsmithRunRow {
  requestId: string
  target: 'admin' | 'platform'
  requestedBy: string
  request: string
  notes: string | null
  status: ConversationState['status']
  completed: boolean
  roundsCount: number
  pendingQuestions: string[] | null
  createdAt: string
  updatedAt: string
  finalResult: ConversationState['finalResult'] | null
  agentLogPath: string
  agentLogExists: boolean
  deployLogPath: string
  deployLogExists: boolean
  gates: { key: string; label: string; status: 'pass' | 'fail' | 'pending' }[] | null
}

export function listToolsmithRuns(limit = 200): ToolsmithRunRow[] {
  let entries: string[]
  try {
    entries = readdirSync(TOOLSMITH_SCRATCH_DIR)
  } catch {
    return []
  }
  const rows: ToolsmithRunRow[] = []
  for (const requestId of entries) {
    const dir = join(TOOLSMITH_SCRATCH_DIR, requestId)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const convPath = join(dir, 'conversation.json')
    if (!existsSync(convPath)) continue
    let state: ConversationState
    try {
      state = JSON.parse(readFileSync(convPath, 'utf8')) as ConversationState
    } catch {
      continue
    }
    const agentLogPath = join(TOOLSMITH_LOGS_DIR, `${requestId}.log`)
    const deployLogPath = join(dir, 'deploy.log')
    const deployLogExists = existsSync(deployLogPath)
    const lastRound = state.rounds[state.rounds.length - 1]
    rows.push({
      requestId,
      target: state.target,
      requestedBy: state.requestedBy,
      request: state.request,
      notes: state.notes ?? null,
      status: state.status,
      completed: state.completed,
      roundsCount: state.rounds.length,
      pendingQuestions: state.status === 'needs_clarification' && lastRound ? lastRound.questions : null,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      finalResult: state.finalResult ?? null,
      agentLogPath,
      agentLogExists: existsSync(agentLogPath),
      deployLogPath,
      deployLogExists,
      gates: deployLogExists ? parseGates(readFileSync(deployLogPath, 'utf8')) : null,
    })
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return rows.slice(0, limit)
}
