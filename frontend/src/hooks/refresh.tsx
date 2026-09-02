import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * 全域「刷新目前分頁」匯流排。
 *
 * 對應舊版 index.html:285 的 `$('#global-reload').onclick = () => refresh(true)`——
 * 舊版靠全域變數 `tab` 判斷該重打哪個分頁的 loader；React 版改成：
 * 每個 `useResource` 在掛載期間把自己的 `reload` 註冊進這個匯流排，
 * 殼層的「↻ 刷新」按鈕呼叫 `trigger()` 就會刷新**所有目前掛載中的資源**。
 *
 * 因為 React Router 只會掛載目前 route 的元件，「目前掛載中」＝「當前分頁」，
 * 語意與舊版一致（且不會像舊版那樣所有分頁 DOM 都常駐）。
 *
 * `trigger()` 等同舊版的 `force=true`：會忽略 `autoRefresh=false` 與 `shouldPoll` 守門。
 */

type RefreshFn = () => void | Promise<void>

interface RefreshBus {
  register: (fn: RefreshFn) => () => void
  trigger: () => void
}

const RefreshBusContext = createContext<RefreshBus | null>(null)

export function RefreshProvider({ children }: { children: ReactNode }) {
  const subscribers = useRef(new Set<RefreshFn>())

  const bus = useMemo<RefreshBus>(
    () => ({
      register(fn) {
        subscribers.current.add(fn)
        return () => {
          subscribers.current.delete(fn)
        }
      },
      trigger() {
        for (const fn of Array.from(subscribers.current)) void fn()
      },
    }),
    [],
  )

  return <RefreshBusContext.Provider value={bus}>{children}</RefreshBusContext.Provider>
}

/**
 * 把一個 reload 函式註冊進匯流排（元件掛載期間有效）。
 * `useResource` 已經幫你呼叫過了；分頁只有在「自己管的額外資料」也要吃刷新鈕時才需要直接用。
 */
export function useRegisterRefresh(fn: RefreshFn): void {
  const bus = useContext(RefreshBusContext)
  const latest = useRef(fn)
  latest.current = fn

  useEffect(() => {
    if (!bus) return
    return bus.register(() => latest.current())
  }, [bus])
}

/** 取得「刷新當前分頁」的觸發函式。殼層的 ↻ 按鈕用它。 */
export function useTriggerRefresh(): () => void {
  const bus = useContext(RefreshBusContext)
  return useCallback(() => bus?.trigger(), [bus])
}
