# tg-monitor React 前端：共用地基契約

本文件是 **11 個分頁 agent 的唯一介面依據**。地基層（`src/api`、`src/components/shared`、
`src/hooks`、`src/lib`、`src/styles`、`src/App.tsx`）已實作完成並通過 `bun run build`；
分頁只要照本文件用，不需要（也不可以）改地基。

- 專案根：`/Users/user/aladdin/tg-monitor/frontend/`
- 建置：`cd /Users/user/aladdin/tg-monitor/frontend && bun run build`（`tsc -b && vite build`）
- 開發：`bun run dev`（port 8798，`/api` 自動 proxy 到常駐的 8799）
- 產出掛載點：`http://127.0.0.1:8799/next/`（舊版 `public/index.html` 仍在 `/`，兩者並存）

> ⚠️ 舊版 `public/index.html` 是人工審核用的比對基準，**任何人不得修改它**。

---

## 0. 下游 agent 的規矩（先讀這段）

**你可以改的**
- 你負責的那一個 page 檔：`src/pages/<Xxx>Page.tsx`
- 需要時在 `src/pages/<route>/` 底下新增**只有你這頁用**的子元件（例如 `src/pages/pipelines/AgentConversation.tsx`）

**你不可以改的（改了會讓其他 10 個 agent 一起壞掉）**
- `src/api/**`（types / client / transport / endpoints / topics）
- `src/components/shared/**`、`src/components/shell/**`
- `src/hooks/**`
- `src/lib/**`（format / routes / navigation / mutation）
- `src/styles/global.css`
- `src/App.tsx`、`src/main.tsx`
- `package.json`、`vite.config.ts`、`tsconfig*.json`（不要裝新套件）
- 專案外的 `server.ts`、`lib/*.ts`、`public/index.html`

**發現共用層缺東西時**：停下來回報指揮官（缺什麼元件、缺什麼 props、缺什麼型別欄位、
在哪一份 spec 的哪一段需要）。**不要自己動手改共用層，也不要在自己頁面裡複製一份改版**。

**其他硬規則**
- 不得使用 `dangerouslySetInnerHTML`。舊版大量用字串拼 HTML，一律改成 JSX。
- 不得自己 `fetch()` 或 `setInterval()` 拉資料——一律走 `useResource()` / `useLogFollow()`。
- 不得用 `sleep` / `setTimeout` 規避競態。
- 不得新增第三方套件。
- 中文文案照抄舊版，不要自行潤飾。

---

## 1. 目錄結構與各層職責

```
frontend/src/
├── api/
│   ├── types.ts        # 32 個端點的回傳型別（依 00-api-inventory.md，不得自行增改欄位）
│   ├── client.ts       # fetch 底層：get / post / postResult + ApiError
│   ├── endpoints.ts    # 32 個具名端點函式（唯一允許組 URL 的地方）
│   ├── transport.ts    # 傳輸抽象：Topic / subscribe（目前輪詢，未來 SSE 的唯一切換點）
│   └── topics.ts       # 預先定義好的可訂閱主題，直接餵給 useResource
├── components/
│   ├── shared/         # 16 個跨分頁共用元件（純呈現，不打 API）
│   └── shell/          # 殼層：AppShell / HeaderNav / ConnectLayout
├── hooks/
│   ├── refresh.tsx     # 全域「刷新當前分頁」匯流排（殼層 ↻ 按鈕）
│   ├── useResource.ts  # 分頁取資料的唯一入口
│   ├── useAction.ts    # mutating 端點的 confirm → POST → 結果流程
│   └── useLogFollow.ts # logs 分頁的 tail + since 即時跟隨
├── lib/
│   ├── format.ts       # 由舊版移植的格式化函式（行為刻意與舊版一致）
│   ├── routes.ts       # 11 個 route、9 顆 nav 按鈕、data-group 邏輯
│   ├── navigation.ts   # 跨分頁跳轉的路徑建構（含預填篩選條件）
│   └── mutation.ts     # POST 回傳 result/reason 兩種慣例的正規化
├── pages/              # 11 個分頁（下游 agent 的工作區）
├── styles/global.css   # 深色主題全域樣式，變數與 class 名稱與舊版完全相同
├── App.tsx             # HashRouter + 路由表
└── main.tsx            # createRoot
```

**分層原則**
- 元件只負責呈現，**不打 API**、不自己排程。
- 分頁負責：組 params → `useResource` 取資料 → 用共用元件畫出來 → 用 `useAction` 執行操作。
- 傳輸細節（輪詢 or 未來的 SSE）只有 `transport.ts` 知道。

---

## 2. `src/api` 對外簽名

### 2.1 底層（`client.ts`）

```ts
export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue>

export class ApiError extends Error {
  readonly status: number     // HTTP 狀態碼；network / JSON 解析失敗時為 0
  readonly bodyText: string   // 原始回應內文（403 純文字 'path not allowed' 在這裡）
  readonly body?: unknown     // bodyText 能解析成 JSON 時的結果
  readonly path: string
}

export function buildQuery(params?: QueryParams): string
export function get<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<T>
export function post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>
export function postResult<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>
```

- `get` / `post`：非 2xx 或 JSON 解析失敗會拋 `ApiError`（舊版 `api()` 完全不檢查 status，這是刻意的行為升級）。
- `postResult`：只要 body 是 JSON 就回傳，**不論 HTTP 狀態**。因為 server.ts 的
  mutating 端點在業務失敗時回 400/404/409/429/500 但 body 形狀相同（`{ ok:false, result|reason }`），
  訊息本身就是要顯示給使用者的。所有 `postXxx` 端點函式都走這條。
- **`GET /api/events` 的兩種 400（皆已實作、未部署，且**僅 mysql 軌**）**：解不開的
  `cursor` 回 `{error:'invalid cursor'}`（`96cd9f2`），對不到列的 deprecated `before_id`
  回 `{error:'invalid before_id'}`（`92434b9`）。body 形狀是 `{error:string}`，
  **與 mutating 端點的 `{ok:false,...}` 不同**。兩者都會經 `get()` 拋成 `ApiError`，
  訊息在 `err.bodyText`。sqlite 軌對這兩種情況都不回 400，live 現在跑 sqlite 軌。
- 三個端點在路徑白名單失敗時回 **403 純文字**（`/api/log/tail`、`/api/log/since`、`/api/agent-trace`），
  會拋 `ApiError`，訊息在 `err.bodyText`。

### 2.2 32 個端點函式（`endpoints.ts`）

每個函式最後一個參數都是選填 `signal?: AbortSignal`（下表省略）。

| # | 端點 | 函式簽名 | 回傳型別 |
|---|---|---|---|
| 1 | `GET /` | `fetchLegacyIndexHtml()` | `Promise<string>`（舊版 HTML，新前端用不到） |
| 2 | `GET /api/overview` | `fetchOverview()` | `OverviewResponse` |
| 3 | `POST /api/services/restart` | `postServiceRestart(id: string)` | `OkResult` |
| 4 | `GET /api/events` | `fetchEvents(params?: EventsParams)` | `EventsResponse` |
| 5 | `GET /api/sessions` | `fetchSessions(params?: SessionsParams)` | `SessionsResponse` |
| 6 | `GET /api/stats` | `fetchStats(days?: number)` | `StatsResponse` |
| 7 | `GET /api/status-log` | `fetchStatusLog(service?: string)` | `StatusLogResponse` |
| 8 | `GET /api/pipelines` | `fetchPipelines()` | `PipelinesResponse` |
| 9 | `GET /api/pipelines/run` | `fetchPipelineRun(key: string)` | `PipelineRunDetailResponse` |
| 10 | `GET /api/agent-trace` | `fetchAgentTrace(path: string)` | `AgentTraceResponse` |
| 11 | `POST /api/pipelines/cancel` | `postPipelineCancel(kind: 'bug'\|'demand', ticket: string)` | `CancelPipelineResponse` |
| 12 | `POST /api/pipelines/retry` | `postPipelineRetry(ticket: string)` | `RetryPipelineResponse` |
| 13 | `GET /api/toolsmith` | `fetchToolsmith()` | `ToolsmithResponse` |
| 14 | `GET /api/cluster/workers` | `fetchWorkers()` | `WorkersResponse` |
| 15 | `GET /api/cluster/worker` | `fetchWorkerDetail(name: string, ticket?: string)` | `WorkerDetailResponse` |
| 16 | `POST /api/cluster/worker/disable` | `postWorkerDisable(name: string)` | `OkReason` |
| 17 | `POST /api/cluster/worker/enable` | `postWorkerEnable(name: string)` | `OkReason` |
| 18 | `POST /api/cluster/worker/remove` | `postWorkerRemove(name: string)` | `OkReason` |
| 19 | `GET /api/tg-users` | `fetchTgUsers()` | `TgUsersResponse` |
| 20 | `POST /api/tg-users/assign` | `postTgUserAssign({ chat_id, email, force? })` | `OkResult` |
| 21 | `POST /api/tg-users/unset` | `postTgUserUnset(email: string)` | `OkResult` |
| 22 | `POST /api/tg-users/test` | `postTgUserTest(email: string, text?: string)` | `OkResult` |
| 23 | `GET /api/rosters` | `fetchRosters()` | `RostersResponse`（**頂層是陣列**） |
| 24 | `GET /api/token-grants` | `fetchTokenGrants()` | `TokenGrantsResponse` |
| 25 | `POST /api/token-grants/revoke` | `postTokenGrantRevoke(id: string, services: TokenService[])` | `OkResult` |
| 26 | `POST /api/token-grants/add` | `postTokenGrantAdd(id: string, service: TokenService)` | `OkResult` |
| 27 | `POST /api/token-grants/rename` | `postTokenGrantRename(id: string, name: string)` | `OkResult` |
| 28 | `POST /api/token-grants/create` | `postTokenGrantCreate(id: string, name: string, services: TokenService[])` | `OkResult` |
| 29 | `POST /api/token-grants/resend` | `postTokenGrantResend(id: string, services?: TokenService[])` | `OkResult` |
| 30 | `GET /api/logs` | `fetchLogs()` | `LogsResponse` |
| 31 | `GET /api/log/tail` | `fetchLogTail(path: string, kb?: number)` | `LogTailResponse` |
| 32 | `GET /api/log/since` | `fetchLogSince(path: string, offset?: number)` | `LogSinceResponse` |

`TokenService` 是列舉型別：`'admin-dev' | 'admin-pre' | 'admin-evi' | 'platform' | 'platform-6t' |
'platform-pre-pk' | 'platform-pre-6t' | 'platform-evi-6t' | 'toolsmith'`。

### 2.3 型別（`types.ts`）

全部型別定義在 `src/api/types.ts`，欄位嚴格對齊 `00-api-inventory.md`。主要出口：

`OkResult` `OkReason` `ProbeResult` `StatusLogRow` `ActiveUser` `OverviewLastEvent` `OverviewService`
`WebhookStatus` `RunningProc` `QueuedTicket` `PipelineSlots` `PipelineLock` `OverviewPipelines`
`OverviewResponse` `EventRow` `EventsParams` `EventsResponse` `SessionRow` `SessionsParams`
`SessionsResponse` `StatsPerDay` `StatsPerHour` `StatsTopIdentity` `StatsTopTool` `StatsAuthFailure`
`StatsResponse` `StatusLogResponse` `DispatchEntry` `PipelineRunBase` `PipelineRun` `PipelinesResponse`
`BugStage` `DemandProgressEntry` `PipelineRunDetailResponse` `AgentSummary` `AgentTraceMeta`
`AgentTraceResult` `AgentTraceBlock` `AgentTraceTurn` `AgentTraceResponse` `CancelPipelineResponse`
`RetryPipelineResponse` `ToolsmithStatus` `ToolsmithFinalResult` `ToolsmithGate` `ToolsmithRun`
`ToolsmithResponse` `WorkerInfo` `WorkerHealth` `QueueStats` `CapacityReport` `ProgressStage`
`JobStatus` `WorkerEntry` `WorkersResponse` `WorkerDetailResponse` `ConnectedUser` `PendingSender`
`TechUser` `TgUsersResponse` `RosterMember` `RosterEntry` `RostersResponse` `TokenGrantDetail`
`TokenPerson` `TokenGrantsResponse` `TokenService` `RegisteredLog` `PipelineLog` `LogsResponse`
`LogTailResponse` `LogSinceResponse`

**幾個容易踩的差異**（inventory 已註記，這裡再強調）：
- `GET /api/rosters` 頂層是陣列，不是物件。
- `GET /api/pipelines` 的 `rows[]`（型別 `PipelineRun`）有 `agent_count / total_input / total_output /
  total_cost`；`GET /api/pipelines/run` 的 `run`（型別 `PipelineRunBase & { running: boolean }`）**沒有**這些欄位。
- `/api/log/tail`、`/api/log/since` 檔案不存在時回 **200 + `missing: true`**，不是 404。

### 2.4 傳輸抽象（`transport.ts`）

```ts
export const POLL_INTERVAL_MS = 5000        // 舊版全域心跳 index.html:842
export const LOG_FOLLOW_INTERVAL_MS = 1500  // 舊版 logs 專屬 timer index.html:748

export interface Topic<T, P = void> {
  key: string
  fetch: (params: P, signal: AbortSignal) => Promise<T>
  intervalMs?: number
  streamable?: boolean
}
export function defineTopic<T, P = void>(topic: Topic<T, P>): Topic<T, P>

export interface SubscribeOptions {
  autoRefresh?: boolean          // 預設 true
  shouldPoll?: () => boolean     // 只擋背景輪詢，不擋手動 refresh
  intervalMs?: number
}
export interface Subscription {
  unsubscribe: () => void
  refresh: () => Promise<void>
}
export function subscribe<T, P>(
  topic: Topic<T, P>,
  params: P,
  onData: (data: T) => void,
  onError?: (err: unknown) => void,
  options?: SubscribeOptions,
): Subscription
```

分頁**不要直接呼叫 `subscribe()`**，用 `useResource()`。這裡列出來是為了說明語意。

**目前仍是輪詢，尚未切換。** 後端的 `GET /api/stream?topics=a,b` 契約已定案並寫進
`00-api-inventory.md`（`event: <topic>`，`data` 為該 topic 的完整 JSON，形狀與現有 GET 端點
**完全一致**；同 topic 連續 3 次失敗會 `controller.error()` 收場串流，連線上限 32、超過回 503，
log topic 有背壓上限）。streamable 範圍是 **overview / pipelines / pipeline-run / toolsmith / log
五類**，其中 `pipeline-run` 與 `log` 是**參數化** topic。

切換時**只需要改 `transport.ts`**，`endpoints.ts` / `useResource` / 11 個分頁都不用動——步驟與
**連線身分必須包含 params** 的警告寫在該檔最下方的「SSE 接入點」註解裡（只用 topic key 聯集當
連線身分會導致換 log 檔／換票時推錯資料）。現在刻意不寫 `EventSource` 程式碼（尚未部署，寫了
就是無法驗證的死碼）。

#### 切換前已議定且經雙方驗證的事實（交接用，不要重新談）

後端 Phase 8 子指揮官會換人，以下是已經確認過的結論，**新接手者若提出疑問，直接引用本節，
不需要重新論證**。同時這也表示：這些不是我單方的設計主張，是雙方對過的。

| 事項 | 狀態 | 依據 |
|---|---|---|
| 三種 URL 形狀（無參數 topic／`log` 用 `path`+`offset`／`pipeline-run` 用 `key`） | **已由後端實跑對齊** | 後端側實測，非文件推導；前端設計不需再改 |
| 兩層連線切分（無參數共用一條 + 每組 params 各一條） | **已核准** | 見 `transport.ts` 的「SSE 接入點」註解；解決的是「只用 topic key 聯集當連線身分 → 換 log 檔／換票會推錯資料」 |
| `scripts/verify-stream.ts` | **雙方共同的迴歸基準**（指揮官裁定） | 切 EventSource 時直接跑它，不另立一套 |
| 前端側補充回歸測試 | 保留 | 「換 log 檔／換票時真的重建對應連線、不會推到舊資料」——這是 `verify-stream.ts` 涵蓋不到的前端行為，也正是兩層連線設計要防的缺口 |
| 切換時機 | 由後端總指揮發部署通知後才動 | 前端不預先寫 `EventSource` 程式碼 |

**契約檔寫入流程**：`migration/00-api-inventory.md` 的唯一寫入者是前端這邊。其他人要變更契約，
一律把形狀送後端總指揮、由他轉來落檔，並附四項：(1) 哪個服務的路由 (2) method + 完整 path +
參數 (3) 回傳 JSON 的**實際結構 + `file:line` 佐證**（從程式碼讀出來的，不是描述性文字）
(4) 是否已部署。行號維護用 `scripts/sync-inventory-lines.ts`（含雙向涵蓋性檢查，有缺口 exit 1）。

### 2.5 預定義主題（`topics.ts`）

```ts
import { topics } from '../api/topics'
```

| topic | params 型別 | 對應端點 | streamable |
|---|---|---|---|
| `topics.overview` | `void` | `/api/overview` | ✅ |
| `topics.events` | `EventsParams` | `/api/events` | |
| `topics.sessions` | `SessionsParams` | `/api/sessions` | |
| `topics.stats` | `{ days?: number }` | `/api/stats` | |
| `topics.statusLog` | `{ service?: string }` | `/api/status-log` | |
| `topics.pipelines` | `void` | `/api/pipelines` | ✅ |
| `topics.pipelineRun` | `{ key: string }` | `/api/pipelines/run` | ✅ |
| `topics.agentTrace` | `{ path: string }` | `/api/agent-trace` | |
| `topics.toolsmith` | `void` | `/api/toolsmith` | ✅ |
| `topics.workers` | `void` | `/api/cluster/workers` | |
| `topics.workerDetail` | `{ name: string; ticket?: string }` | `/api/cluster/worker` | |
| `topics.tgUsers` | `void` | `/api/tg-users` | |
| `topics.rosters` | `void` | `/api/rosters` | |
| `topics.tokenGrants` | `void` | `/api/token-grants` | |
| `topics.logs` | `void` | `/api/logs` | |
| `topics.logTail` | `{ path: string; kb?: number }` | `/api/log/tail` | |
| `topics.logSince` | `{ path: string; offset?: number }` | `/api/log/since` | ✅ |

`topics.agentTrace` 舊版**不隨輪詢自動更新**（點才重打），用它時請傳 `{ autoRefresh: false }`。

---

## 3. Hooks

### 3.1 `useResource` — 分頁取資料的唯一入口

```ts
export interface UseResourceOptions {
  autoRefresh?: boolean       // 背景輪詢開關，預設 true；false 時仍可手動 reload
  intervalMs?: number         // 覆寫輪詢間隔
  shouldPoll?: () => boolean  // 背景輪詢守門（手動 reload 不受限）
  enabled?: boolean           // false 時完全不訂閱，預設 true
}
export interface Resource<T> {
  data: T | null
  error: unknown
  loading: boolean
  reload: () => Promise<void>
}
export function useResource<T, P>(topic: Topic<T, P>, params: P, options?: UseResourceOptions): Resource<T>
```

規則：
- `params` **必須是 JSON 可序列化的值**（內部用 `JSON.stringify` 判斷參數是否改變）。
- topic 請用 `topics.*`（模組層級物件），不要每次 render 新建。會變的輸入放進 `params`。
- unmount 時自動取消訂閱並 abort 進行中的請求。
- 掛載期間自動把 `reload` 註冊進全域刷新匯流排 → 殼層右上角「↻ 刷新」會刷新當前分頁。

**基本用法**

```tsx
import { topics } from '../api/topics'
import { useResource } from '../hooks'
import { Card, DataTable, EmptyState } from '../components/shared'
import { fmt } from '../lib/format'

export function OverviewPage() {
  const { data, error, loading } = useResource(topics.overview, undefined)

  if (loading && !data) return <div className="mute">載入中…</div>
  if (error && !data) return <div className="err">{String(error)}</div>
  if (!data) return <EmptyState text="無資料" />

  return (
    <Card title="服務">
      <DataTable
        rows={data.services}
        rowKey={s => s.id}
        emptyText="無資料"
        columns={[
          { key: 'name', header: '服務', render: s => s.name },
          { key: 'port', header: 'Port', className: 'mono', render: s => s.port },
          { key: 'checked', header: '檢查時間', className: 'mono mute',
            render: s => fmt(s.probe?.checkedAt) },
        ]}
      />
    </Card>
  )
}
```

**帶篩選參數 + 可關閉自動更新（events 分頁的「自動更新」checkbox）**

```tsx
const [service, setService] = useState('')
const [live, setLive] = useState(true)

// params 用 useMemo 或直接寫物件字面值都可以——內部以 JSON.stringify 比對，不會無限重訂閱
const { data, reload } = useResource(
  topics.events,
  { service: service || undefined, limit: 200 },
  { autoRefresh: live },
)
```

**輪詢守門（logs 的「焦點在檔案下拉時不重整」、tg-pending 的 `isPickingTechUser()`）**

```tsx
const { data } = useResource(topics.tgUsers, undefined, {
  shouldPoll: () => !document.activeElement?.id?.startsWith('tup-sel-'),
})
```

**列表／詳情切換（tokens / pipelines / workers 三頁同一個 pattern）**

```tsx
const [params] = useSearchParams()
const key = params.get('key')           // 有 key = 詳情頁，沒有 = 列表頁

const list = useResource(topics.pipelines, undefined, { enabled: !key })
const detail = useResource(topics.pipelineRun, { key: key ?? '' }, { enabled: !!key })
```

### 3.2 `useAction` — mutating 端點

```ts
export interface ActionResult { ok: boolean; message: string; raw: unknown }
export interface RunOptions {
  confirm?: string                    // 有值時先跳 window.confirm，取消則回 null
  onSettled?: () => void | Promise<void>  // 通常傳資源的 reload
}
export interface UseActionResult {
  pending: boolean
  result: ActionResult | null
  reset: () => void
  run: (fn: () => Promise<unknown>, options?: RunOptions) => Promise<ActionResult | null>
}
export function useAction(): UseActionResult
```

`message` 已經幫你統一處理兩種後端慣例：`result`（token-grants / tg-users / services.restart）
與 `reason`（pipelines.cancel|retry / cluster.worker.*）。要讀 `killed` / `pid` 之類額外欄位用 `raw`。

```tsx
const { data, reload } = useResource(topics.workers, undefined)
const action = useAction()

<Button variant="danger" disabled={action.pending}
  onClick={() => action.run(() => postWorkerDisable(w.name), {
    confirm: `確定要中斷 ${w.name} 的派工嗎？`,
    onSettled: reload,
  })}
>中斷</Button>

{action.result && (
  <div className={action.result.ok ? 'ok' : 'err'}>{action.result.message}</div>
)}
```

### 3.3 `useLogFollow` — logs 分頁的 tail + 即時跟隨

```ts
export interface UseLogFollowOptions { path: string | null; kb?: number; follow: boolean }
export interface LogFollowState {
  text: string; offset: number; missing: boolean; size: number
  loading: boolean; error: unknown; reload: () => Promise<void>
}
export function useLogFollow(opts: UseLogFollowOptions): LogFollowState
```

行為與舊版 `loadLog()` 一致：先 `tail` 取檔尾並把 offset 設成回傳的 `size`，
若 `follow` 且檔案存在則每 **1500ms** 打 `/api/log/since` 把新增內容附加到後面。
換檔案 / 改 kb / 關閉 follow 會先停舊訂閱再重來（不會兩個 timer 疊加）。
跟隨迴圈的錯誤刻意靜默（舊版 `catch{}`），不中斷輪詢。

```tsx
const [path, setPath] = useState<string | null>(null)
const [follow, setFollow] = useState(true)
const log = useLogFollow({ path, kb: 64, follow })

<LogViewer text={log.text} autoScroll={follow} emptyText="(檔案不存在)" />
```

### 3.4 刷新匯流排（`refresh.tsx`）

```ts
export function RefreshProvider({ children }: { children: ReactNode }): JSX.Element
export function useRegisterRefresh(fn: () => void | Promise<void>): void
export function useTriggerRefresh(): () => void
```

`useResource` / `useLogFollow` 已自動註冊，分頁通常不用直接碰。只有你自己管的
額外資料（不是透過 useResource 拿的）也想吃刷新鈕時才用 `useRegisterRefresh`。

---

## 4. 共用元件（`src/components/shared`）

統一從 `import { ... } from '../components/shared'` 取用。**所有元件只負責呈現，不打 API。**

### Card
```ts
export interface CardProps {
  title?: ReactNode        // 標題列（h3 是 flex，可放 dot / pill / 按鈕）
  className?: string
  titleClassName?: string
  children?: ReactNode
}
```

### CardGrid（`.grid`，auto-fill minmax(440px,1fr)）
```ts
export interface CardGridProps { className?: string; children?: ReactNode }
```

### TwoColumn（`.two`，≤1000px 降為單欄）
```ts
export interface TwoColumnProps {
  left?: ReactNode
  right?: ReactNode
  className?: string
  children?: ReactNode     // 傳 children 時忽略 left/right
}
```

### Stack（`.stack`，單欄 gap 16px）
```ts
export interface StackProps { className?: string; children?: ReactNode }
```

### StatusDot（`.dot` / `.dot.up` / `.dot.down`）
```ts
export interface StatusDotProps {
  status?: 'up' | 'down' | null   // 省略 = 灰點（未知）
  title?: string
  className?: string
}
```

### Badge（`.pill` / `.ok` / `.bad` / `.warn`）
```ts
export type PillVariant = 'default' | 'ok' | 'bad' | 'warn'   // 來自 lib/format
export interface BadgeProps {
  variant?: PillVariant
  title?: string
  className?: string
  children?: ReactNode
}
```

### ResultBadge（舊版 `resPill()`）
```ts
export interface ResultBadgeProps {
  result?: string | null
  title?: string
  className?: string
}
```
顏色規則與舊版相同：falsy / `'unknown'` → 灰（文字顯示 `-` 或 `unknown`）；
`'success'` / `'recovered'` → 綠；其餘（含所有 `error:*`）→ 紅。

### KeyValueGrid（`.kv` + `.kv b`）
```ts
export interface KeyValueRow { key?: string; label: ReactNode; value: ReactNode }
export interface KeyValueGridProps {
  rows: (KeyValueRow | false | null | undefined)[]   // falsy 會被濾掉，方便「有值才顯示整列」
  className?: string
}
```
```tsx
<KeyValueGrid rows={[
  { label: '網址', value: w.url },
  w.lastErrorMessage && { label: '上次錯誤', value: w.lastErrorMessage },
]} />
```

### Toolbar（`.bar`）
```ts
export interface ToolbarProps { className?: string; children?: ReactNode }
```
純樣式容器；輸入框、按鈕、尾端的 `<span className="mute">顯示 N 筆</span>` 都當 children 放進去。

### Button（`button.btn` / `.danger` / `.warn`）
```ts
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: 'default' | 'danger' | 'warn'
  className?: string
  children?: ReactNode
}
```
⚠️ `danger` / `warn` 不只換色：舊版 CSS 同時把 padding 縮成 `4px 10px`、字級縮到 15px，
所以它們視覺上比 default 小一號——這是原行為，不要「修正」。`type` 預設 `'button'`。

### EmptyState
```ts
export interface EmptyStateProps {
  text: string                      // 各分頁文案不同，必填，照抄舊版
  tone?: 'mute' | 'ok' | 'err'      // 預設 mute；stats「期間內無認證失敗」是 ok（綠）
  className?: string
}
```

### SubNav（`.subnav`）
```ts
export interface SubNavItem { key: string; label: string }
export interface SubNavProps {
  items: SubNavItem[]
  active: string
  onSelect: (key: string) => void
  className?: string
}
```
「連接」的三個 subtab 已由殼層的 `ConnectLayout` 統一渲染，**tokens / tg-connected /
tg-pending 三頁不要自己再畫一次 SubNav**。

### RelativeTime（舊版 `ago()`）
```ts
export interface RelativeTimeProps {
  ts?: string | null
  withTitle?: boolean   // 加 title={fmt(ts)} 的完整時間 tooltip；舊版沒有，預設 false
  className?: string
}
```
沒有自己的 timer——舊版也是靠輪詢重繪才更新，語意一致。

### LogViewer（`pre.log`）
```ts
export interface LogViewerProps {
  text: string
  autoScroll?: boolean   // 內容變動後自動捲到底（即時跟隨時開），預設 false
  height?: string        // 覆寫預設的 70vh
  emptyText?: string     // text === '' 時顯示的替代文字，例如 '(檔案不存在)'
  className?: string
}
```
純呈現。輪詢由 `useLogFollow()` 負責；靜態用途（pipelines 的 prompt、workers 的
`JSON.stringify` 區塊）直接把字串傳進 `text`。

### SparkBarChart（舊版 `barChart()`）
```ts
export interface SparkBarItem { t: Date; n: number }
export interface SparkBarChartProps { items: SparkBarItem[]; className?: string }
```
尺寸、刻度演算法、顏色、opacity、tooltip 文字格式全部照舊版
（W=1200 H=220、`step = max<=5 ? 1 : ceil(max/4)`、`n===0` 高度為 0 且 opacity 0.25、
`n>0` 保底 2px 且 opacity 0.85、tooltip `「M/D HH:00 → N 次」`）。
呼叫端仍需自己產生 24 個整點刻度（用 UTC `toISOString().slice(0,13)` 對 `perHour.hour`）。

### DataTable — 最重要、11 頁都用

```ts
export interface Column<T> {
  key: string
  header?: ReactNode
  className?: string                                        // 固定套在該欄 td（'mono' / 'tools' / 'col-outcome'）
  headerClassName?: string
  align?: 'left' | 'center' | 'right'
  cellClassName?: (row: T, index: number) => string | undefined   // 依 row 計算，例如 errors>0 加 'err'
  cellTitle?: (row: T, index: number) => string | undefined       // 原生 tooltip（顯示被截斷的完整值）
  render: (row: T, index: number) => ReactNode
}

export interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey?: (row: T, index: number) => string | number
  showHeader?: boolean                                       // 預設 true；stats 四張排行表傳 false
  rowClassName?: (row: T, index: number) => string | undefined  // 'stage-running' / 'agent-row on'
  onRowClick?: (row: T, index: number) => void
  renderExpanded?: (row: T, index: number) => ReactNode      // 回傳 null = 該列不展開
  emptyText: string                                          // 必填，照抄舊版文案
  emptyTone?: 'mute' | 'ok' | 'err'
  emptyMode?: 'row' | 'replace'                              // 預設 'row'
  maxHeight?: string                                         // 預設 '60vh'；events/sessions/pipelines/toolsmith 用 '80vh'
  scroll?: boolean                                           // 預設 true（外層 .scroll 容器）
  wrapperClassName?: string                                  // 例如 pipelines 的 'hide-outcome'
  className?: string
}
```

已支援的能力（對應舊版各分頁需求）：
1. sticky 表頭 + `.scroll` 容器 + 可調 `maxHeight`
2. `showHeader={false}` 的無表頭表（stats 的使用者排行 / tool 排行 / 認證失敗 / 每日×服務）
3. 動態欄位（`columns` 就是普通陣列，可由資料算出來）
4. 依 row 計算的 cell class 與 row class
5. 整列可點（`onRowClick`）
6. 展開列（`renderExpanded` 會自動輸出 `<tr><td colSpan={columns.length}>`）
7. 兩種空狀態：`'row'`（表內一列 colSpan）與 `'replace'`（整表換成文字），tone 可選
8. 欄位隱藏 toggle：欄位**同時**加 `className: 'col-outcome'` 與 `headerClassName: 'col-outcome'`（td 與 th 都要），容器再依開關傳 `wrapperClassName={hidden ? 'hide-outcome' : undefined}`
9. cell 可放任意 ReactNode（按鈕、連結、Badge、tool 標籤群）
10. `rowKey` 穩定 key（有 id 就一定要傳，否則展開狀態會錯位）

**刻意沒有**：客戶端排序、客戶端分頁。舊版所有排序都由 API 決定；
events 的「載入更早」是分頁自己的 append 狀態，屬頁面層。

**多段異質列**（pipelines 列表 = 排隊列 + 遠端列 + 本機歷史列）：把三段資料
先在分頁裡合併成一個帶 `kind` 標記的陣列，再用 `render` 依 `kind` 分別輸出即可，
不要為此改 DataTable。

---

## 5. `src/lib/format.ts`

全部由舊版 `public/index.html` 移植，**行為刻意與舊版完全一致**（含看起來像 bug 的地方）。

| 函式 | 簽名 | 舊版行號 | 行為與刻意保留的原行為 |
|---|---|---|---|
| `fmt` | `(ts?: string \| number \| null) => string` | 273 | falsy → `'-'`；否則 `toLocaleString('zh-TW', {hour12:false})`。無效日期不防禦，會輸出 `Invalid Date` |
| `ago` | `(ts?: string \| null) => string` | 274 | falsy → `'-'`；有 `Math.max(0,…)` 防護；每量級只顯示一個單位（`45s前` / `12m前` / `3h前` / `2d前`） |
| `dur` | `(a?: string \| null, b?: string \| null) => string` | 275 | `a` falsy → `'-'`；`b` 省略時用 `Date.now()`。**沒有負值防護**（`b<a` 會出現負數）；**超過 24 小時不轉「天」**，維持「時+分」（30 小時顯示 `30h0m`）。中間兩個量級顯示兩個單位（`3m20s` / `2h15m`） |
| `upt` | `(s?: number \| null) => string` | 276 | 寬鬆 `== null` 判斷（`0` 會輸出 `0m`）；`45m` / `3h20m` / `5d12h` |
| `resultPillVariant` | `(r?: string \| null) => PillVariant` | 277 | falsy / `'unknown'` → `'default'`；`'success'` / `'recovered'` → `'ok'`；其餘 → `'bad'` |
| `resultPillText` | `(r?: string \| null) => string` | 277 | `r \|\| '-'` |
| `fmtTok` | `(n?: number \| null) => string` | 545 | `== null` → `'-'`；≥1e6 → `X.XXM`；≥1e3 → `X.Xk`；否則原數字 |
| `fmtKb` | `(bytes?: number \| null) => string` | 736/737/745/753 | `(bytes/1024).toFixed(1) + 'KB'`。**永遠是 KB**，不會升成 MB/GB |
| `hms` | `(ts?: string \| number \| null) => string` | 557/563/588/596 | `fmt(ts).slice(-8)`——對**本地化字串**做尾端切片，不是重新格式化 |
| `fmtMsSec` | `(ms?: number \| null) => string` | 597 | `(ms/1000).toFixed(1) + 's'` |

**刻意沒有移植**
- `$`（querySelector，index.html:271）：React 用 ref / state 取代。
- `esc`（HTML escape，index.html:272）：React 自動跳脫文字節點。**新前端不得使用
  `dangerouslySetInnerHTML`**，所以不提供 `esc`，也不要自己寫一個。
- `api`（index.html:278）：由 `src/api/client.ts` 取代（並補上舊版缺的 status 檢查）。
- 金額 `$` 格式、千分位：舊版**零使用**（`total_cost` 從未顯示），不要憑空加。

**分頁專屬、不要放共用層**：`slot()`（workers）、`techUserLabel()` / `resolveTechUserEmail()`
（tg-pending）、`tsStatusPill()` / `tsGatePills()`（toolsmith）、`blockHtml()`（pipelines）、
各種 `slice(0, N)` 截斷。這些請放在自己的 `src/pages/<route>/` 底下。

---

## 6. 路由與跨分頁跳轉

### 6.1 11 個 page 檔案對照表（**路徑與 export 名稱是契約，不可更動**）

| # | route（網址 `#/<route>`） | nav 標籤 | 檔案 | export | 規格 |
|---|---|---|---|---|---|
| 1 | `overview` | 總覽 | `src/pages/OverviewPage.tsx` | `OverviewPage` | `tabs/overview.md` |
| 2 | `events` | 即時序列 | `src/pages/EventsPage.tsx` | `EventsPage` | `tabs/events.md` |
| 3 | `sessions` | 使用 Session | `src/pages/SessionsPage.tsx` | `SessionsPage` | `tabs/sessions.md` |
| 4 | `stats` | 歷史統計 | `src/pages/StatsPage.tsx` | `StatsPage` | `tabs/stats.md` |
| 5 | `tokens` | 連接 › Token 權限 | `src/pages/TokensPage.tsx` | `TokensPage` | `tabs/tokens.md` |
| 6 | `tg-connected` | 連接 › TG 已連接 | `src/pages/TgConnectedPage.tsx` | `TgConnectedPage` | `tabs/tg-connected.md` |
| 7 | `tg-pending` | 連接 › TG 待處理 | `src/pages/TgPendingPage.tsx` | `TgPendingPage` | `tabs/tg-pending.md` |
| 8 | `pipelines` | Pipelines | `src/pages/PipelinesPage.tsx` | `PipelinesPage` | `tabs/pipelines.md` |
| 9 | `toolsmith` | Toolsmith | `src/pages/ToolsmithPage.tsx` | `ToolsmithPage` | `tabs/toolsmith.md` |
| 10 | `workers` | Workers | `src/pages/WorkersPage.tsx` | `WorkersPage` | `tabs/workers.md` |
| 11 | `logs` | Logs | `src/pages/LogsPage.tsx` | `LogsPage` | `tabs/logs.md` |

預設路由導向 `overview`；未知路由也導回 `overview`。
「連接」那顆 nav 按鈕在 `tokens` / `tg-connected` / `tg-pending` 三個 route 下都呈現選中態
（舊版 `data-group` 機制，實作在 `lib/routes.ts` 的 `isNavActive()`）。

### 6.2 跨分頁跳轉（`lib/navigation.ts`）

舊版是「直接改目標分頁的 DOM 輸入框再 showTab」；React 版改成把條件放進 **網址 query**，
目標分頁用 `useSearchParams()` 讀出來當初始值。**query 參數名稱是雙向契約**。

```ts
export interface EventsJumpFilters {
  service?: string; identity?: string; q?: string; errors?: boolean; toolOnly?: boolean
}
export function eventsPath(f?: EventsJumpFilters): string   // 舊版 jumpEvents / jumpEventsQuery
export function logsPath(path?: string): string             // 舊版 openLog(path)
export function pipelinesPath(key?: string): string         // 有 key = 詳情頁
export function workersPath(name?: string, ticket?: string): string  // 有 name = 詳情頁
export function tokensPath(id?: string): string             // 有 id = 詳情頁
export function tgConnectedPath(): string
export function tgPendingPath(): string
export function overviewPath(): string
export function sessionsPath(): string
export function statsPath(): string
export function toolsmithPath(): string
```

| 目標分頁 | 認得的 query 參數 | 誰會送過來 |
|---|---|---|
| `events` | `service`, `identity`, `q`, `errors`(`'1'`), `toolOnly`(`'1'`) | sessions（看事件）、stats（tool 排行 / 認證失敗來源） |
| `logs` | `path` | pipelines（log 連結）、workers |
| `pipelines` | `key`（詳情） | overview、自己 |
| `workers` | `name`（詳情）、`ticket`（查票） | pipelines（查看 worker）、自己 |
| `tokens` | `id`（詳情） | 自己 |

送出端：
```tsx
const navigate = useNavigate()
<a onClick={e => { e.preventDefault(); navigate(eventsPath({ service: s.service, identity: s.identity })) }}>看事件</a>
```
接收端：
```tsx
const [sp] = useSearchParams()
const [service, setService] = useState(sp.get('service') ?? '')
const [errorsOnly, setErrorsOnly] = useState(sp.get('errors') === '1')
```

**列表／詳情頁也一律用 query 參數**（`?key=` / `?name=` / `?id=`），不要用元件內部 state——
這樣可分享網址、可用瀏覽器上一頁，而且三頁做法一致。

### 6.3 events / sessions 的服務下拉選單

舊版 events / sessions 的「全部服務」下拉選項來自 `/api/overview` 的 `services`
（`fillServiceSelects()`，只放 `hasAudit === true` 的服務，選項文字 `{name} :{port}`），
所以進入這兩頁時若 `services` 為空會**先打一次 `/api/overview`**。

React 版做法：這兩頁各自
```tsx
const overview = useResource(topics.overview, undefined)
const serviceOptions = (overview.data?.services ?? []).filter(s => s.hasAudit)
// <option value={s.id}>{`${s.name} :${s.port}`}</option>
```
（`/api/overview` 本來就是 5 秒輪詢的便宜端點，不另外做快取層。）

---

## 7. 輪詢間隔與各分頁刷新規則（照抄舊版）

- 全域心跳 **5000ms**（`POLL_INTERVAL_MS`，舊版 index.html:842）——所有分頁預設值。
- Logs 即時跟隨 **1500ms**（`LOG_FOLLOW_INTERVAL_MS`，舊版 index.html:748）——獨立迴圈。

| 分頁 | 背景輪詢行為 | 對應 `useResource` 設定 |
|---|---|---|
| overview / sessions / stats / toolsmith / tg-connected | 無條件重查 | 預設即可 |
| events | 只有「自動更新」勾選時才重查；刷新鈕無視勾選 | `{ autoRefresh: liveChecked }` |
| logs（檔案清單） | 焦點不在檔案下拉時才重整清單 | `{ shouldPoll: () => document.activeElement?.id !== 'lg-file' }` |
| logs（檔案內容） | 專屬 1500ms 迴圈 | `useLogFollow()` |
| tg-pending | 焦點在搜尋框（`tup-sel-*`）時跳過本輪 | `{ shouldPoll: () => !isPicking() }` |
| tokens / pipelines / workers | 依目前在列表頁或詳情頁，只查對應的那一支 | 兩個 `useResource` 各配 `{ enabled }` |

---

## 8. 已定調的「刻意行為差異」（不是 bug，不要各自決定）

| # | 舊版行為 | 新版行為 | 理由 |
|---|---|---|---|
| 1 | 手動編輯網址列 hash 不會切分頁（沒監聽 hashchange） | HashRouter 會正確切換 | 舊版的已知限制，修掉比較好 |
| 2 | toolsmith 展開的詳情列每 5 秒被輪詢重繪收合 | 展開狀態存 React state，輪詢不影響 | `innerHTML` 整表重建的副作用；React 沒有這個副作用，不要刻意重現 |
| 3 | tokens 詳情頁 `.tkd-env` checkbox 每 5 秒被回填覆蓋 | 使用者手動勾選狀態存 React state，不被輪詢沖掉 | 同上 |
| 4 | `api()` 不檢查 HTTP status | `get`/`post` 非 2xx 拋 `ApiError` | 錯誤能被看見；mutating 端點另有 `postResult` 維持可用性 |
| 5 | tg-connected / tg-pending 各自打一次 `/api/tg-users` | 維持各自打 | tg-pending 有焦點保護的特例，共用 cache 反而更複雜 |

**規則**：資料一律照輪詢刷新；**純 UI 狀態（展開、勾選、輸入到一半的文字）存 React state，
不被輪詢覆蓋**。這是全站一致的原則。

---

## 9. 已知的文件落差（實作時注意）

1. **`tabs/*.md` 的 `server.ts` 行號需 +15**。`00-api-inventory.md` 開頭有註明行號位移，
   但 11 份 tab 規格沒有註記，它們同樣是 `/next/*` 路由加入前的舊基準。
   API 路徑 / 參數 / 回傳結構不受影響。`index.html` 的行號則**完全正確**（實測 845 行對得上）。
2. **pipelines「重試」語意**：`tabs/pipelines.md §4-7` 說是 `--resume` 續跑，但
   `index.html:523-527` 的原始碼註解寫「整張從 Step 1 重跑」。註解已過時，
   **以 spec 與 confirm 文案為準**。
3. `01-shell-and-shared.md §6` 把 `RelativeTime` 與 `EmptyState` 列給 events，
   但 `tabs/events.md` 明確說 events 不用 `ago()`、也刻意沒有空狀態文案 → **以 events.md 為準**。
4. 沒有任何分頁用到 `/api/events` 的 `from` / `to` / `event` 參數，也沒用
   `/api/status-log?service` → 型別保留，UI 不做（除非規格另有要求）。
5. `total_cost` / `total_cost_usd` 舊版**從未顯示** → 不需要金額格式化。

---

## 10. 驗收（每個分頁 agent 交付前自己跑）

```bash
cd /Users/user/aladdin/tg-monitor/frontend
NODE_OPTIONS=--max-old-space-size=8192 bun run build   # 必須成功
bunx tsc -b --force                                    # 必須零錯誤
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8799/next/   # 200
```

`server.ts` 是 launchd 常駐服務，靜態檔直接吃 `frontend/dist`，build 完重新整理瀏覽器即可看到。
