import { useCallback, useEffect, useRef, useState } from 'react'
import { POLL_INTERVAL_MS, subscribe, type Topic } from '../api/transport'
import { useRegisterRefresh } from './refresh'

/**
 * 分頁取得資料的唯一入口。內部包住 `transport.subscribe()`，
 * 所以元件不需要知道底下是輪詢還是（未來的）SSE，也不需要自己寫 setInterval。
 *
 * 同時把 `reload` 註冊進全域刷新匯流排，殼層右上角的「↻ 刷新」會刷新當前分頁。
 */

export interface UseResourceOptions {
  /**
   * 背景自動更新開關。false 時只做首次載入，之後不自動刷新，
   * 但 `reload()` 與殼層刷新鈕仍然有效（對應舊版 events 分頁的「自動更新」checkbox）。
   * 預設 true。
   */
  autoRefresh?: boolean
  /** 覆寫輪詢間隔（毫秒）。預設用 topic.intervalMs，再預設 POLL_INTERVAL_MS(5000)。 */
  intervalMs?: number
  /**
   * 背景輪詢前的守門函式，回傳 false 就跳過這一輪。
   * 對應舊版 logs 的「焦點在檔案下拉時不重整」與 tg-pending 的 `isPickingTechUser()`。
   * **手動 reload / 刷新鈕不受此限制**。
   */
  shouldPoll?: () => boolean
  /** false 時完全不訂閱、不載入（例如詳情面板關閉時）。預設 true。 */
  enabled?: boolean
}

export interface Resource<T> {
  /** 尚未成功取得資料前為 null。 */
  data: T | null
  /** 最近一次失敗的錯誤（成功一次後會清成 null）。 */
  error: unknown
  /** 首次載入（或參數改變後重新載入）尚未有結果時為 true；背景輪詢不會把它變回 true。 */
  loading: boolean
  /** 立即重抓一次（等同舊版 refresh(true)）。 */
  reload: () => Promise<void>
}

/**
 * @param topic  資料主題。**請定義在模組層級**（或用 useMemo 固定），不要每次 render 產生新物件裡
 *               閉包舊 state——所有會變的輸入都應該放進 `params`。
 * @param params 傳給 topic.fetch 的參數。**必須是 JSON 可序列化的值**，
 *               內部用 `JSON.stringify(params)` 當作「參數是否改變」的依據。
 */
export function useResource<T, P>(
  topic: Topic<T, P>,
  params: P,
  options: UseResourceOptions = {},
): Resource<T> {
  const { autoRefresh = true, intervalMs, shouldPoll, enabled = true } = options

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState<boolean>(enabled)

  // 讓 subscribe 內永遠看到最新的 topic / params / shouldPoll，而不必把它們放進 effect deps。
  const topicRef = useRef(topic)
  topicRef.current = topic
  const paramsRef = useRef(params)
  paramsRef.current = params
  const shouldPollRef = useRef(shouldPoll)
  shouldPollRef.current = shouldPoll

  const subRef = useRef<{ refresh: () => Promise<void> } | null>(null)

  const paramsKey = JSON.stringify(params ?? null)

  // 取資料 effect：只在 topic / params / enabled 改變時重建訂閱（會立即打一次首抓）。
  // 刻意不吃 autoRefresh / intervalMs——這兩個只影響下面的排程 effect，
  // 否則切換 autoRefresh 會重建訂閱、連帶多打一次不必要的即時 fetch。
  useEffect(() => {
    if (!enabled) {
      subRef.current = null
      setLoading(false)
      return
    }

    setLoading(true)

    const sub = subscribe<T, P>(
      {
        key: topicRef.current.key,
        intervalMs: topicRef.current.intervalMs,
        streamable: topicRef.current.streamable,
        fetch: (p, signal) => topicRef.current.fetch(p, signal),
      },
      paramsRef.current,
      next => {
        setData(next)
        setError(null)
        setLoading(false)
      },
      err => {
        setError(err)
        setLoading(false)
      },
      // 排程交給下面的 effect 自己管理，這裡只負責首次載入與 reload() 用的 refresh()。
      { autoRefresh: false },
    )

    subRef.current = sub
    return () => {
      subRef.current = null
      sub.unsubscribe()
    }
    // topic 以 key 判定是否換了主題；params 以序列化字串判定。
  }, [topic.key, paramsKey, enabled])

  // 排程 effect：只負責「要不要、多久」呼叫一次 refresh()，本身不觸發即時 fetch。
  // shouldPoll 守門在這裡自己做（等同 subscribe() 內部背景輪詢的守門邏輯），
  // 手動 reload() 走 subRef.refresh()，不受此限制、也不受這個 effect 影響。
  useEffect(() => {
    if (!enabled || !autoRefresh) return

    const period = intervalMs ?? topicRef.current.intervalMs ?? POLL_INTERVAL_MS
    const timer = setInterval(() => {
      if (shouldPollRef.current && !shouldPollRef.current()) return
      void subRef.current?.refresh()
    }, period)

    return () => clearInterval(timer)
  }, [autoRefresh, intervalMs, enabled, topic.key, paramsKey])

  const reload = useCallback(async () => {
    await subRef.current?.refresh()
  }, [])

  useRegisterRefresh(reload)

  return { data, error, loading, reload }
}
