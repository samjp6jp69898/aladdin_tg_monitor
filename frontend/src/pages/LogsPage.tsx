/**
 * Logs分頁（route: `#/logs`）。
 *
 * 規格：/Users/user/aladdin/tg-monitor/migration/tabs/logs.md
 * 契約：/Users/user/aladdin/tg-monitor/migration/02-frontend-contract.md
 *
 * 對應舊版 `loadLogList()`（index.html:733-739）+ `loadLog()`（740-757）+ `window.openLog()`（758）。
 *
 * 兩層獨立輪詢：
 * 1. 檔案清單（`#lg-file` 選項）：全域 5000ms（`topics.logs`），焦點在下拉選單上時跳過本輪
 *    （對應舊版 `refresh()` 的非 force 分支：`document.activeElement !== $('#lg-file')`）。
 * 2. 檔案內容即時跟隨：`useLogFollow()` 內部專屬 1500ms 迴圈，換檔案 / 改 kb / 關閉跟隨
 *    都由該 hook 自行停舊訂閱重開，這裡不用管。
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { topics } from '../api/topics'
import type { LogsResponse } from '../api/types'
import { Button, LogViewer, Toolbar } from '../components/shared'
import { useLogFollow, useResource } from '../hooks'
import { ago, fmtKb } from '../lib/format'

/** 對應舊版 `#lg-kb` 的四個固定選項，64KB 為預設。 */
const KB_OPTIONS: { value: number; label: string }[] = [
  { value: 16, label: '16KB' },
  { value: 64, label: '64KB' },
  { value: 256, label: '256KB' },
  { value: 1024, label: '1MB' },
]

interface LogOption {
  label: string
  path: string
  disabled?: boolean
}

/** 對應舊版 `loadLogList()` 組選項文案的邏輯，逐行照抄。 */
function buildOptions(data: LogsResponse | null): LogOption[] {
  if (!data) return []
  const opts: LogOption[] = data.registered.map(l => ({
    label: `[${l.service}] ${l.label}${l.exists ? ` (${fmtKb(l.size)})` : ' (不存在)'}`,
    path: l.path,
    disabled: !l.exists,
  }))
  if (data.pipelineLogs.length) {
    opts.push({ label: '── pipeline 逐票 log ──', path: '', disabled: true })
    for (const l of data.pipelineLogs) {
      opts.push({ label: `${l.label} (${fmtKb(l.size)}, ${ago(l.mtime)})`, path: l.path })
    }
  }
  return opts
}

export function LogsPage() {
  const [searchParams] = useSearchParams()
  // 對應舊版 `window.openLog(path)`：跨分頁跳轉帶 `?path=` 進來時直接選中該檔案。
  const [path, setPath] = useState<string | null>(() => searchParams.get('path') || null)
  const [kb, setKb] = useState(64)
  const [follow, setFollow] = useState(true)

  const list = useResource(topics.logs, undefined, {
    shouldPoll: () => document.activeElement?.id !== 'lg-file',
  })

  const options = useMemo(() => buildOptions(list.data), [list.data])

  // 對應舊版 refresh() 的 force 分支：`if (!$('#lg-file').value && options.length) 選第一項`。
  useEffect(() => {
    if (path || options.length === 0) return
    setPath(options[0].path)
  }, [options, path])

  const log = useLogFollow({ path, kb, follow })

  // `#lg-info`：missing 或載入中或未選檔案時清空，否則顯示目前已讀到的位移換算 KB。
  const info = !path || log.loading || log.missing ? '' : fmtKb(log.offset)

  return (
    <>
      <Toolbar>
        <select
          id="lg-file"
          style={{ minWidth: 420 }}
          value={path ?? ''}
          onChange={e => setPath(e.target.value || null)}
        >
          {options.map((o, i) => (
            <option key={`${o.path}-${i}`} value={o.path} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <select id="lg-kb" value={kb} onChange={e => setKb(Number(e.target.value))}>
          {KB_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" id="lg-follow" checked={follow} onChange={e => setFollow(e.target.checked)} /> 即時跟隨
        </label>
        <Button id="lg-reload" onClick={() => log.reload()}>
          重新載入
        </Button>
        <span className="mute" id="lg-info">
          {info}
        </span>
      </Toolbar>
      {/* autoScroll 固定為 true（不綁 follow）：LogViewer 內部會依 reloadToken（= useLogFollow 的
          loadId，只在整批替換的 tail 抓取成功時 +1）分別套用「無條件捲到底」（載入/換檔/改 kb/
          切換 follow/重讀）與「40px atBottom 才捲」（即時跟隨輪詢的純追加），與 follow 是否勾選
          無關（見 index.html:744 vs 751-753）。follow 只決定是否有追加事件發生。 */}
      <LogViewer
        text={log.text}
        autoScroll
        reloadToken={log.loadId}
        emptyText={log.missing ? '(檔案不存在)' : undefined}
      />
    </>
  )
}
