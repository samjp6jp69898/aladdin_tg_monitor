// lib/remote-log-slice.ts — worker 執行的票，`/api/log/tail`、`/api/log/since`
// host-aware 化後（task 1，2026-09-04）在 head 端對「worker 回傳的整份檔案
// 內容」做的記憶體內切片。
//
// 背景：worker 的 `GET /files`（見 telegram-dispatcher/lib/pipeline-runner/
// local-trace-read.ts）沒有「只讀檔尾」或「從某個 offset 起讀」的能力——它是
// 唯讀整份檔案內容。本機版的 `/api/log/tail`、`/api/log/since` 則是直接對檔案
// 描述子做 byte-offset 定位讀取（node:fs openSync/readSync，見 server.ts
// tailFile() 與兩個端點的 handler）。host-aware proxy 情境下，head 只能先把
// 整份內容從 worker 抓回來，再在記憶體裡做同樣的切片，讓兩邊回應形狀與語意
// 完全一致（前端 useLogFollow 感覺不出差異，見 hooks/useLogFollow.ts）。
//
// 防禦上限：`MAX_REMOTE_LOG_BYTES` 只防「pathological 大檔」把 head 記憶體
// 吃爆——正常 pipeline stdout/stderr log 遠低於此（本機版也沒有整檔大小上限，
// 只有單次讀取量上限），不是一般路徑會撞到的量，見兩個匯出函式呼叫處
// server.ts 的說明。用字元數（JS string length）當 byte 數的近似上限：pipeline
// log 幾乎全是 ASCII，這個近似對「防 OOM」這個用途足夠精確，不需要位元組級
// 精確——一旦真的觸發截斷，本來就是防禦性降級，不追求跟本機版分毫不差。

export const MAX_REMOTE_LOG_BYTES = 8 * 1024 * 1024

/** 單次 /api/log/since 最多回傳的新增內容量——逐字比照本機分支的 2MB 上限
 * （server.ts `/api/log/since` handler）。 */
const SINCE_CHUNK_MAX_BYTES = 2 * 1024 * 1024

function capContent(content: string, capBytes: number): string {
  return content.length > capBytes ? content.slice(content.length - capBytes) : content
}

/**
 * 比照本機 `tailFile()`：從整份內容取最後 `maxBytes` bytes，並丟掉第一個可能
 * 被截斷的半行（除非那就是整份內容的開頭）。`size` 是（可能已被防禦性截斷的）
 * 內容總長度，語意與本機版的 `fstatSync(fd).size` 一致，供呼叫端當下一輪
 * `/api/log/since` 的起始 offset。
 */
export function tailRemoteLogContent(content: string, maxBytes: number, capBytes: number = MAX_REMOTE_LOG_BYTES): { text: string; size: number } {
  const full = Buffer.from(capContent(content, capBytes), 'utf8')
  const size = full.length
  const start = Math.max(0, size - maxBytes)
  let text = full.subarray(start).toString('utf8')
  if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  return { text, size }
}

/**
 * 比照本機 `/api/log/since` handler：`offset` 是「已讀到的 byte 位置」。
 * 檔案被截斷/輪替（`size < offset`）時重置為從頭讀；沒有新內容
 * （`size === offset`）回傳空字串、offset 不動；否則回傳自 offset 起的新增
 * 內容（單次最多 2MB，比照本機版），並把 offset 推進到讀到的位置。
 */
export function sinceRemoteLogContent(content: string, offsetIn: number, capBytes: number = MAX_REMOTE_LOG_BYTES): { text: string; offset: number } {
  const full = Buffer.from(capContent(content, capBytes), 'utf8')
  const size = full.length
  let offset = offsetIn
  if (size < offset) offset = 0 // 被截斷 / 輪替
  if (size === offset) return { text: '', offset }
  const buf = full.subarray(offset, Math.min(size, offset + SINCE_CHUNK_MAX_BYTES))
  return { text: buf.toString('utf8'), offset: offset + buf.length }
}
