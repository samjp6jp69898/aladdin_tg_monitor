// /next/* 靜態檔案路徑解析（Reviewer B MINOR-9，review-final-B-tgmonitor.md）：
// 原本 decodeURIComponent 沒包 try，收到非法百分號序列（如 `%E0%A4%A`）會直接
// throw，讓整支 handler 從「回一個乾淨的狀態碼」變成 Hono 500——與其他壞輸入
// （不存在的檔案、目錄穿越）的待遇不一致。抽成純函式方便測試，不需要真的起
// server 或碰檔案系統之外的東西。

import { join } from 'node:path'

/**
 * 把 `/next/*` 的請求路徑（已去掉 `/next/` 前綴）解析成 frontend/dist 底下的
 * 實際檔案路徑。回傳 `null` 代表兩種情況都該回 404，不需要呼叫端區分：
 *   - URL 編碼非法（`decodeURIComponent` 會 throw 的輸入）
 *   - 解出來的路徑跳出 `distDir`（目錄穿越）
 */
export function resolveNextStaticPath(distDir: string, urlPathAfterPrefix: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(urlPathAfterPrefix)
  } catch {
    return null
  }
  const target = rel === '' ? join(distDir, 'index.html') : join(distDir, rel)
  if (!target.startsWith(distDir)) return null
  return target
}
