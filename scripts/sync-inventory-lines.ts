// 契約檔行號同步 + 涵蓋性檢查（官方工具，裁定 a7-D13）
//
//   bun run scripts/sync-inventory-lines.ts          → 檢查並修正，回報差異
//   bun run scripts/sync-inventory-lines.ts --check  → 只檢查不改檔（CI／擋門用）
//
// 為什麼需要這支：migration/00-api-inventory.md 各小節標題帶 `server.ts:N` 行號，
// 而 server.ts 每次增修都會讓行號漂移。2026-09-02 實測過一次失控案例——檔頭寫著
// 「一律 +15」，實際漂移是**非均勻**的 +53~+91（overview +72、pipelines/run +91、
// token-grants +53、log/since +56）。套固定位移每次都落錯位置，但文件表面看起來完好：
// 壞掉的文件會被修，指錯的文件會被相信。所以行號一律重新生成，禁止手算位移。
//
// 除了同步行號，本工具也做**雙向涵蓋性檢查**：
//   - 文件有小節、server.ts 卻沒有該路由 → 殘留的死條目
//   - server.ts 有路由、文件卻沒有小節   → 未落檔（2026-09-02 的 /next、/next/* 就是這樣漏掉的）
// 任一方向有缺口就 exit 1，讓它能當擋門用。
//
// 契約檔的角色（裁定）：Phase 9 §10.2 雙軌對照與退役 sqlite collector 時，
// 它是官方的「回應形狀不變」驗收基準——所以涵蓋性缺口不是文件瑕疵，是驗收基準有洞。

const ROOT = new URL('..', import.meta.url).pathname
const SERVER = `${ROOT}server.ts`
const DOC = `${ROOT}migration/00-api-inventory.md`
const checkOnly = process.argv.includes('--check')

const routes = new Map<string, number>()
;(await Bun.file(SERVER).text()).split('\n').forEach((line, i) => {
  const m = line.match(/^app\.(get|post)\('([^']+)'/)
  if (m && !routes.has(`${m[1]!.toUpperCase()} ${m[2]}`)) {
    routes.set(`${m[1]!.toUpperCase()} ${m[2]}`, i + 1)
  }
})

let doc = await Bun.file(DOC).text()
const documented = new Set<string>()
const drifted: string[] = []
const stale: string[] = []

doc = doc.replace(/(#{2,3}) (GET|POST) (\/\S*) — server\.ts:(\d+)/g, (whole, hashes, method, path, old) => {
  const key = `${method} ${path}`
  documented.add(key)
  const real = routes.get(key)
  if (real === undefined) {
    stale.push(`${key}（文件寫 server.ts:${old}，但 server.ts 已無此路由）`)
    return whole
  }
  if (String(real) !== old) drifted.push(`${key}: ${old} → ${real}`)
  return `${hashes} ${method} ${path} — server.ts:${real}`
})

const undocumented = [...routes.keys()].filter(k => !documented.has(k))

if (drifted.length) {
  console.log(`行號漂移 ${drifted.length} 處：`)
  for (const d of drifted) console.log(`  ${d}`)
} else {
  console.log('行號漂移：無')
}
if (stale.length) {
  console.log(`\n⚠️ 文件有小節但 server.ts 無此路由（${stale.length}）：`)
  for (const s of stale) console.log(`  ${s}`)
}
if (undocumented.length) {
  console.log(`\n⚠️ server.ts 有路由但文件未落檔（${undocumented.length}）：`)
  for (const u of undocumented) console.log(`  ${u}`)
}

if (!checkOnly && drifted.length) {
  await Bun.write(DOC, doc)
  console.log(`\n已寫回 ${drifted.length} 處行號。`)
} else if (checkOnly && drifted.length) {
  console.log('\n--check 模式：未寫檔。')
}

const gaps = stale.length + undocumented.length
// 行號漂移與涵蓋性缺口**都算不合格**（裁定）。
//
// 2026-09-02 修正：原本 exit code 只看 `gaps`，於是 --check 會印出滿滿 36 行漂移、
// 然後回 RESULT: OK 與 exit 0——擋門那格標籤宣稱「行號同步 + 雙向涵蓋」，實際上
// 只驗了後半。這比完全沒驗更糟：它印了問題又說沒事，會訓練人忽略它的輸出。
//
// 理由與涵蓋性缺口同一條：契約檔是「回應形狀不變」的官方驗收基準，行號全錯的話
// 人照著去看會看到別的東西（實例：照 905 去看，看到的是 SSE_MAX_CONSECUTIVE_FAILURES
// 的註解區塊而不是路由）——那是基準有洞，不是文件小瑕疵。
// 寫入模式下漂移已當場修好，不該再算成不合格（否則把本工具寫進腳本會「修完永遠失敗」）；
// --check 模式沒寫檔，漂移仍存在，才要計入。
const unresolvedDrift = checkOnly ? drifted.length : 0
const bad = gaps + unresolvedDrift
console.log(
  bad === 0
    ? `\nRESULT: OK — server.ts ${routes.size} 條路由與文件小節雙向對齊，行號無漂移`
    : `\nRESULT: NG — 行號漂移 ${unresolvedDrift} 處、涵蓋性缺口 ${gaps} 處，` +
      `契約檔不可當驗收基準直到修正（漂移跑一次不帶 --check 即可修）`,
)
process.exit(bad === 0 ? 0 : 1)
