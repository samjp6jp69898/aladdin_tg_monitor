// lib/read/mysql.ts — 監控 DB（pipeline_monitor）讀取面（MON_READ_SOURCE=mysql 時走這裡）。
//
// 規格來源：plan-db-as-truth-v3.md §8.1（讀取面切換）、§2.2（mon_ui 只 SELECT 九張表）、
// §11.1（表清單）、migration/00-api-inventory.md（回應形狀的驗收基準）。
//
// ## 本檔的三條紀律
// 1. **只讀，不寫。** mon_ui 對 `runs` 的欄位級 UPDATE 是 cancel 路徑的事，
//    在 lib/mon-db.ts；本檔的每一條 SQL 都是 SELECT。
// 2. **不自建 pool。** 一律用 lib/mon-db.ts 的 getMonitorPool()——【G:MN-G7】
//    「全案唯一的 createPool 呼叫點」對 tg-monitor 這一側同樣成立（§4.6 pool 歸屬表：
//    tg-monitor / mon_ui / connectionLimit 4 / 讀取面九張＋runs cancel 欄位）。
// 3. **形狀以 sqlite 為準。** 欄位改名一律在 SQL 內做完（`AS`），缺欄回 NULL，
//    呼叫端（server.ts）拿到的物件與 sqlite 模式同形。
//
// ## `stderr_path` / `review_rounds` / `final_review_rounds`
// 這三欄原本 `runs` 表沒有（migration 003 只對齊了 `agent_runs` 的 payload 欄），
// 本檔一度只能回 NULL；**migration 004（2026-09-02 已套用 live DB）補上了**，
// 現在直接讀真欄位。
// ⚠️ 但 rounds 兩欄的**寫入端還沒有人接**（排在 health-monitor 批之後），所以值
// 目前一律是 NULL。這是可接受的降級、不是缺陷：前端本來就是「0／無值即隱藏」
// （見 server.ts 的 reviewRounds 計算式），sqlite 那側的歷史 run 也沒有這兩欄。
// 要容忍的是**值為 NULL**，不是「欄位不存在」。
//
// ## 為什麼 events 要在 SQL 裡解 JSON
// sqlite 的 `events` 表是「解析過的欄位」（lib/db.ts insertAuditLine 把 raw JSON
// 拆成 event/method/path/tool/... 十來欄）；監控 DB 的 `mcp_usage` 只存
// `service / identity / source_ip / raw / ts`（§11.1），其餘欄位在 raw 裡。
// 篩選（/api/events 的 LIKE）與彙總（/api/stats 的 GROUP BY tool）都必須在 SQL
// 端做，不能整表撈回 JS，所以用 MySQL 的 JSON 函式即時解。每個取值都包在
// `IF(JSON_VALID(raw), ...)` 內：raw 若不是合法 JSON（理論上不會，寫入端與
// insertAuditLine 同樣先 JSON.parse 才寫），回 NULL 而不是讓整個端點 500。

import type { Pool, RowDataPacket } from 'mysql2/promise'
import { getMonitorPool, isoToMysqlDatetime3 } from '../mon-db.ts'
import type {
  AgentRunRow,
  EventRow,
  EventsFilter,
  IdentityUsageRow,
  LastStatusChangeRow,
  MonitorReader,
  PipelineRunRow,
  ServiceAuditStats,
  SessionEventRow,
  SessionsFilter,
  StatsResult,
  StatusLogRow,
} from './types.ts'

// ─────────────────────────────────────────────────────────────────────────
// SQL 片段產生器
//
// iso / jstr / jnum / RUNS_SELECT / AGENT_RUNS_SELECT 之所以 export，只有一個
// 理由：**給 mysql-sql.test.ts 直接斷言**（用字串比對測 SQL 片段，比對整支
// 檔案做 regex 可靠得多）。本檔以外沒有任何 production 呼叫端。
// ─────────────────────────────────────────────────────────────────────────

/**
 * DATETIME(3) → 與 sqlite 完全同形的 UTC ISO 字串（毫秒三位 + 'Z'）。
 *
 * 不能直接用 `DATE_FORMAT(x,'%Y-%m-%dT%H:%i:%s.%fZ')`——`%f` 是**六位**微秒，
 * 會產生 `.751000Z`，與 sqlite 存的 `.751Z` 不同形（前端與 /api/stats 的
 * `substr(ts,1,13)` 同型比較都吃這個字串）。NULL 進 NULL 出（CONCAT 遇 NULL 回 NULL）。
 */
export function iso(col: string): string {
  return `CONCAT(DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s.'), LPAD(FLOOR(MICROSECOND(${col}) / 1000), 3, '0'), 'Z')`
}

/** raw JSON 的字串欄位；缺 key、JSON null、raw 非合法 JSON 一律回 SQL NULL。 */
export function jstr(alias: string, key: string): string {
  const raw = `${alias}.\`raw\``
  const ex = `JSON_EXTRACT(${raw}, '$.${key}')`
  // 巢狀 IF：MySQL 的 AND 不保證短路，用 IF 才能確定 raw 非法時完全不去碰 JSON_EXTRACT。
  return `IF(JSON_VALID(${raw}), IF(JSON_TYPE(${ex}) IS NULL OR JSON_TYPE(${ex}) = 'NULL', NULL, JSON_UNQUOTE(${ex})), NULL)`
}

/**
 * raw JSON 的數值欄位。對齊 insertAuditLine 的
 * `typeof j.durationMs === 'number' ? j.durationMs : null`——**只有真的是 JSON 數字
 * 才取值**，字串 "123" 一律回 NULL（sqlite 那側也是 null）。
 *
 * 用 `AS DOUBLE` 而不是 `AS SIGNED`：sqlite 的 `duration_ms` 欄雖然宣告 INTEGER，
 * 但 sqlite 是動態型別、`lib/db.ts` 綁的是原始 JSON 數字，`12.7` 存進去就是
 * `12.7`。`AS SIGNED` 會截成 `12`，於是 `duration_ms` 與 `stats.topTools.avg_ms`
 * 在兩軌會不一樣（目前 durationMs 都是整數，屬潛伏差異）。
 */
export function jnum(alias: string, key: string): string {
  const raw = `${alias}.\`raw\``
  const ex = `JSON_EXTRACT(${raw}, '$.${key}')`
  return `IF(JSON_VALID(${raw}), IF(JSON_TYPE(${ex}) IN ('INTEGER', 'DOUBLE', 'DECIMAL'), CAST(JSON_UNQUOTE(${ex}) AS DOUBLE), NULL), NULL)`
}

/**
 * **LIKE 專用**：把 JSON 取出來的字串重新標上 schema 預設 collation。
 *
 * 為什麼非加不可（本輪實測，不是推測）：`JSON_UNQUOTE(JSON_EXTRACT(...))` 的結果
 * collation 是 **`utf8mb4_bin`**（`SELECT COLLATION(JSON_UNQUOTE(...))` 實測），
 * 不是欄位/schema 的 `utf8mb4_0900_ai_ci`。而 **sqlite 的 `LIKE` 對 ASCII 是
 * 大小寫不敏感的**。兩者相減的後果實測如下（同一份 1738 列）：
 *
 *     /api/events?q=admin  → sqlite 7 筆、mysql 7 筆
 *     /api/events?q=Admin  → sqlite 7 筆、mysql **0 筆**
 *
 * 也就是切到 mysql 之後，事件搜尋會在使用者打了大寫時**靜默地查不到東西**。
 * 同一個 OR 條件裡的 `e.source_ip` 是真欄位、collation 是 ai_ci，所以連
 * 「整條都一致地大小寫敏感」都做不到。凡是 JSON 取值要進 LIKE，一律包這個。
 */
export function likeable(expr: string): string {
  return `(${expr}) COLLATE utf8mb4_0900_ai_ci`
}

/**
 * **等值／分組專用**：釘死 `utf8mb4_bin`。
 *
 * schema 的預設 `utf8mb4_0900_ai_ci` 大小寫**與重音**都不敏感，sqlite 的 `=`
 * 與 `GROUP BY` 則是逐位元組。不釘死會有兩個後果：
 *   (a) 只差大小寫的兩個 identity 在 mysql 併成一列、在 sqlite 是兩列
 *       （`/api/token-grants` 的用量會少算一個人、多算另一個人）；
 *   (b) `IN (...)` 用 ai_ci 比對會撈回 `service` 大小寫不同的列，接著在
 *       JS 端 `out.get(r.service)` 拿到 undefined 被**靜默丟掉**，計數變 0。
 */
export function exact(expr: string): string {
  return `${expr} COLLATE utf8mb4_bin`
}

/** JSON 欄位（detail_json，型別就是 JSON，不需要 JSON_VALID 保護）的字串取值。 */
function djstr(col: string, key: string): string {
  const ex = `JSON_EXTRACT(${col}, '$.${key}')`
  return `IF(JSON_TYPE(${ex}) IS NULL OR JSON_TYPE(${ex}) = 'NULL', NULL, JSON_UNQUOTE(${ex}))`
}

/** JSON 欄位的整數取值。 */
function djnum(col: string, key: string): string {
  const ex = `JSON_EXTRACT(${col}, '$.${key}')`
  return `IF(JSON_TYPE(${ex}) IN ('INTEGER', 'DOUBLE', 'DECIMAL'), CAST(JSON_UNQUOTE(${ex}) AS SIGNED), NULL)`
}

/** `event` 欄位：對齊 insertAuditLine 的 `String(j.event ?? 'request')`。 */
function eventExpr(alias: string): string {
  return `COALESCE(${jstr(alias, 'event')}, 'request')`
}

/**
 * 使用者輸入的時間參數 → MySQL DATETIME 可比較的字串。
 *
 * sqlite 那側 `ts >= ?` 是**字串比較**、對輸入沒有任何驗證；這裡不能因為使用者
 * 打錯字就 throw（sqlite 模式只會查不到東西，mysql 模式不該變成 500）。
 * 合法 UTC ISO → 轉成 `YYYY-MM-DD HH:MM:SS.mmm`；其他一律原樣交給 MySQL
 * （`'2026-09-01'` 這種日期前綴 MySQL 自己會當午夜處理，與 sqlite 的字串前綴
 * 比較同效）。
 */
export function toDatetimeParam(v: string): string {
  try {
    return isoToMysqlDatetime3(v)
  } catch {
    return v
  }
}

/**
 * `ts >= ?` / `ts <= ?` 這類使用者可控的時間比較，產出「與 sqlite 同語意」的
 * SQL 片段與參數。
 *
 * sqlite 的 `ts` 是**存 ISO 字串的文字欄**，`ts >= ?` 是**字典序字串比較**；
 * 監控 DB 的 `ts` 是 `DATETIME(3)`。兩者對合法 ISO 輸入等價（ISO 字典序＝時序），
 * 但對垃圾輸入不等價——實測 `to=garbage`：sqlite 回 **1738 筆**（'g' > '2'，字典序
 * 上比任何 ISO 都大），mysql 回 **0 筆**（DATETIME 比較把它當 NULL）。
 *
 * 因此：
 *   - 輸入解析得出合法 UTC ISO → 走 `ts <op> ?`（吃得到 ts 的索引，語意等價）；
 *   - 解析不出來 → 退化成 `iso(ts) <op> ?`，即**在 MySQL 這側也做字典序字串比較**，
 *     與 sqlite 逐字一致（代價是這一條用不到索引，但這是垃圾輸入的路徑）。
 */
export function tsCompare(col: string, op: '>=' | '<=', raw: string): { frag: string; param: string } {
  try {
    return { frag: `${col} ${op} ?`, param: isoToMysqlDatetime3(raw) }
  } catch {
    return { frag: `${iso(col)} ${op} ?`, param: raw }
  }
}

/** COUNT/SUM 這類 MySQL 會回 DECIMAL 字串的欄位 → JS number。 */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

/** 可為 null 的數值欄位（cost_usd / avg_ms / duration_ms …）。 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  return typeof v === 'number' ? v : Number(v)
}

/**
 * LIMIT 一律以驗證過的整數字面值拼進 SQL，不走 placeholder（避開 mysql2 prepared
 * LIMIT 的版本相依行為）。
 *
 * **不在這裡做業務上的上限裁切**：`/api/events` 的 `Math.min(limit, 1000)` 是
 * server.ts 的既有行為，sqlite reader 也是原樣把 limit 交給 SQL——reader 這一層
 * 兩邊都必須照收，否則同一個呼叫在兩軌會拿到不同筆數（對照腳本就會誤判成資料差異）。
 * 這裡的上界純粹是防呆（NaN / 負數 / 天文數字）。
 */
const LIMIT_HARD_CAP = 1_000_000
/**
 * 回傳要接在 SQL 後面的 `LIMIT ...` 片段（含前導空白），或空字串代表不限筆數。
 *
 * 兩個看似奇怪、但**刻意對齊 sqlite** 的行為（實測 `/api/events?limit=`）：
 *   - `limit=-1`：sqlite 把負數 LIMIT 當「不限筆數」，回 1738 筆 → 這裡回空字串。
 *   - `limit=abc`：`Number('abc')` 是 NaN，bun:sqlite 綁定時丟
 *     `datatype mismatch`，handler 沒接 → **HTTP 500**。這裡跟著丟，讓兩個模式
 *     的狀態碼一致。（那個 500 本身是既有缺陷，但修它會改到 sqlite 模式的行為，
 *     不在「byte-level 不變」允許的範圍內——已列進回報單請指揮官裁決。）
 */
export function limitClause(n: number): string {
  const v = Number(n)
  if (Number.isNaN(v)) throw new TypeError('limit 不是數字（對齊 sqlite 綁定 NaN 時的 datatype mismatch）')
  const i = Math.floor(v)
  if (i < 0) return ''
  return ` LIMIT ${Math.min(Math.max(i, 0), LIMIT_HARD_CAP)}`
}

/** `IN (?, ?, …)` 的佔位字串；空陣列由呼叫端提前短路，不會走到這裡。 */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

/**
 * `service_status_log` 的「只留真正的狀態翻轉」視圖。
 *
 * 為什麼需要（2026-09-02 Phase 4 子指揮官轉知）：sqlite 那側的
 * `recordStatusIfChanged()`（lib/db.ts）是拿**資料庫裡的最後一列**比對，跨重啟
 * 也成立，所以 `status_log` 裡永遠只有翻轉列。監控 DB 這側的探測落地則會在
 * **tg-monitor 每次重啟時寫一列基準列**——狀態沒變也會有一列。直接讀出來的話，
 * mysql 模式的 `/api/status-log` 會多出一堆「不是翻轉」的列，`lastStatusChange`
 * 的時間也會變成「最後一次重啟的時間」而不是「最後一次真的翻轉的時間」。
 *
 * 折疊規則：以 `(service, ts, id)` 排序，只保留 `status` 與前一列不同的那些列
 * （`<=>` 是 NULL-safe 等號，status 可為 NULL）。每一段連續相同狀態只留**最早**
 * 那一列，也就是真正發生翻轉的時刻——與 sqlite 的語意逐條對應。
 *
 * 代價：折疊要看該 service 的完整歷史，所以這個 CTE 不吃 `idx_service_ts`
 * 的範圍掃描。目前該表 35 列，之後若長大再考慮讓寫入端別寫基準列（那才是治本，
 * 這裡是讀取端的相容層）。
 *
 * **為什麼這裡用 `ts, id` 而 sqlite 側用 `id`——這是刻意的兩軌偏離，不是不一致**
 * （2026-09-02，a7-D43 裁定；三處一起改：本 CTE、`lastStatusChanges`、`statusLog`）：
 *   - sqlite 的 `status_log` 只有單一寫入者、在事件當下寫入（`lib/db.ts` 的
 *     `recordStatusIfChanged`），所以 **id 序 ≡ ts 序 by construction**，
 *     `lib/read/sqlite.ts:41,114,115` 用 `ORDER BY id` 完全正確。
 *   - 監控 DB 這側收到的是**非時序寫入**：spool 重放帶原始 `ts` 但 `id` 是重放
 *     當下才配；Phase 6 回填更會把 8/21、8/27 的歷史列以**更大的 id** 寫進來
 *     （`backfill-sqlite.ts` 的 `BACKFILL_TABLES` 含 `status_log`）。實測回填前
 *     就已有 16/695 列是「id 較大但 ts 較早」。
 *   - 所以同一行 SQL 在 sqlite 是對的、在這裡是錯的，**而錯的那邊看起來完全正常**：
 *     `ORDER BY id` 會在時間亂序的序列上算翻轉（假翻轉/漏翻轉），`ORDER BY id DESC`
 *     取「最新」會取到回填進來**最老**的那一筆。
 *   - 不要「為了兩軌一致」把它改回 `id`。同檔的 events 查詢（`:457`/`:461`/`:496`）
 *     早就是 `ts DESC, id DESC`，本處是跟上既有慣例，不是引進新慣例。
 */
const STATUS_LOG_FLIPS = `
  WITH marked AS (
    SELECT s.id AS id, ${exact('s.service')} AS service, s.ts AS ts, s.status AS status,
           s.detail_json AS detail_json,
           CASE WHEN LAG(s.status) OVER (PARTITION BY ${exact('s.service')} ORDER BY s.ts, s.id) <=> s.status
                THEN 0 ELSE 1 END AS is_flip
      FROM service_status_log s
  )`

// ─────────────────────────────────────────────────────────────────────────
// runs / agent_runs 的欄位對映（sqlite pipeline_runs / agent_runs 形狀）
// ─────────────────────────────────────────────────────────────────────────

// `key`：新管線寫入時就帶 legacy_key（telegram-dispatcher/lib/monitor-db/writes.ts:70），
// 回填列也是（backfill-sqlite.ts:253 `legacy_key: r.key`）。萬一為 NULL 就退回
// run_id，讓 /api/pipelines/run?key= 仍然點得開（不會出現「列表看得到、點進去 404」）。
export const RUNS_SELECT = `
  SELECT COALESCE(r.legacy_key, r.run_id)                      AS \`key\`,
         r.kind                                                AS kind,
         r.ticket                                              AS ticket,
         ${iso('r.started_at')}                                AS started_at,
         r.stdout_path                                         AS stdout_path,
         r.stderr_path                                         AS stderr_path,
         ${iso('r.finished_at')}                               AS finished_at,
         r.outcome                                             AS outcome,
         ${iso('r.cancel_requested_at')}                       AS cancelled_at,
         COALESCE(r.triggered_by_name, r.triggered_by_email)   AS triggered_by,
         r.review_rounds                                       AS review_rounds,
         r.final_review_rounds                                 AS final_review_rounds,
         r.host                                                AS host,
         r.run_id                                              AS run_id
  FROM runs r`

// queued 列（lifecycle_rank=10）不進列表：sqlite 那側的 pipeline_runs 本來就只有
// 已 spawn 的 run，排隊中的單由 readQueuedTickets() 從佇列快照另外供給
// （server.ts 的 `queued` 欄），兩邊都算會重複計數。
const RUNS_LIST_WHERE = `r.lifecycle_rank >= 30 AND r.started_at IS NOT NULL`

// agent_runs：ticket / kind 不反正規化，走 run_id → runs 的 join 取得
// （migration-003-proposal.md §2「刻意不搬的欄位」已裁定）。
// stage ← agent_name（001 建表時就是這一欄，回填 backfill-sqlite.ts:300
// `agent_name: agent.stage` 可佐證）。file_mtime 是 collector 的私有再解析游標，
// 不進權威表（同提案），一律回 NULL。
export const AGENT_RUNS_SELECT = `
  SELECT a.path                          AS path,
         r.ticket                        AS ticket,
         r.kind                          AS kind,
         a.agent_name                    AS stage,
         ${iso('a.started_at')}          AS started_at,
         ${iso('a.finished_at')}         AS ended_at,
         a.model                         AS model,
         a.input_tokens                  AS input_tokens,
         a.output_tokens                 AS output_tokens,
         a.cache_read_tokens             AS cache_read_tokens,
         a.cache_create_tokens           AS cache_create_tokens,
         a.cost_usd                      AS cost_usd,
         a.num_turns                     AS num_turns,
         a.tool_calls                    AS tool_calls,
         COALESCE(a.is_error, 0)         AS is_error,
         a.result_preview                AS result_preview,
         NULL                            AS file_mtime,
         a.run_id                        AS run_id,
         a.host                          AS host
  FROM agent_runs a
  JOIN runs r ON r.run_id = a.run_id
   AND ${RUNS_LIST_WHERE}`

function toPipelineRunRow(r: any): PipelineRunRow {
  return {
    key: r.key,
    kind: r.kind,
    ticket: r.ticket,
    started_at: r.started_at,
    stdout_path: r.stdout_path ?? null,
    stderr_path: r.stderr_path ?? null,
    finished_at: r.finished_at ?? null,
    outcome: r.outcome ?? null,
    cancelled_at: r.cancelled_at ?? null,
    triggered_by: r.triggered_by ?? null,
    // 寫入端還沒接，目前一律是 NULL——numOrNull 會原樣傳 null 下去，
    // 與 sqlite 那側「歷史 run 沒有這兩欄」的形狀一致。
    review_rounds: numOrNull(r.review_rounds),
    final_review_rounds: numOrNull(r.final_review_rounds),
    host: r.host,
    run_id: r.run_id,
  }
}

function toAgentRunRow(a: any): AgentRunRow {
  return {
    path: a.path,
    ticket: a.ticket,
    kind: a.kind,
    stage: a.stage ?? null,
    started_at: a.started_at,
    ended_at: a.ended_at ?? null,
    model: a.model ?? null,
    input_tokens: numOrNull(a.input_tokens),
    output_tokens: numOrNull(a.output_tokens),
    cache_read_tokens: numOrNull(a.cache_read_tokens),
    cache_create_tokens: numOrNull(a.cache_create_tokens),
    // DECIMAL(12,6) 經 mysql2 回來是字串，不轉會讓 total_cost 變成字串相加。
    cost_usd: numOrNull(a.cost_usd),
    num_turns: numOrNull(a.num_turns),
    tool_calls: numOrNull(a.tool_calls),
    is_error: num(a.is_error),
    result_preview: a.result_preview ?? null,
    file_mtime: null,
    run_id: a.run_id,
    host: a.host,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Reader 實作
// ─────────────────────────────────────────────────────────────────────────

// tg-monitor 的 pool 是 connectionLimit 4 且 **waitForConnections: false**
// （§4.6 pool 歸屬表 + lib/mon-db.ts）——pool 借完就直接丟錯，不排隊。讀取面
// 一旦有多個 SSE 連線同時到期輪詢，很容易把 4 條借光，連 cancel 旗標那條寫入
// 都借不到。所以讀取面自己把查詢串成一條 FIFO 鏈（同時最多一條在飛），
// 結構上保證讀取面最多只佔用 1 條連線、剩下 3 條永遠留給 cancel。
//
// 這不是「用等待解決正確性問題」：查詢彼此之間沒有順序依賴，串起來純粹是
// 連線資源的背壓；正確性由「最多 1 條」這個結構性上限保證，不由時間保證。
let readChain: Promise<unknown> = Promise.resolve()
let queueDepth = 0

/**
 * 單條查詢的 I/O 期限。
 *
 * `lib/mon-db.ts` 的 pool 只設了 `connectTimeout: 500`，那只約束**建立連線＋
 * 握手**；一條已經在 pool 裡、對端 MySQL 卻不回應的連線（tunnel 通、TCP 不 RST、
 * query 不回——plan §4.6 修訂自己列為殘餘風險）沒有任何 per-query 上限。
 * 沒有這個期限的話，一條卡住的查詢會把下面那條 FIFO 鏈**永久堵死**，讀取面
 * 全部端點與所有 SSE topic 一起靜默凍結、連錯誤都不會冒出來——那比它想避免的
 * 「pool 借完立刻報錯」還糟糕（後者至少看得見）。
 *
 * 這不違反 CLAUDE.md 的「禁止用等待解決正確性問題」：它不是拿來規避競態或
 * 等別人做完，而是對**外部 I/O** 設一個期限，逾時就把失敗顯性化。
 */
const READ_QUERY_TIMEOUT_MS = 5_000

/** 鏈上最多允許排隊的查詢數；超過立即拒絕，不讓佇列無上限成長。 */
const READ_QUEUE_MAX = 64

async function q<T = RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
  if (queueDepth >= READ_QUEUE_MAX) {
    throw new Error(`mon-db 讀取佇列已滿（${queueDepth}/${READ_QUEUE_MAX}），拒絕新查詢`)
  }
  queueDepth++
  // 前一條查詢失敗不該讓後面所有查詢跟著失敗——鏈只用來排序，不傳遞錯誤。
  const run = readChain.catch(() => undefined).then(async () => {
    const pool: Pool = getMonitorPool()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const rows = await Promise.race([
        pool.execute(sql, params).then(([r]) => r as T),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`mon-db 讀取逾時（${READ_QUERY_TIMEOUT_MS}ms）：${sql.slice(0, 80).replace(/\s+/g, ' ')}…`)),
            READ_QUERY_TIMEOUT_MS,
          )
        }),
      ])
      return rows
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      queueDepth--
    }
  })
  readChain = run.catch(() => undefined)
  return run
}

/** 啟動時的連線探針（index.ts 用）：走同一條鏈、同一個 pool。 */
export async function probeMysqlReadable(): Promise<void> {
  await q('SELECT 1 AS ok')
}

export const mysqlReader: MonitorReader = {
  source: 'mysql',

  async serviceAuditStats(serviceIds, windows) {
    const out = new Map<string, ServiceAuditStats>()
    if (serviceIds.length === 0) return out
    const ph = placeholders(serviceIds.length)
    const activeSince = toDatetimeParam(windows.activeSince)
    const hourAgo = toDatetimeParam(windows.hourAgo)
    const dayAgo = toDatetimeParam(windows.dayAgo)

    // (1) 活躍使用者。last_tool / source_ip 的相關子查詢**刻意不帶 ts 下限**——
    // sqlite 原式（server.ts 的 activeUsersStmt）的 e2/e3 子查詢也沒有，
    // 語意是「這個人在這個服務上最後一次用的 tool / 來源 IP」，不限於視窗內。
    const activeRows = await q<any[]>(
      // 為什麼要先包一層衍生表 `b`：GROUP BY 要釘 utf8mb4_bin（不然只差大小寫的
      // 兩個 identity 會被 ai_ci 併成一列，sqlite 那側是兩列），但 ONLY_FULL_GROUP_BY
      // 不接受「SELECT 清單／相關子查詢裡出現 e.service，而 GROUP BY 寫的是
      // e.service COLLATE ...」——它不認這兩者是同一個運算式（實測 ER_WRONG_FIELD_WITH_GROUP）。
      // 先在衍生表裡把 collation 固定成欄位本身，外層就變成單純的欄位參照，兩邊都成立。
      // e2/e3 的相關子查詢**刻意不帶 ts 下限**——sqlite 原式（server.ts 的
      // activeUsersStmt）的 e2/e3 子查詢也沒有，語意是「這個人在這個服務上最後一次
      // 用的 tool / 來源 IP」，不限於視窗內；所以它們查的是 mcp_usage 全表而不是 b。
      `SELECT b.service AS service,
              b.identity AS identity,
              CAST(COUNT(*) AS SIGNED) AS n,
              ${iso('MAX(b.ts)')} AS last_ts,
              ${iso('MIN(b.ts)')} AS first_ts,
              (SELECT ${jstr('e2', 'tool')} FROM mcp_usage e2
                WHERE ${exact('e2.service')} = b.service
                  AND ${exact('e2.identity')} = b.identity
                  AND ${jstr('e2', 'tool')} IS NOT NULL
                ORDER BY e2.ts DESC, e2.id DESC LIMIT 1) AS last_tool,
              (SELECT e3.source_ip FROM mcp_usage e3
                WHERE ${exact('e3.service')} = b.service
                  AND ${exact('e3.identity')} = b.identity
                ORDER BY e3.ts DESC, e3.id DESC LIMIT 1) AS source_ip
         FROM (
           SELECT e.id AS id, ${exact('e.service')} AS service,
                  ${exact('e.identity')} AS identity, e.ts AS ts
             FROM mcp_usage e
            WHERE ${exact('e.service')} IN (${ph}) AND e.ts >= ? AND e.identity IS NOT NULL
         ) b
        GROUP BY b.service, b.identity
        ORDER BY b.service, last_ts DESC`,
      [...serviceIds, activeSince],
    )

    // (2) 三個計數一次查完（req1h ⊂ req24h，所以只掃 dayAgo 之後）。
    const countRows = await q<any[]>(
      `SELECT ${exact('e.service')} AS service,
              CAST(SUM(CASE WHEN e.ts >= ? THEN 1 ELSE 0 END) AS SIGNED) AS req1h,
              CAST(COUNT(*) AS SIGNED) AS req24h,
              CAST(SUM(CASE WHEN ${eventExpr('e')} = 'auth_failure'
                              OR ${likeable(jstr('e', 'result'))} LIKE 'error:%'
                            THEN 1 ELSE 0 END) AS SIGNED) AS err24h
         FROM mcp_usage e
        WHERE ${exact('e.service')} IN (${ph}) AND e.ts >= ?
        GROUP BY ${exact('e.service')}`,
      [hourAgo, ...serviceIds, dayAgo],
    )

    // (3) 每個服務的最後一筆事件（PARTITION BY + ROW_NUMBER 一次拿完）。
    const lastRows = await q<any[]>(
      `SELECT service, ts, identity, tool, path, result FROM (
         SELECT ${exact('e.service')} AS service,
                ${iso('e.ts')} AS ts,
                e.identity AS identity,
                ${jstr('e', 'tool')} AS tool,
                ${jstr('e', 'path')} AS path,
                ${jstr('e', 'result')} AS result,
                ROW_NUMBER() OVER (PARTITION BY e.service ORDER BY e.ts DESC, e.id DESC) AS rn
           FROM mcp_usage e
          WHERE ${exact('e.service')} IN (${ph})
       ) t WHERE t.rn = 1`,
      [...serviceIds],
    )

    for (const id of serviceIds) {
      out.set(id, { activeUsers: [], req1h: 0, req24h: 0, err24h: 0, lastEvent: null })
    }
    for (const r of activeRows) {
      out.get(r.service)?.activeUsers.push({
        identity: r.identity,
        n: num(r.n),
        last_ts: r.last_ts,
        first_ts: r.first_ts,
        last_tool: r.last_tool ?? null,
        source_ip: r.source_ip ?? null,
      })
    }
    for (const r of countRows) {
      const s = out.get(r.service)
      if (!s) continue
      s.req1h = num(r.req1h)
      s.req24h = num(r.req24h)
      s.err24h = num(r.err24h)
    }
    for (const r of lastRows) {
      const s = out.get(r.service)
      if (!s) continue
      s.lastEvent = { ts: r.ts, identity: r.identity ?? null, tool: r.tool ?? null, path: r.path ?? null, result: r.result ?? null }
    }
    return out
  },

  async lastStatusChanges(serviceIds) {
    const out = new Map<string, LastStatusChangeRow>()
    if (serviceIds.length === 0) return out
    // 取「最後一次真正翻轉」那一列——不是最後一列（那可能只是重啟基準列，
    // 時間會變成最後一次重啟的時間，與 sqlite 的語意不同）。
    const rows = await q<any[]>(
      `${STATUS_LOG_FLIPS}
       SELECT service, ts, status FROM (
         SELECT m.service AS service, ${iso('m.ts')} AS ts, m.status AS status,
                ROW_NUMBER() OVER (PARTITION BY m.service ORDER BY m.ts DESC, m.id DESC) AS rn
           FROM marked m
          WHERE m.is_flip = 1 AND m.service IN (${placeholders(serviceIds.length)})
       ) t WHERE t.rn = 1`,
      [...serviceIds],
    )
    for (const r of rows) out.set(r.service, { ts: r.ts, status: r.status })
    return out
  },

  async queryEvents(f: EventsFilter) {
    const where: string[] = []
    const params: unknown[] = []
    // 等值比較一律加 COLLATE utf8mb4_bin：schema 的 utf8mb4_0900_ai_ci 是
    // 大小寫/重音不敏感，而 sqlite 的 `=` 是逐位元組比較。使用者輸入走這條路，
    // 不釘死 collation 兩個模式的篩選結果會不一樣。
    if (f.service) { where.push(`${exact('e.service')} = ?`); params.push(f.service) }
    if (f.identity) { where.push(`${exact('e.identity')} = ?`); params.push(f.identity) }
    if (f.from) { const c = tsCompare('e.ts', '>=', f.from); where.push(c.frag); params.push(c.param) }
    if (f.to) { const c = tsCompare('e.ts', '<=', f.to); where.push(c.frag); params.push(c.param) }
    if (f.event) { where.push(`${exact(eventExpr('e'))} = ?`); params.push(f.event) }
    if (f.errorsOnly) where.push(`(${eventExpr('e')} = 'auth_failure' OR ${likeable(jstr('e', 'result'))} LIKE 'error:%')`)
    if (f.toolOnly) where.push(`${jstr('e', 'tool')} IS NOT NULL`)
    if (f.q) {
      // 五個 operand 全部走 likeable()：sqlite 的 LIKE 對 ASCII 大小寫不敏感，
      // 而 JSON_UNQUOTE 的結果是 utf8mb4_bin（實測），不校正就會在使用者打大寫時
      // 靜默查不到東西。`e.source_ip` 是真欄位、本來就是 ai_ci，一起包起來只是
      // 讓五個 operand 的 collation 顯式一致。
      where.push(
        `(${likeable(jstr('e', 'tool'))} LIKE ? OR ${likeable(jstr('e', 'path'))} LIKE ? OR ${likeable(jstr('e', 'result'))} LIKE ?` +
          ` OR ${likeable('e.source_ip')} LIKE ? OR ${likeable(jstr('e', 'agrabahIdentifier'))} LIKE ?)`,
      )
      const like = `%${f.q}%`
      params.push(like, like, like, like, like)
    }
    // 分頁游標（a7-D46）。排序是 `ts DESC, id DESC`，所以游標也必須是 (ts, id)
    // 的 row-value 比較——只比 id 會在 id 序 ≠ ts 序時跳頁與重複列，而
    // `mcp_usage` 經 spool 寫入、Phase 6 回填更會把歷史事件以更大的 id 寫進來，
    // id 序 ≠ ts 序正是常態。
    if (f.beforeTs !== undefined && f.beforeId !== undefined) {
      where.push('(e.ts, e.id) < (?, ?)')
      params.push(isoToMysqlDatetime3(f.beforeTs), f.beforeId)
    } else if (f.beforeId !== undefined) {
      // deprecated 的 `before_id`（保留一個發版週期，給瀏覽器裡開著的舊分頁）。
      // **不沿用舊語意**——舊語意（純 id 比較）正是錯的東西；這裡把 id 翻譯成
      // 該列的 (ts, id) 再走同一條 row-value 路徑，語意與新游標完全一致。
      where.push('(e.ts, e.id) < ((SELECT ts FROM mcp_usage WHERE id = ?), ?)')
      params.push(f.beforeId, f.beforeId)
    }
    // LIMIT 片段要在下 SQL 之前算好：limit 是 NaN 時 limitClause 會丟錯，
    // 那是刻意對齊 sqlite 的行為（見該函式註解），不能吞掉。
    const limitFrag = limitClause(f.limit)
    const rows = await q<any[]>(
      `SELECT e.id AS id, e.service AS service, ${iso('e.ts')} AS ts,
              ${eventExpr('e')} AS event, e.identity AS identity, e.source_ip AS source_ip,
              ${jstr('e', 'method')} AS method, ${jstr('e', 'path')} AS path,
              ${jstr('e', 'tool')} AS tool, ${jstr('e', 'result')} AS result,
              ${jstr('e', 'agrabahIdentifier')} AS agrabah_identifier,
              ${jnum('e', 'durationMs')} AS duration_ms, ${jstr('e', 'reason')} AS reason
         FROM mcp_usage e
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY e.ts DESC, e.id DESC${limitFrag}`,
      params,
    )
    return rows.map(r => ({
      id: num(r.id),
      service: r.service,
      ts: r.ts,
      event: r.event,
      identity: r.identity ?? null,
      source_ip: r.source_ip ?? null,
      method: r.method ?? null,
      path: r.path ?? null,
      tool: r.tool ?? null,
      result: r.result ?? null,
      agrabah_identifier: r.agrabah_identifier ?? null,
      duration_ms: numOrNull(r.duration_ms),
      reason: r.reason ?? null,
    })) as EventRow[]
  },

  async sessionEvents(f: SessionsFilter) {
    const since = tsCompare('e.ts', '>=', f.since)
    const where = [since.frag, 'e.identity IS NOT NULL']
    const params: unknown[] = [since.param]
    if (f.service) { where.push(`${exact('e.service')} = ?`); params.push(f.service) }
    if (f.identity) { where.push(`${exact('e.identity')} = ?`); params.push(f.identity) }
    // ORDER BY 也釘 utf8mb4_bin：session 串接靠「同 (service, identity) 的列相鄰」，
    // ai_ci 之下 'Foo' 與 'foo' 排序上相等會交錯，JS 端的 !== 比較就會把一段
    // session 切成很多段。
    const rows = await q<any[]>(
      `SELECT e.id AS id, e.service AS service, ${iso('e.ts')} AS ts, e.identity AS identity,
              ${jstr('e', 'tool')} AS tool, ${jstr('e', 'path')} AS path,
              ${jstr('e', 'result')} AS result, e.source_ip AS source_ip,
              ${jstr('e', 'agrabahIdentifier')} AS agrabah_identifier
         FROM mcp_usage e
        WHERE ${where.join(' AND ')}
        ORDER BY e.service COLLATE utf8mb4_bin, e.identity COLLATE utf8mb4_bin, e.ts`,
      params,
    )
    return rows.map(r => ({
      id: num(r.id),
      service: r.service,
      ts: r.ts,
      identity: r.identity ?? null,
      tool: r.tool ?? null,
      path: r.path ?? null,
      result: r.result ?? null,
      source_ip: r.source_ip ?? null,
      agrabah_identifier: r.agrabah_identifier ?? null,
    })) as SessionEventRow[]
  },

  async stats(since: string, hourWindowSince: string): Promise<StatsResult> {
    // since / hourWindowSince 由 server.ts 以 new Date().toISOString() 產生，
    // 必然是合法 ISO，但仍走同一條 tsCompare 以免日後有人改成吃使用者輸入。
    const cs = tsCompare('e.ts', '>=', since)
    const ch = tsCompare('e.ts', '>=', hourWindowSince)
    const s = cs.param
    const h = ch.param

    // substr(ts,1,10) / substr(ts,1,13)（sqlite 對 ISO 字串切前綴）＝
    // MySQL 的 DATE_FORMAT 到「日」與到「T時」。
    const perDay = (await q<any[]>(
      `SELECT DATE_FORMAT(e.ts, '%Y-%m-%d') AS day, ${exact('e.service')} AS service, CAST(COUNT(*) AS SIGNED) AS n
         FROM mcp_usage e WHERE ${cs.frag} GROUP BY day, ${exact('e.service')} ORDER BY day`,
      [s],
    )).map(r => ({ day: r.day, service: r.service, n: num(r.n) }))

    const perHour = (await q<any[]>(
      `SELECT DATE_FORMAT(e.ts, '%Y-%m-%dT%H') AS hour, CAST(COUNT(*) AS SIGNED) AS n
         FROM mcp_usage e WHERE ${ch.frag} GROUP BY hour ORDER BY hour`,
      [h],
    )).map(r => ({ hour: r.hour, n: num(r.n) }))

    const topIdentities = (await q<any[]>(
      `SELECT ${exact('e.identity')} AS identity, ${exact('e.service')} AS service, CAST(COUNT(*) AS SIGNED) AS n,
              ${iso('MAX(e.ts)')} AS last_ts
         FROM mcp_usage e WHERE ${cs.frag} AND e.identity IS NOT NULL
        GROUP BY ${exact('e.identity')}, ${exact('e.service')} ORDER BY last_ts DESC LIMIT 50`,
      [s],
    )).map(r => ({ identity: r.identity, service: r.service, n: num(r.n), last_ts: r.last_ts }))

    const topTools = (await q<any[]>(
      `SELECT ${jstr('e', 'tool')} AS tool, ${exact('e.service')} AS service, CAST(COUNT(*) AS SIGNED) AS n,
              CAST(SUM(CASE WHEN ${likeable(jstr('e', 'result'))} LIKE 'error:%' THEN 1 ELSE 0 END) AS SIGNED) AS errors,
              -- 先轉 DECIMAL 再 AVG/ROUND：MySQL 對 DOUBLE 的 ROUND 走 C 函式庫的
              -- 「四捨六入五成雙」（實測 ROUND(140.5 as double) = 140），對 DECIMAL
              -- 則是「逢五進位」（= 141），而 sqlite 的 ROUND 也是逢五進位。
              -- 這一格實測就差在這裡：四筆 34/213/56/259，AVG 恰好 140.5。
              ROUND(AVG(CAST(${jnum('e', 'durationMs')} AS DECIMAL(30, 10)))) AS avg_ms
         FROM mcp_usage e WHERE ${cs.frag} AND ${jstr('e', 'tool')} IS NOT NULL
        GROUP BY tool, ${exact('e.service')} ORDER BY n DESC LIMIT 50`,
      [s],
    )).map(r => ({ tool: r.tool, service: r.service, n: num(r.n), errors: num(r.errors), avg_ms: numOrNull(r.avg_ms) }))

    const authFailures = (await q<any[]>(
      `SELECT ${exact('e.service')} AS service, ${exact('e.source_ip')} AS source_ip, ${jstr('e', 'reason')} AS reason,
              CAST(COUNT(*) AS SIGNED) AS n, ${iso('MAX(e.ts)')} AS last_ts
         FROM mcp_usage e WHERE ${cs.frag} AND ${eventExpr('e')} = 'auth_failure'
        GROUP BY ${exact('e.service')}, ${exact('e.source_ip')}, reason ORDER BY n DESC LIMIT 50`,
      [s],
    )).map(r => ({ service: r.service, source_ip: r.source_ip ?? null, reason: r.reason ?? null, n: num(r.n), last_ts: r.last_ts }))

    const total = await q<any[]>('SELECT CAST(COUNT(*) AS SIGNED) AS n FROM mcp_usage')
    return { perDay, perHour, topIdentities, topTools, authFailures, totalEvents: num(total[0]?.n) }
  },

  async statusLog(service?: string) {
    // pid / detail 在監控 DB 側收在 detail_json 裡（sqlite 是兩個獨立欄位）。
    // 這個約定必須與 Phase 4 的 status collector 寫入端一致：
    //     detail_json = {"pid": <int|null>, "detail": <string|null>}
    const rows = await q<any[]>(
      `${STATUS_LOG_FLIPS}
       SELECT m.id AS id, m.service AS service, ${iso('m.ts')} AS ts, m.status AS status,
              ${djnum('m.detail_json', 'pid')} AS pid,
              ${djstr('m.detail_json', 'detail')} AS detail
         FROM marked m
        WHERE m.is_flip = 1${service ? ' AND m.service = ?' : ''}
        ORDER BY m.ts DESC, m.id DESC LIMIT 200`,
      service ? [service] : [],
    )
    return rows.map(r => ({
      id: num(r.id),
      service: r.service,
      ts: r.ts,
      status: r.status,
      pid: numOrNull(r.pid),
      detail: r.detail ?? null,
    })) as StatusLogRow[]
  },

  async pipelineRuns(limit: number) {
    const rows = await q<any[]>(
      `${RUNS_SELECT} WHERE ${RUNS_LIST_WHERE} ORDER BY r.started_at DESC${limitClause(limit)}`,
    )
    return rows.map(toPipelineRunRow)
  },

  async pipelineRunByKey(key: string) {
    const rows = await q<any[]>(
      // 過濾條件必須與 pipelineRunsByTicket / pipelineRuns **完全一致**。
      // 少了它，一把 key 可能解析到 cancel 路徑鑄的佔位列（lifecycle_rank=10、
      // started_at 為 NULL，見 lib/mon-db.ts 的孤兒佔位列與 writes.ts 的 cancel
      // INSERT——它的 legacy_key 是有值的，idx_legacy_key 又不是唯一鍵）。
      // 那種列進到 server.ts 之後 started_at 是 null，會一路餵進
      // computeBugStages()，詳情頁畫出一片語意錯誤的東西（不會當掉，更難發現）。
      `${RUNS_SELECT} WHERE (${exact('r.legacy_key')} = ? OR ${exact('r.run_id')} = ?)
         AND ${RUNS_LIST_WHERE}
         ORDER BY r.started_at DESC LIMIT 1`,
      [key, key],
    )
    return rows.length ? toPipelineRunRow(rows[0]) : null
  },

  async pipelineRunsByTicket(kind: string, ticket: string) {
    const rows = await q<any[]>(
      `${RUNS_SELECT} WHERE ${exact('r.kind')} = ? AND ${exact('r.ticket')} = ?
         AND ${RUNS_LIST_WHERE}`,
      [kind, ticket],
    )
    return rows.map(toPipelineRunRow)
  },

  async allAgentRuns() {
    const rows = await q<any[]>(`${AGENT_RUNS_SELECT} ORDER BY a.started_at`)
    return rows.map(toAgentRunRow)
  },

  async latestBugRunKey(ticket: string) {
    const rows = await q<any[]>(
      `SELECT COALESCE(r.legacy_key, r.run_id) AS \`key\`
         FROM runs r
        WHERE r.kind = 'bug' AND ${exact('r.ticket')} = ? AND ${RUNS_LIST_WHERE}
        ORDER BY r.started_at DESC LIMIT 1`,
      [ticket],
    )
    return rows.length ? (rows[0].key as string) : null
  },

  async identityUsage() {
    const rows = await q<any[]>(
      `SELECT ${exact('e.identity')} AS identity, ${exact('e.service')} AS service, ${iso('MAX(e.ts)')} AS last_ts,
              CAST(COUNT(*) AS SIGNED) AS n
         FROM mcp_usage e
        WHERE e.identity IS NOT NULL AND ${eventExpr('e')} = 'request'
        GROUP BY ${exact('e.identity')}, ${exact('e.service')}`,
    )
    return rows.map(r => ({ identity: r.identity, service: r.service, last_ts: r.last_ts, n: num(r.n) })) as IdentityUsageRow[]
  },
}
