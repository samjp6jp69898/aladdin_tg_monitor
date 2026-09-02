/**
 * 傳輸抽象層。
 *
 * ## 為什麼需要這一層
 * 後端目前 32 個端點**全部是輪詢式 JSON，沒有 SSE**（server.ts 註解說明原因：
 * Bun 1.2.9 的 ReadableStream 在客戶端中斷連線時會 segfault）。但後端負責人已定案
 * 未來會加上單一 SSE 端點：
 *
 *     GET /api/stream?topics=a,b
 *     event: <topic>
 *     data:  <該 topic 的完整 JSON payload，形狀與現有 GET 端點回傳完全一致>
 *
 * 範圍是 overview / pipelines / toolsmith / log 跟隨 這四類，其餘維持 request/response。
 *
 * 因為 payload 形狀不變，**元件不應該知道底下是輪詢還是 SSE**。所有分頁一律透過
 * `subscribe()`（或包裝它的 `useResource`）拿資料，不要自己 setInterval、不要自己 fetch。
 *
 * ## 未來接 SSE 的唯一切換點
 * 見本檔最下方 `SSE 接入點` 區塊的註解。**只需要改這個檔案**，
 * endpoints.ts / hooks / 11 個分頁都不用動。
 * 現在刻意不寫 EventSource 程式碼——後端端點還不存在，寫了就是死碼。
 */

/* ────────────────────────────── 輪詢間隔（照抄舊版原始毫秒數） ────────────────────────────── */

/**
 * 全域心跳。對應舊版 public/index.html:842 `setInterval(()=>refresh(false), 5000)`。
 * 所有分頁的資料新鮮度上限都是 5 秒（events 分頁另有「自動更新」開關可關掉自己的輪詢）。
 */
export const POLL_INTERVAL_MS = 5000

/**
 * Logs 分頁「即時跟隨」專屬 timer。對應舊版 public/index.html:748 的
 * `lgTimer = setInterval(async () => {...}, 1500)`。與全域 5 秒心跳是兩條獨立迴圈。
 */
export const LOG_FOLLOW_INTERVAL_MS = 1500

/* ────────────────────────────── Topic 定義 ────────────────────────────── */

/**
 * 一個可訂閱的資料主題。
 *
 * - `key`：主題名稱。未來 SSE 上線後就是 `?topics=` 裡的值與 `event:` 名稱，
 *   所以請用後端定案的名字（overview / pipelines / toolsmith / log）。
 *   不在 SSE 範圍內的主題自己取一個好懂的名字即可。
 * - `fetch`：目前輪詢實作用的抓取函式。SSE 上線後仍保留，作為
 *   「首次載入」與「SSE 不支援此 topic 時的 fallback」。
 * - `intervalMs`：輪詢間隔。預設 POLL_INTERVAL_MS。
 * - `streamable`：後端 /api/stream 未來是否會推這個 topic。目前只是宣告，
 *   實際行為仍是輪詢；SSE 接上後由本檔依此旗標決定走哪條路。
 */
export interface Topic<T, P = void> {
  key: string
  fetch: (params: P, signal: AbortSignal) => Promise<T>
  intervalMs?: number
  streamable?: boolean
}

/** 型別推導用的小工具，讓 topic 定義處不必手寫泛型。 */
export function defineTopic<T, P = void>(topic: Topic<T, P>): Topic<T, P> {
  return topic
}

/* ────────────────────────────── subscribe ────────────────────────────── */

export interface SubscribeOptions {
  /**
   * 背景輪詢是否啟用。false 時只做首次載入，之後不自動更新，
   * 但 `refresh()` 仍然可以手動觸發（對應舊版 events 分頁的「自動更新」checkbox）。
   * 預設 true。
   */
  autoRefresh?: boolean
  /**
   * 每次「背景」輪詢前的守門函式，回傳 false 就跳過這一輪。
   * 對應舊版 logs 分頁「焦點在檔案下拉時不重整清單」與 tg-pending 的
   * `isPickingTechUser()` 保護。**手動 refresh() 不受此限制**（等同舊版 force=true）。
   */
  shouldPoll?: () => boolean
  /** 覆寫 topic 的預設輪詢間隔。 */
  intervalMs?: number
}

/**
 * 訂閱控制代號。
 *
 * 註：規格建議 `subscribe()` 回傳單一 unsubscribe 函式，這裡改回傳物件，
 * 因為殼層右上角的「↻ 刷新」需要一個手動觸發點（舊版 `refresh(true)`）。
 * `unsubscribe` 仍是純函式，可直接當 useEffect 的 cleanup 回傳值。
 */
export interface Subscription {
  /** 取消訂閱：停掉排程、中止進行中的請求，之後不會再呼叫任何 callback。 */
  unsubscribe: () => void
  /** 立即重抓一次（等同舊版 refresh(true)），忽略 autoRefresh 與 shouldPoll。 */
  refresh: () => Promise<void>
}

/**
 * 訂閱一個 topic。目前實作是輪詢；未來 streamable 的 topic 會改走 SSE，
 * 但這個簽名與 callback 語意不變。
 *
 * @param topic   要訂閱的主題（用 defineTopic 定義，或直接寫物件字面值）
 * @param params  傳給 topic.fetch 的參數
 * @param onData  每次成功取得資料時呼叫
 * @param onError 每次取得資料失敗時呼叫（被取消的請求不會觸發）
 */
export function subscribe<T, P>(
  topic: Topic<T, P>,
  params: P,
  onData: (data: T) => void,
  onError?: (err: unknown) => void,
  options: SubscribeOptions = {},
): Subscription {
  const { autoRefresh = true, shouldPoll, intervalMs } = options
  const period = intervalMs ?? topic.intervalMs ?? POLL_INTERVAL_MS

  let closed = false
  let inFlight: AbortController | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  /**
   * 執行一次抓取。
   * `background=true` 代表這是排程觸發的（要吃 shouldPoll 守門）；false 代表手動 refresh。
   *
   * 同一時間只允許一個請求：新的一輪開始前先 abort 掉還沒回來的舊請求，
   * 避免慢回應覆蓋掉新資料（順序保證由結構決定，不靠等待時間）。
   */
  async function run(background: boolean): Promise<void> {
    if (closed) return
    if (background && shouldPoll && !shouldPoll()) return

    inFlight?.abort()
    const ctrl = new AbortController()
    inFlight = ctrl

    try {
      const data = await topic.fetch(params, ctrl.signal)
      if (closed || ctrl.signal.aborted) return
      onData(data)
    } catch (err) {
      if (closed || ctrl.signal.aborted) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      onError?.(err)
    } finally {
      if (inFlight === ctrl) inFlight = null
    }
  }

  // 首次載入立即打一次，不等第一個間隔。
  void run(false)

  if (autoRefresh) {
    timer = setInterval(() => void run(true), period)
  }

  return {
    unsubscribe() {
      if (closed) return
      closed = true
      if (timer !== null) clearInterval(timer)
      timer = null
      inFlight?.abort()
      inFlight = null
    },
    refresh() {
      return run(false)
    },
  }
}

/* ────────────────────────────── SSE 接入點 ────────────────────────────── */

/**
 * 未來要把 streamable 的 topic 改走 `GET /api/stream?topics=...` 時，**只改這個檔案**：
 *
 * 1. 在本檔加一個模組層級的單例連線管理器（多個 topic 共用同一條 EventSource，
 *    topics 參數是所有目前被訂閱、且 `streamable === true` 的 topic key 聯集；
 *    有人訂閱/退訂造成聯集改變時重建連線）。
 * 2. `subscribe()` 改成：
 *    - `topic.streamable !== true` → 維持現在的輪詢分支，完全不變。
 *    - `topic.streamable === true` → 先用 `topic.fetch()` 打一次拿初始畫面（SSE 只推增量事件，
 *      不保證連上就立刻給一份完整快照），然後掛上 `addEventListener(topic.key, ...)`，
 *      收到事件就 `onData(JSON.parse(ev.data))`。因為 payload 形狀與 GET 端點完全一致，
 *      `onData` 的型別不用改。
 *    - 連線失敗 / `onerror` → 呼叫 `onError`，並降級回輪詢（EventSource 自帶重連，
 *      但降級可以避免長時間白畫面）。
 * 3. `unsubscribe()` 移除該 listener，若某個 topic 已無人訂閱就更新連線的 topics 聯集。
 *
 * 其他層完全不用動：endpoints.ts 照樣提供 fetch 函式（初次載入與 fallback 都需要），
 * useResource 與 11 個分頁看到的介面不變。
 *
 * ⚠️ 在後端 /api/stream 真的上線之前不要提前寫 EventSource 程式碼——
 * 端點不存在，寫了就是無法驗證的死碼。
 */
export const SSE_ENDPOINT_PATH = '/api/stream'

/** 後端定案會走 SSE 的四類 topic key。目前僅作為文件與 defineTopic 的參考值。 */
export const STREAMABLE_TOPICS = ['overview', 'pipelines', 'toolsmith', 'log'] as const
export type StreamableTopicKey = (typeof STREAMABLE_TOPICS)[number]
