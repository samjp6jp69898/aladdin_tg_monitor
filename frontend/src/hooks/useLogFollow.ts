import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLogSince, fetchLogTail } from '../api/endpoints'
import { LOG_FOLLOW_INTERVAL_MS, subscribe } from '../api/transport'
import { useRegisterRefresh } from './refresh'

/**
 * Logs 分頁的「開啟檔案 + 即時跟隨」邏輯。對應舊版 index.html 的 `loadLog()`（含 748 行的 1500ms timer）。
 *
 * 流程與舊版一致：
 * 1. `GET /api/log/tail?path&kb` 拿檔尾內容，並把 `offset` 設為回傳的 `size`。
 * 2. 若 `follow` 為真且檔案存在，每 1500ms 打 `GET /api/log/since?path&offset`，
 *    把新增內容**附加**到現有文字後面，並更新 offset；若新 offset 小於前一次的 offset
 *    （log 檔被截斷或輪替），先清空已累積文字再重新開始（對應 index.html:751）。
 * 3. 換檔案 / 改 kb / 關掉 follow 都會先停掉舊訂閱再重來（不會有兩個 timer 疊加）。
 *
 * 檔案不存在時後端回 200 + `missing: true`（不是 404），此時不開跟隨。
 */
export interface UseLogFollowOptions {
  /** null 代表目前沒選檔案，不會發任何請求。 */
  path: string | null
  /** tail 讀取的 KB 數，後端預設 64、上限 2048。 */
  kb?: number
  /** 是否開啟即時跟隨。 */
  follow: boolean
}

export interface LogFollowState {
  text: string
  /** 目前讀到的檔案位移（即時跟隨的游標）。 */
  offset: number
  /** 後端回報檔案不存在。 */
  missing: boolean
  /** tail 階段的檔案大小。 */
  size: number
  loading: boolean
  error: unknown
  /** 重新從 tail 開始載入（等同舊版切檔案 / 按「重新載入」）。 */
  reload: () => Promise<void>
  /**
   * 單調遞增計數，只在「整批替換」（`/api/log/tail` 成功回應：換檔案 / 改 kb / 切換
   * follow / 呼叫 reload()）時才 +1；階段 2 的 `/api/log/since` 純追加（含其截斷清空
   * 分支，對應 index.html:751）不會動到它。呼叫端（`LogViewer`）拿它當「這次 text
   * 變動是不是整批替換」的真訊號，取代用內容形狀猜測。
   */
  loadId: number
}

export function useLogFollow({ path, kb, follow }: UseLogFollowOptions): LogFollowState {
  const [text, setText] = useState('')
  const [offset, setOffset] = useState(0)
  const [missing, setMissing] = useState(false)
  const [size, setSize] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)

  /** 給 1500ms 跟隨迴圈讀的最新 offset（避免把 offset 放進 effect deps 造成重訂閱）。 */
  const offsetRef = useRef(0)
  /** 每次重新載入就 +1，用來讓跟隨迴圈跟著重建。 */
  const [epoch, setEpoch] = useState(0)
  /** 只在 tail 整批替換成功時 +1；見 LogFollowState.loadId 註解。 */
  const [loadId, setLoadId] = useState(0)

  const reload = useCallback(async () => {
    setEpoch(e => e + 1)
  }, [])

  useRegisterRefresh(reload)

  // 階段 1：tail
  useEffect(() => {
    if (!path) {
      setText('')
      setMissing(false)
      setSize(0)
      setOffset(0)
      offsetRef.current = 0
      setError(null)
      setLoading(false)
      return
    }

    const ctrl = new AbortController()
    setLoading(true)
    fetchLogTail(path, kb, ctrl.signal)
      .then(res => {
        if (ctrl.signal.aborted) return
        setText(res.text)
        setMissing(res.missing === true)
        setSize(res.size)
        offsetRef.current = res.size
        setOffset(res.size)
        setError(null)
        setLoading(false)
        setLoadId(id => id + 1)
      })
      .catch(err => {
        if (ctrl.signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err)
        setLoading(false)
      })

    return () => ctrl.abort()
    // `follow` 故意列進依賴：對應舊版 `$('#lg-follow').onchange = loadLog`，切換「即時跟隨」
    // 要重新整個流程（重打 tail、重設 offset），不只是啟停階段 2 的訂閱。
  }, [path, kb, epoch, follow])

  // 階段 2：即時跟隨（1500ms 專屬迴圈，與全域 5 秒心跳無關）
  useEffect(() => {
    if (!path || !follow || missing) return

    const sub = subscribe(
      {
        key: 'log',
        streamable: true,
        intervalMs: LOG_FOLLOW_INTERVAL_MS,
        fetch: (_: void, signal: AbortSignal) => fetchLogSince(path, offsetRef.current, signal),
      },
      undefined,
      res => {
        // 對應舊版 index.html:751（`if (r.offset < lgOffset) out.textContent = ''`）：
        // 新 offset 小於前一次代表 log 檔被截斷/輪替，清空已累積內容重新開始。
        if (res.offset < offsetRef.current) setText('')
        offsetRef.current = res.offset
        setOffset(res.offset)
        if (res.text) setText(prev => prev + res.text)
      },
      // 舊版跟隨迴圈的例外是 `catch{}` 靜默吞掉，不中斷後續輪詢；這裡保留同樣語意。
      () => {},
    )
    return () => sub.unsubscribe()
  }, [path, follow, missing, epoch])

  return { text, offset, missing, size, loading, error, reload, loadId }
}
