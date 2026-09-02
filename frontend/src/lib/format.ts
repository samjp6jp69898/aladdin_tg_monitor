/**
 * 共用格式化函式：由舊版 public/index.html 的全域 helper 移植而來。
 *
 * 移植原則：**行為完全一致**，包含原版看起來像 bug 的地方也刻意保留（各函式註解標明）。
 * 需要改行為時請先與指揮官確認，不要在這裡「順手修正」——那會讓新舊版比對失去基準。
 *
 * 刻意「不」移植的：
 * - `$`（對應舊版 index.html:271，`document.querySelector`）：React 用 ref / state 取代，沒有等價需求。
 * - `esc`（對應舊版 index.html:272，HTML escape）：舊版是給 innerHTML 拼字串用的。React 對文字節點
 *   自動跳脫，**新前端一律不得使用 dangerouslySetInnerHTML**，因此不提供 esc。
 * - `api`（對應舊版 index.html:278）：改由 src/api/client.ts 取代（並補上舊版缺的 HTTP status 檢查）。
 */

/**
 * 完整日期時間格式化。對應舊版 index.html:273
 *   const fmt = ts => ts ? new Date(ts).toLocaleString('zh-TW', {hour12:false}) : '-'
 *
 * 刻意保留的原行為：
 * - falsy 值（null / undefined / '' / 0）一律回 '-'（不是只擋 nullish）。
 * - 無效日期字串不做防禦，會輸出環境相依的 'Invalid Date'。
 */
export function fmt(ts?: string | number | null): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-TW', { hour12: false })
}

/**
 * 相對時間（多久以前）。對應舊版 index.html:274
 *   const ago = ts => { if(!ts) return '-'; const s=Math.max(0,(Date.now()-Date.parse(ts))/1000); ... }
 *
 * 刻意保留的原行為：
 * - 有 Math.max(0, ...) 防護，未來時間不會顯示負值（與 dur() 不同）。
 * - 每個量級只顯示一個單位（不像 dur 會顯示兩個）。
 */
export function ago(ts?: string | null): string {
  if (!ts) return '-'
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000)
  if (s < 60) return `${Math.floor(s)}s前`
  if (s < 3600) return `${Math.floor(s / 60)}m前`
  if (s < 86400) return `${Math.floor(s / 3600)}h前`
  return `${Math.floor(s / 86400)}d前`
}

/**
 * 兩個時間點之間的時長。對應舊版 index.html:275
 *   const dur = (a,b) => { if(!a) return '-'; const s=((b?Date.parse(b):Date.now())-Date.parse(a))/1000; ... }
 *
 * 刻意保留的原行為（兩個看起來像 bug 的地方，維持 parity）：
 * - **沒有負值防護**：b < a 時會輸出負數字串（例如 '-3s'），原版即如此。
 * - **超過 24 小時不轉成「天」**：最大分支是「時+分」，例如 30 小時會顯示 '30h0m'。
 * - 中間兩個量級各顯示兩個單位（分+秒、時+分），秒/分不補零。
 */
export function dur(a?: string | null, b?: string | null): string {
  if (!a) return '-'
  const s = ((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

/**
 * uptime 秒數格式化。對應舊版 index.html:276
 *   const upt = s => s==null?'-':s<3600?`${(s/60)|0}m`:...
 *
 * 刻意保留的原行為：
 * - 用寬鬆 `== null` 判斷，只擋 null / undefined；`0` 會走 s<3600 分支輸出 '0m'。
 * - 最小量級只顯示分鐘，不顯示秒。
 */
export function upt(s?: number | null): string {
  if (s == null) return '-'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`
}

/** ResultBadge / Badge 的色彩變體。 */
export type PillVariant = 'default' | 'ok' | 'bad' | 'warn'

/**
 * events 分頁「結果」欄的徽章顏色判定。對應舊版 index.html:277 的 resPill()
 *   const resPill = r => { if(!r||r==='unknown') ...灰; if(r==='success'||r==='recovered') ...綠; ...紅 }
 *
 * 舊版回傳 HTML 字串，這裡只回傳「顏色變體」，由 <ResultBadge> 元件負責渲染
 * （新前端不得用 dangerouslySetInnerHTML）。顏色對應規則與舊版完全相同：
 * - falsy / 'unknown' → default（灰）
 * - 'success' / 'recovered' → ok（綠）
 * - 其餘一律 bad（紅），含所有 'error:*' 開頭字串。
 */
export function resultPillVariant(r?: string | null): PillVariant {
  if (!r || r === 'unknown') return 'default'
  if (r === 'success' || r === 'recovered') return 'ok'
  return 'bad'
}

/**
 * resPill 的文字內容判定。對應舊版 index.html:277 的 `esc(r||'-')` 分支：
 * falsy 值顯示 '-'，字面值 'unknown' 原樣顯示。
 */
export function resultPillText(r?: string | null): string {
  return r || '-'
}

/**
 * token 數量縮寫。對應舊版 index.html:545
 *   const fmtTok = n => n==null?'-':n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n)
 *
 * 刻意保留的原行為：用寬鬆 `== null`（0 會輸出 '0'）；M 兩位小數、k 一位小數。
 * 舊版只有 pipelines 分頁用，但屬通用數字格式，放共用層。
 */
export function fmtTok(n?: number | null): string {
  if (n == null) return '-'
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/**
 * 檔案大小（固定 KB，不自動換單位）。對應舊版 logs 分頁 index.html:736/737/745/753
 * 四處重複的 `(bytes/1024).toFixed(1)+'KB'`。
 *
 * 刻意保留的原行為：**永遠是 KB**，不會升成 MB/GB；也沒有 null 防護以外的處理。
 */
export function fmtKb(bytes?: number | null): string {
  if (bytes == null) return '-'
  return `${(bytes / 1024).toFixed(1)}KB`
}

/**
 * 只取「時:分:秒」。對應舊版 pipelines 分頁 index.html:557/563/588/596 的 `fmt(ts).slice(-8)`。
 *
 * 刻意保留的原行為：這是對**本地化字串**做尾端 8 字元切片，不是重新格式化時間；
 * 在 `zh-TW` + `hour12:false` 下結果會是 `HH:MM:SS`。ts 為 falsy 時 `fmt()` 回 '-'，
 * 切片後仍是 '-'（長度不足 8 時 slice(-8) 回整個字串）。
 */
export function hms(ts?: string | number | null): string {
  return fmt(ts).slice(-8)
}

/**
 * 毫秒轉秒（一位小數）。對應舊版 pipelines 分頁 index.html:597 的 `(duration_ms/1000).toFixed(1)+'s'`。
 */
export function fmtMsSec(ms?: number | null): string {
  if (ms == null) return '-'
  return `${(ms / 1000).toFixed(1)}s`
}
