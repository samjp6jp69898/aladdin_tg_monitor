# 截圖比對基準說明

## 工具
`bun run migration/review/shot.ts [old|new]`（在 tg-monitor 根目錄執行）
- 產物：`migration/review/shots/<old|new>-<route>.png`（fullPage，1440×1000 viewport）
- 涵蓋 11 條 route：overview / events / sessions / stats / tokens / tg-connected / tg-pending / pipelines / toolsmith / workers / logs
- 需要 tg-monitor 服務在 127.0.0.1:8799 上跑（launchd：`com.aladdin.tg-monitor`）
- Playwright 借用 `/Users/user/aladdin/cqa-e2e/node_modules/playwright`（chromium 已裝），tg-monitor 本身不加這個依賴

## 已知的無害 console error（不要當成缺陷回報）
舊版每次跑會出現 **1 筆** `TypeError: Failed to fetch`（`api` → `loadOverview` → `refresh` → `showTab`）。
成因：腳本為了讓舊版吃到 hash（舊版沒有 hashchange listener，只在載入時讀一次 `location.hash`）
會先 `goto` 再 `reload`，reload 中斷了第一次載入時已發出的 overview fetch。這是量測工具的產物，
不是舊版的缺陷。**新版若出現同一筆同 stack 的 Failed to fetch，同樣不算缺陷；其他 console error 都要算。**

## 基準採集時間
舊版基準圖採集於 2026-09-02，來源 commit：見 `git log -1`（工作區當時另有未提交的 lib/ 與 public/index.html 修改）。
