// lib/read/source.ts — MON_READ_SOURCE 旗標解析（plan-db-as-truth-v3.md §8.1）。
//
// 「回滾＝改 tg-monitor/.env 一個字 + launchctl kickstart -k com.aladdin.tg-monitor」
// 這顆按鈕的全部實作就在這一支：預設 sqlite，只有明確寫 'mysql' 才走新路徑。
// 與寫入面的 MON_DB_ENABLED **完全獨立**——讀取面可以在寫入面還沒開的情況下
// 先對已有資料（回填/測試資料）做 A/B 對照。
//
// 匯出通道：launchd/run-monitor.sh 的逐 key 白名單必須含 MON_READ_SOURCE，
// 否則 launchd 起的行程讀不到這個變數（BL-C2 同型問題）。

export type ReadSource = 'sqlite' | 'mysql'

/**
 * 解析 MON_READ_SOURCE。
 *
 * - 未設 / 空字串 / 'sqlite' → `'sqlite'`（預設，行為與遷移前完全相同）
 * - 'mysql' → `'mysql'`
 * - 其他任何值 → **fail-safe 回 'sqlite' 並在 stderr 記一行 WARN**。
 *   刻意不 throw：這是回滾槓桿，打錯字的代價必須是「退回舊行為」而不是
 *   「監控面板整個起不來」（run-monitor.sh 對 MON_DB_* 缺值的處置也是同一方向）。
 *
 * 前後空白會被去掉（.env 的 `grep | cut` 匯出手法容易帶進尾隨空白）；大小寫不敏感。
 */
export function resolveReadSource(raw: string | undefined): ReadSource {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '' || v === 'sqlite') return 'sqlite'
  if (v === 'mysql') return 'mysql'
  console.error(`tg-monitor: MON_READ_SOURCE 值無法識別（${JSON.stringify(raw)}），退回 sqlite`)
  return 'sqlite'
}

/** 目前行程的讀取來源。啟動時求值一次——切換一律經由重啟（kickstart），不做熱切換。 */
export function currentReadSource(): ReadSource {
  return resolveReadSource(process.env.MON_READ_SOURCE)
}
