// scripts/verify-stream.ts — `/api/stream` 的可重跑驗收（plan-db-as-truth-v3.md §8.2）。
//
//   cd /Users/user/aladdin/tg-monitor && bun run scripts/verify-stream.ts [sqlite|mysql]
//   （不帶參數＝sqlite；退出碼 0 = 全過）
//
// 為什麼要有這一支：`/api/stream` 的行為（參數驗證、event 名稱、與 GET 端點同形、
// log 增量與截斷、背壓下不掉內容、硬斷線後 server 存活）沒有辦法用 `bun test` 的
// 純靜態斷言涵蓋——那些性質只有真的把 server 跑起來、真的接一條 SSE 上去才驗得到。
// 對抗審查明確指出「人工跑過但沒留下可重跑的產物」不算數，所以把當時的人工步驟
// 固化成這支腳本。與 `scripts/sse-segfault-repro.ts` 的分工：
//   - sse-segfault-repro.ts：驗 **Bun 這個 runtime** 的 ReadableStream 斷線行為（前置關卡）
//   - 本檔：驗 **tg-monitor 這個端點** 的契約與語意
//
// 副作用邊界（誠實列出，第一版踩過一次）：
//   - 另起一個 server（隨機空 port），`TG_MONITOR_DB` 指向 VACUUM INTO 出來的暫存
//     sqlite 副本 → **不寫 data/monitor.sqlite**；
//   - 對監控 DB 只有 SELECT——**子行程以 `MON_DB_ENABLED=0` 派生**，所以它的
//     collector 不會寫 spool / 心跳 / runs（見下方 spawn 處的註解）。這一句在
//     2026-09-03 之前是不真的：子行程繼承了 live 的 `MON_DB_ENABLED=1`；
//   - log 那一節會在 `DISPATCHER_LOG_DIR` 底下造一個**自己的**檔案再刪掉
//     （白名單只涵蓋那個目錄，所以不能放到 /tmp）。檔名刻意避開 collector 的
//     pipeline log 規則——見該節的註解，第一版沒避開，害線上 collector 生出四筆
//     假的 pipeline run。不動任何既有 log 檔。

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { DISPATCHER_LOG_DIR } from '../lib/services.ts'

const source = (process.argv[2] ?? 'sqlite') as 'sqlite' | 'mysql'
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

const tmp = mkdtempSync(join(tmpdir(), 'tg-monitor-stream-'))
// WAL 模式的 sqlite 只 cp 主檔會靜默漏掉尚未 checkpoint 的寫入（impl-constraints-addendum
// §4 實測），所以用 VACUUM INTO 做快照。
const dbCopy = join(tmp, 'monitor.sqlite')
{
  const src = new Database(join(REPO, 'data/monitor.sqlite'), { readonly: true })
  src.exec(`VACUUM INTO '${dbCopy}'`)
  src.close()
}

function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}
const PORT = freePort()

const proc = Bun.spawn(['bun', 'run', join(REPO, 'server.ts')], {
  cwd: REPO,
  // MON_DB_ENABLED: '0' 是**必要的**，不是保險（Reviewer B MAJOR-4）：
  // `process.env` 含 Bun 從 cwd 自動載入的 .env，若 live 是 '1' 就會被繼承，
  // 而 server.ts:57 無條件 startCollectors() ⇒ 子行程開機就 probeAll()（每個
  // service 各落一筆基準列進真實 SPOOL_DIR）、heartbeatTick()（覆蓋 live 的
  // (host,'tg-monitor') 心跳）、scanPipelineRuns()（對 live runs 發 UPDATE）。
  // 那些 spool 條目由 head 的重放者原封寫進 live service_status_log /
  // monitor_heartbeat —— **驗收腳本污染它正在觀測的系統**，而且檔頭還寫著
  // 「對監控 DB 只有 SELECT」。
  // 讀取面與寫入面本就獨立（lib/read/source.ts:5-6 自己這麼說），所以關掉寫入面
  // 不影響 `MON_READ_SOURCE=mysql` 的驗收——實測子行程仍回
  // {effective:'mysql', degraded:false}。
  env: {
    ...process.env,
    TG_MONITOR_PORT: String(PORT),
    TG_MONITOR_DB: dbCopy,
    MON_READ_SOURCE: source,
    MON_DB_ENABLED: '0',
  },
  stdout: 'pipe',
  stderr: 'pipe',
})

const base = `http://127.0.0.1:${PORT}`
let fails = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) fails++
}

async function waitReady(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/status-log`)).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('server 起不來')
}

/** 從一條 SSE 連線收事件，直到 want 裡的 topic 都收到（或逾時）。 */
async function collect(url: string, want: string[], timeoutMs = 20_000) {
  const ac = new AbortController()
  const res = await fetch(url, { signal: ac.signal })
  const got = new Map<string, any>()
  const comments: string[] = []
  if (!res.ok || !res.body) return { res, got, comments, abort: () => ac.abort() }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (want.some(t => !got.has(t)) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (block.startsWith(':')) { comments.push(block); continue }
        const ev = /^event: (.+)$/m.exec(block)
        const data = /^data: (.*)$/m.exec(block)
        if (ev && data) got.set(ev[1], JSON.parse(data[1]))
      }
    }
  } catch {}
  return { res, got, comments, abort: () => ac.abort() }
}

try {
  await waitReady()

  // ── 0. 前置關卡：資料源必須真的是啟動參數要的那個 ─────────────────────
  //
  // **為什麼是前置關卡而不是最後一格**（Reviewer B BLOCKER-1）：
  // 原本這一格在檔尾，判準是 `j.effective === source || j.degraded === true`
  // ——那個 `|| degraded` 讓它在**唯一該紅的情況**（要 mysql、實際跑 sqlite）
  // 恆綠。而子行程的探針有 3 秒期限（lib/read/index.ts:25），失敗即靜默退回
  // sqlite（index.ts:64-70，設計如此）。於是整支腳本的 §1–§7 會在一個
  // **退化成 sqlite** 的 server 上跑完並全綠，`switch-readiness.ts` 的
  // 「verify-stream.ts mysql（27 項端點行為）」印 [OK]，而 mysql 讀取面
  // 一行 SQL 都沒被打到。
  //
  // 具體後果：`serviceAuditStats`（/api/overview 的核心 SQL）若有回歸，
  // C 組沒有任何一格會呼叫它，唯一覆蓋它的就是本腳本的 overview topic——
  // 正是可以在 sqlite 上跑完判綠的那一格。結論會印「可以切」，切過去
  // /api/overview 與 SSE overview 直接 500。
  //
  // 所以：`&&` 而不是 `||`，而且**擋在前面**——degraded 就整支 FAIL、
  // 後面 26 格不再跑（它們的結果在錯誤的資料源上沒有意義）。
  {
    const j: any = await (await fetch(`${base}/api/read-source`)).json()
    check('/api/read-source 回報 requested/effective/degraded', ['requested', 'effective', 'degraded'].every(k => k in j), JSON.stringify(j))
    const sourceOk = j.effective === source && j.degraded === false
    check(`【前置】effective 與啟動參數一致且未降級（期望 ${source}）`, sourceOk, JSON.stringify(j))
    if (!sourceOk) {
      console.log('FAIL 前置關卡未過：資料源不是啟動參數要的那個，後續 26 格在錯誤的資料源上沒有意義，中止。')
      throw new Error(`verify-stream 前置關卡：期望 effective=${source} 且 degraded=false，實際 ${JSON.stringify(j)}`)
    }
  }

  // ── 1. 參數驗證：都必須在開串流之前以一般 HTTP 回應送出 ────────────────
  for (const [q, want] of [
    ['', 400],
    ['topics=nope', 400],
    ['topics=overview,nope', 400],
    ['topics=pipeline-run', 400],
    ['topics=log', 403],
    ['topics=log&path=/etc/passwd', 403],
    ['topics=log&path=../../etc/passwd', 403],
  ] as const) {
    const r = await fetch(`${base}/api/stream?${q}`)
    check(`參數驗證 ?${q || '(空)'}`, r.status === want, `${r.status}（期望 ${want}）`)
    await r.body?.cancel()
  }

  // ── 2. event 名稱與「與對應 GET 端點同形」 ─────────────────────────────
  {
    const { res, got, abort } = await collect(`${base}/api/stream?topics=overview,pipelines,toolsmith`, ['overview', 'pipelines', 'toolsmith'])
    check('content-type 是 text/event-stream', (res.headers.get('content-type') ?? '').startsWith('text/event-stream'))
    for (const [topic, path] of [['overview', '/api/overview'], ['pipelines', '/api/pipelines'], ['toolsmith', '/api/toolsmith']] as const) {
      check(`收到 event: ${topic}`, got.has(topic))
      const j: any = await (await fetch(`${base}${path}`)).json()
      const a = Object.keys(j).sort().join(',')
      const b = Object.keys(got.get(topic) ?? {}).sort().join(',')
      check(`${topic} 與 GET ${path} 頂層同形`, a === b, a === b ? '' : `GET=[${a}] SSE=[${b}]`)
    }
    abort()
  }

  // ── 3. pipeline-run：命中與查無此 key 的兩種行為 ────────────────────────
  {
    const list: any = await (await fetch(`${base}/api/pipelines`)).json()
    const someKey = list.rows?.[0]?.key
    if (!someKey) {
      check('pipeline-run（跳過：沒有可取樣的 run）', true)
    } else {
      const { got, abort } = await collect(`${base}/api/stream?topics=pipeline-run&key=${encodeURIComponent(someKey)}`, ['pipeline-run'])
      const p = got.get('pipeline-run')
      const j: any = await (await fetch(`${base}/api/pipelines/run?key=${encodeURIComponent(someKey)}`)).json()
      check('pipeline-run 命中時與 GET 同形', Object.keys(p ?? {}).sort().join(',') === Object.keys(j).sort().join(','))
      abort()
    }
    // 查無此 key：**不可以**推一份 { error: 'not found' } 當成功 payload
    // （前端的 notFound 判斷會因為 data 是 truthy 而失效）。正確行為是讓串流
    // 以錯誤收場，前端 onerror → 依 transport.ts 的既定計畫降級回輪詢。
    const { got, res } = await collect(`${base}/api/stream?topics=pipeline-run&key=__does_not_exist__`, ['pipeline-run'], 8_000)
    check('pipeline-run 查無 key 時不推成功 payload', res.ok && !got.has('pipeline-run'), got.has('pipeline-run') ? `卻收到 ${JSON.stringify(got.get('pipeline-run'))}` : '')
  }

  // ── 4. log topic：增量、截斷歸零、與 /api/log/since 同形 ────────────────
  {
    // 用 DISPATCHER_LOG_DIR 底下自己造的檔案（`isAllowedLogPath` 對該目錄下任何
    // `*.log` 都放行），跑完就刪，不動任何既有 log。
    //
    // ⚠️ 檔名**刻意不長得像 pipeline log**：`lib/ingest.ts:87-88` 的
    //   BUG_RE   = /^([A-Z]+-\d+)\.(<ts>)\.stdout\.log$/
    //   DEMAND_RE= /^([A-Z]+-\d+)\.(<ts>)\.demand-pipeline\.stdout\.log$/
    // 是 collector 掃 pipeline run 的依據。第一版用了 `ZZTEST-0.<ts>.stdout.log`，
    // 結果**線上那個 tg-monitor 的 collector 真的把它收進了 live monitor.sqlite**，
    // 憑空生出四筆假的 pipeline run（已清掉）。小寫前綴 + 不帶 `-<數字>.` 就不會命中
    // 這兩條 regex，也就不會被任何 collector 當成真的 run。
    const logPath = join(DISPATCHER_LOG_DIR, `sse-verify-${Date.now()}.log`)
    writeFileSync(logPath, 'line-1\nline-2\n')
    try {
      const ac = new AbortController()
      const res = await fetch(`${base}/api/stream?topics=log&path=${encodeURIComponent(logPath)}&offset=0`, { signal: ac.signal })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const frames: any[] = []
      const pump = async (untilCount: number, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs
        while (frames.length < untilCount && Date.now() < deadline) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const m = /^event: log\ndata: (.*)$/m.exec(block)
            if (m) frames.push(JSON.parse(m[1]))
          }
        }
      }
      await pump(1, 10_000)
      check('log 首幀形狀是 { text, offset }', Object.keys(frames[0] ?? {}).sort().join(',') === 'offset,text', JSON.stringify(frames[0]))
      check('log 首幀帶到既有內容', (frames[0]?.text ?? '').includes('line-1'), `offset=${frames[0]?.offset}`)

      appendFileSync(logPath, 'line-3\n')
      await pump(2, 10_000)
      check('log 增量只送新增的那一段', frames[1]?.text === 'line-3\n', JSON.stringify(frames[1]))
      check('log 增量 offset 前進', (frames[1]?.offset ?? 0) > (frames[0]?.offset ?? 0))

      // 截斷成 0 bytes：/api/log/since 在這個情況會回 { text:'', offset:0 }，
      // 前端靠 `res.offset < offsetRef.current` 清空畫面。串流這側如果因為
      // 「沒有新內容就整拍不推」而什麼都不送，前端會永遠卡在舊內容上。
      truncateSync(logPath, 0)
      await pump(3, 10_000)
      check('log 被截斷成 0 bytes 時有推出 offset 歸零的訊框', frames[2]?.offset === 0 && frames[2]?.text === '', JSON.stringify(frames[2]))
      ac.abort()
    } finally {
      rmSync(logPath, { force: true })
    }
  }

  // ── 5. 含換行的 payload 不會破壞 SSE 訊框 ──────────────────────────────
  {
    // log 的 text 一定含換行；上一節已經解析成功就代表訊框沒壞。這裡再直接檢查
    // 原始位元組：data 行內不得出現裸 LF（JSON.stringify 會把 \n 轉成兩字元跳脫）。
    const ac = new AbortController()
    const res = await fetch(`${base}/api/stream?topics=overview`, { signal: ac.signal })
    const { value } = await res.body!.getReader().read()
    const chunk = new TextDecoder().decode(value ?? new Uint8Array())
    const dataLines = chunk.split('\n').filter(l => l.startsWith('data: '))
    check('每個 data 都是單行（payload 內的換行已被跳脫）', dataLines.length > 0 && dataLines.every(l => !l.includes('\r')))
    ac.abort()
  }

  // ── 6. 連線數上限 ─────────────────────────────────────────────────────
  {
    const acs: AbortController[] = []
    let saw503 = false
    try {
      for (let i = 0; i < 40; i++) {
        const ac = new AbortController()
        acs.push(ac)
        const r = await fetch(`${base}/api/stream?topics=toolsmith`, { signal: ac.signal })
        if (r.status === 503) { saw503 = true; await r.body?.cancel(); break }
      }
      check('超過連線數上限時回 503（不是靜默排隊）', saw503)
    } finally {
      for (const ac of acs) ac.abort()
    }
    // 斷開後名額要放回去，否則上限會單向耗盡
    await new Promise(r => setTimeout(r, 500))
    const again = await fetch(`${base}/api/stream?topics=toolsmith`)
    check('連線斷開後名額有放回去', again.status === 200, `${again.status}`)
    await again.body?.cancel()
  }

  // ── 7. 硬斷線 × 8 後 server 仍存活（同步 spawn 禁令那條踩坑的現場驗證）──
  {
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const ac = new AbortController()
        try {
          const res = await fetch(`${base}/api/stream?topics=overview,pipelines,toolsmith`, { signal: ac.signal })
          await res.body!.getReader().read()
          ac.abort()
        } catch {}
      }),
    )
    await new Promise(r => setTimeout(r, 1000))
    let alive = false
    try {
      alive = (await fetch(`${base}/api/status-log`)).ok
    } catch {}
    check('8 條 SSE 硬斷後 server 仍存活且可服務', alive)
  }

} finally {
  proc.kill()
  await proc.exited
  const err = await new Response(proc.stderr).text()
  console.log('\n--- server stderr ---')
  console.log(err.split('\n').slice(0, 12).join('\n'))
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nRESULT: ${fails === 0 ? 'PASS' : `FAIL（${fails} 項）`}  (MON_READ_SOURCE=${source})`)
process.exit(fails === 0 ? 0 : 1)
