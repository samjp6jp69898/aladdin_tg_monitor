import { Fragment } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * 通用資料表。對應舊版裸 `<table>` + `.scroll` 容器 + sticky `<th>` 的樣式組合。
 *
 * 全 11 個分頁都用它，所以能力刻意做得比單一分頁需要的多；
 * 不需要的能力（客戶端排序、客戶端分頁）**刻意沒有**——舊版所有排序都由 API 決定。
 */

export interface Column<T> {
  /** React key 與欄位識別；同一張表內不可重複。 */
  key: string
  /** 表頭內容；`showHeader={false}` 時忽略。 */
  header?: ReactNode
  /** 固定套在該欄每個 `<td>` 的 class（例如 'mono'、'tools'、'col-outcome'）。 */
  className?: string
  /** 固定套在該欄 `<th>` 的 class。 */
  headerClassName?: string
  /** 對齊方式；預設沿用 CSS 的 left。 */
  align?: 'left' | 'center' | 'right'
  /** 依 row 計算的額外 cell class（例如錯誤數 >0 時加 'err'）。 */
  cellClassName?: (row: T, index: number) => string | undefined
  /** 固定或依 row 計算的 per-cell inline style；與 className 並存，不互相取代。 */
  cellStyle?: CSSProperties | ((row: T, index: number) => CSSProperties | undefined)
  /** 原生 tooltip（例如顯示被截斷的完整 requestId）。 */
  cellTitle?: (row: T, index: number) => string | undefined
  /** 格式化輸出；可回傳任意 ReactNode（按鈕、連結、Badge 都可以）。 */
  render: (row: T, index: number) => ReactNode
}

export interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  /** row 的 React key；省略時用索引（會讓展開狀態在資料變動時錯位，有穩定 id 就一定要傳）。 */
  rowKey?: (row: T, index: number) => string | number
  /** 是否渲染 `<thead>`；stats 的四張排行表刻意沒有表頭。預設 true。 */
  showHeader?: boolean
  /** 依 row 計算的 `<tr>` class（'stage-running'、'agent-row on' 等）。 */
  rowClassName?: (row: T, index: number) => string | undefined
  /** 整列可點；有值時會自動加 cursor:pointer 的 `agent-row` 語意由 rowClassName 決定。 */
  onRowClick?: (row: T, index: number) => void
  /**
   * 展開列內容。回傳 null / undefined 代表這列目前不展開。
   * 內部會多渲染一個 `<tr><td colSpan={columns.length}>` 的列。
   * ⚠️ 展開狀態請存在分頁自己的 React state（舊版每次輪詢重繪會被沖掉，新版刻意不重現此行為）。
   */
  renderExpanded?: (row: T, index: number) => ReactNode
  /** 無資料時的文案，各分頁不同。`emptyMode='none'` 時不會顯示，可省略。 */
  emptyText?: string
  /** 無資料文案色調。 */
  emptyTone?: 'mute' | 'ok' | 'err'
  /**
   * 'row'（預設）：在表格內渲染一列 `<td colSpan>` 的空狀態，表頭仍在。
   * 'replace'：整張表被空狀態文字取代（舊版多數卡片是這種）。
   * 'none'：查無資料時完全不渲染任何 `<tr>`（連空狀態列都沒有），只留表頭列、無提示文案。
   *   對應舊版部分表格「查無資料就是空 tbody」的行為（例如 Token 名冊、events 分頁刻意無空狀態）。
   */
  emptyMode?: 'row' | 'replace' | 'none'
  /** 滾動容器高度；預設 '60vh'（對應 `.scroll`）。events/sessions 等用 '80vh'。 */
  maxHeight?: string
  /** 關掉外層滾動容器（表格很短、或外層已自行處理滾動時）。預設 true。 */
  scroll?: boolean
  /** 套在外層滾動容器（例如 pipelines 的 'hide-outcome'）。 */
  wrapperClassName?: string
  /** 套在 `<table>`。 */
  className?: string
}

function alignStyle(align?: 'left' | 'center' | 'right'): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  showHeader = true,
  rowClassName,
  onRowClick,
  renderExpanded,
  emptyText,
  emptyTone = 'mute',
  emptyMode = 'row',
  maxHeight = '60vh',
  scroll = true,
  wrapperClassName,
  className,
}: DataTableProps<T>) {
  const isEmpty = rows.length === 0

  if (isEmpty && emptyMode === 'replace') {
    return <div className={emptyTone}>{emptyText}</div>
  }

  const table = (
    <table className={className}>
      {showHeader && (
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} className={c.headerClassName} style={alignStyle(c.align)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {isEmpty ? (
          emptyMode === 'none' ? null : (
            <tr>
              <td colSpan={columns.length} className={emptyTone}>
                {emptyText}
              </td>
            </tr>
          )
        ) : (
          rows.map((row, i) => {
            const key = rowKey ? rowKey(row, i) : i
            const expanded = renderExpanded ? renderExpanded(row, i) : null
            return (
              <Fragment key={key}>
                <tr
                  className={rowClassName?.(row, i)}
                  onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                >
                  {columns.map(c => {
                    const extra = c.cellClassName?.(row, i)
                    const cls = [c.className, extra].filter(Boolean).join(' ') || undefined
                    const cellStyle = typeof c.cellStyle === 'function' ? c.cellStyle(row, i) : c.cellStyle
                    const style = cellStyle ? { ...alignStyle(c.align), ...cellStyle } : alignStyle(c.align)
                    return (
                      <td key={c.key} className={cls} style={style} title={c.cellTitle?.(row, i)}>
                        {c.render(row, i)}
                      </td>
                    )
                  })}
                </tr>
                {expanded ? (
                  <tr>
                    <td colSpan={columns.length}>{expanded}</td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })
        )}
      </tbody>
    </table>
  )

  if (!scroll) return wrapperClassName ? <div className={wrapperClassName}>{table}</div> : table

  const cls = wrapperClassName ? `scroll ${wrapperClassName}` : 'scroll'
  return (
    <div className={cls} style={{ maxHeight }}>
      {table}
    </div>
  )
}
