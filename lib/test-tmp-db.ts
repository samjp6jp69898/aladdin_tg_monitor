// lib/test-tmp-db.ts — 測試專用：把 lib/db.ts 的 sqlite 路徑導向暫存檔。
//
// lib/db.ts 在 **import 當下** 就會依 `TG_MONITOR_DB`（`db.ts:9`）開檔並建表；
// 而 ESM 的 import 在測試檔本體執行之前就已求值，所以「把 TG_MONITOR_DB 指到
// 暫存路徑」這件事沒辦法寫在測試檔的 body 裡——只能靠一個比 `./ingest.ts`
// （→ `./db.ts`）更早被 import 的模組來做。凡是（直接或間接）import 到
// `./db.ts` 的測試檔，都要把本檔放在 import 清單的**第一行**，否則測試會開到
// 使用者真正的 `data/monitor.sqlite`（對抗審查 NB-7）。
//
// 只在未設值時才覆寫：scripts/verify-stream.ts 那種自己指定 TG_MONITOR_DB 的
// 用法不受影響。暫存目錄交給 OS 的 tmp 清理機制回收（測試行程不共用它、也不
// 需要在測試之間清空——每次跑測試都是新的一份）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.TG_MONITOR_DB) {
  process.env.TG_MONITOR_DB = join(mkdtempSync(join(tmpdir(), 'tg-monitor-test-db-')), 'monitor.sqlite')
}
