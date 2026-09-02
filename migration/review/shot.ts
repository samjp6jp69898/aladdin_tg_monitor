// 新舊前端逐分頁截圖比對工具（給 review agent 用）
//   bun run migration/review/shot.ts            → 兩版都截
//   bun run migration/review/shot.ts old|new    → 只截一版
// 產物：migration/review/shots/<old|new>-<route>.png
import { chromium } from '/Users/user/aladdin/cqa-e2e/node_modules/playwright/index.js'

const ROUTES = [
  'overview', 'events', 'sessions', 'stats',
  'tokens', 'tg-connected', 'tg-pending',
  'pipelines', 'toolsmith', 'workers', 'logs',
]
const BASE = 'http://127.0.0.1:8799'
const SIDES: Record<string, string> = { old: `${BASE}/`, new: `${BASE}/next/` }

const only = process.argv[2]
const sides = only ? { [only]: SIDES[only]! } : SIDES
const outDir = new URL('./shots/', import.meta.url).pathname

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors: string[] = []
page.on('console', m => { if (m.type() === 'error') errors.push(`${m.location().url} :: ${m.text()}`) })
page.on('pageerror', e => errors.push(`pageerror :: ${e.message}`))

for (const [side, url] of Object.entries(sides)) {
  for (const route of ROUTES) {
    // 舊版只在載入時讀一次 location.hash（沒有 hashchange listener），所以純改 hash
    // 的 goto 不會切分頁——必須 reload 才會真的渲染目標分頁。新版走 HashRouter 也吃得下。
    await page.goto(`${url}#${route}`, { waitUntil: 'domcontentloaded' })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.screenshot({ path: `${outDir}${side}-${route}.png`, fullPage: true })
    console.log(`shot ${side}/${route}`)
  }
}
await browser.close()

if (errors.length) {
  console.log(`\nCONSOLE_ERRORS: ${errors.length}`)
  for (const e of errors) console.log(`  ${e}`)
} else {
  console.log('\nCONSOLE_ERRORS: 0')
}
