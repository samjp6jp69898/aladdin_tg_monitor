// Bun SSE 斷線 segfault 回歸驗證
//
// 用途：驗證「Bun 的 ReadableStream 在客戶端中斷連線時會 segfault」這個踩坑是否還在。
//   bun run scripts/sse-segfault-repro.ts     → PASS（安全，可用 SSE）/ FAIL（禁區仍在）
//
// 什麼時候要跑：
//   1. bun 升版後
//   2. 啟用任何新的 SSE 端點之前（Phase 4 前置檢查）
//
// 歷史：
//   - Bun 1.2.9 實測會 segfault，所以 tg-monitor 全面採用輪詢（見 server.ts 的
//     /api/log/since 註解）。
//   - 2026-09-02 於 Bun 1.4.0 用本腳本實測：8 次客戶端硬斷全部正常觸發 cancel()、
//     server 存活、斷線後仍能接受新連線 → 該 segfault 已修復，SSE 不再是禁區。
//
// ⚠️ 本腳本只驗證 ReadableStream 斷線這一條。「handler 內同步 spawn（execFileSync）
// 遇客戶端中斷會 segfault」是**另一條獨立、未驗證解除**的踩坑（見 lib/ingest.ts 檔頭
// 與 server.ts:376 附近註解），不要拿本腳本的 PASS 外推到那條——SSE handler 內仍禁
// 用 *Sync 版本的 spawn。

const DISCONNECTS = 8

function freePort(): number {
  // 讓 OS 配一個沒人用的 port，避免撞到本機既有服務（實測撞過 8791）
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}

const port = freePort()
let cancelCount = 0

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch() {
    let n = 0
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const timer = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`event: tick\ndata: {"n":${++n}}\n\n`))
          } catch {
            clearInterval(timer)
          }
        }, 50)
        setTimeout(() => {
          clearInterval(timer)
          try { controller.close() } catch {}
        }, 10_000)
      },
      cancel() { cancelCount++ },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})

// 開 N 條連線，各收一點資料後用 AbortController 硬斷（模擬瀏覽器關分頁 / 網路斷）
const url = `http://127.0.0.1:${port}/`
await Promise.all(
  Array.from({ length: DISCONNECTS }, async () => {
    const ac = new AbortController()
    try {
      const res = await fetch(url, { signal: ac.signal })
      const reader = res.body!.getReader()
      await reader.read()   // 收到第一筆事件再斷，確保串流真的建立起來了
      ac.abort()
    } catch {
      // abort 本來就會讓 fetch reject，這是預期行為
    }
  }),
)

// 斷線後 server 是否還活著、還能接受新連線
let survived = false
let sample = ''
try {
  const res = await fetch(url)
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  sample = new TextDecoder().decode(value ?? new Uint8Array()).split('\n')[0] ?? ''
  await reader.cancel()
  survived = sample.startsWith('event:')
} catch (e) {
  sample = `再連線失敗：${e instanceof Error ? e.message : String(e)}`
}

server.stop(true)

const pass = survived && cancelCount >= DISCONNECTS
console.log(`bun 版本：${Bun.version}`)
console.log(`硬斷連線數：${DISCONNECTS}，觸發 cancel() 次數：${cancelCount}`)
console.log(`斷線後再連線：${survived ? `成功（首行 "${sample}"）` : `失敗（${sample}）`}`)
console.log(pass
  ? 'RESULT: PASS — ReadableStream 斷線不會 segfault，SSE 可用（同步 spawn 那條踩坑仍在）'
  : 'RESULT: FAIL — 斷線處理異常，啟用 SSE 前先查清楚')
process.exit(pass ? 0 : 1)
