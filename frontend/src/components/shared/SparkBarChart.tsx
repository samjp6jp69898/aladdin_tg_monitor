/**
 * 每小時請求數長條圖。對應舊版 index.html:370-389 的 `barChart(items)`。
 *
 * 舊版回傳 SVG 的 HTML 字串，這裡改成 JSX 元素（新前端不得用 dangerouslySetInnerHTML），
 * 但**尺寸、刻度演算法、顏色、opacity、tooltip 文字格式與舊版完全一致**：
 *
 * - 畫布 W=1200 H=220，內距 padL=46 padR=12 padT=26 padB=34。
 * - `max = Math.max(1, ...n)`；`step = max<=5 ? 1 : ceil(max/4)`；`top = ceil(max/step)*step`。
 * - 長條寬 `bw*0.7`、起點偏移 `bw*0.15`，其中 `bw = (W-padL-padR)/items.length`。
 * - **`n===0` 時高度是 0 不是 2**（`Math.max(x.n?2:0, h)`），opacity 0.25；`n>0` 時保底 2px、opacity 0.85。
 * - `n>0` 才在長條上方標數字；X 軸標本地時間兩位數小時。
 */
export interface SparkBarItem {
  /** 該小時的本地時間（顯示用；分組比對是呼叫端用 UTC 做的）。 */
  t: Date
  n: number
}

export interface SparkBarChartProps {
  items: SparkBarItem[]
  className?: string
}

const W = 1200
const H = 220
const PAD_L = 46
const PAD_R = 12
const PAD_T = 26
const PAD_B = 34

export function SparkBarChart({ items, className }: SparkBarChartProps) {
  const max = Math.max(1, ...items.map(x => x.n))
  const step = max <= 5 ? 1 : Math.ceil(max / 4)
  const top = Math.ceil(max / step) * step
  const cw = W - PAD_L - PAD_R
  const ch = H - PAD_T - PAD_B
  const bw = cw / (items.length || 1)
  const y = (v: number) => PAD_T + ch - (v / top) * ch

  const gridValues: number[] = []
  for (let v = 0; v <= top; v += step) gridValues.push(v)

  return (
    <div className={className ? `spark ${className}` : 'spark'}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
        {gridValues.map(v => (
          <g key={`g${v}`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="var(--line)" />
            <text
              x={PAD_L - 8}
              y={y(v) + 5}
              textAnchor="end"
              fill="var(--mute)"
              fontSize="13"
              fontFamily="var(--mono)"
            >
              {v}
            </text>
          </g>
        ))}
        {items.map((x, i) => {
          const h = (x.n / top) * ch
          const bx = PAD_L + i * bw + bw * 0.15
          const bh = Math.max(x.n ? 2 : 0, h)
          const label =
            x.t.toLocaleString('zh-TW', {
              hour12: false,
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
            }) + ':00'
          return (
            <g className="bar" key={i}>
              <title>{`${label} → ${x.n} 次`}</title>
              <rect
                x={bx}
                y={y(x.n)}
                width={bw * 0.7}
                height={bh}
                rx={3}
                fill="var(--acc)"
                opacity={x.n ? 0.85 : 0.25}
              />
              {x.n ? (
                <text
                  x={bx + bw * 0.35}
                  y={y(x.n) - 6}
                  textAnchor="middle"
                  fill="var(--fg)"
                  fontSize="13"
                  fontFamily="var(--mono)"
                >
                  {x.n}
                </text>
              ) : null}
              <text
                x={bx + bw * 0.35}
                y={H - PAD_B + 18}
                textAnchor="middle"
                fill="var(--mute)"
                fontSize="12"
                fontFamily="var(--mono)"
              >
                {String(x.t.getHours()).padStart(2, '0')}
              </text>
            </g>
          )
        })}
        <text x={W - PAD_R} y={14} textAnchor="end" fill="var(--mute)" fontSize="12">
          X 軸：本地時間（時）　Y 軸：請求數
        </text>
      </svg>
    </div>
  )
}
