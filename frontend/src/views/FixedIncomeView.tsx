import { useCallback, useEffect, useMemo, useState } from 'react'
import { Panel, Segmented } from '../components/Panel'
import type { DataConfig } from '../lib/api'
import { calculateBond, getHistoricalYields, getYieldCurve } from '../lib/api'
import type {
  BondCalculatorInput,
  BondCalculatorOutput,
  HistoricalYieldPoint,
  YieldCurveSnapshot,
  YieldPoint,
} from '../lib/types'

interface FixedIncomeViewProps {
  config: DataConfig
}

export default function FixedIncomeView({ config }: FixedIncomeViewProps) {
  const [snapshot, setSnapshot] = useState<YieldCurveSnapshot | null>(null)
  const [history, setHistory] = useState<HistoricalYieldPoint[]>([])
  const [historyRange, setHistoryRange] = useState<'1M' | '6M' | '1Y' | '3Y' | '5Y' | 'MAX'>('1Y')
  const [historyMode, setHistoryMode] = useState<'spread' | 'corporate'>('spread')
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Curve series toggles
  const [show1mAgo, setShow1mAgo] = useState(true)
  const [show1yAgo, setShow1yAgo] = useState(true)
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null)

  // Bond Calculator state
  const [calcInputs, setCalcInputs] = useState<BondCalculatorInput>({
    face_value: 1000,
    coupon_rate: 4.75,
    ytm: 4.4,
    years_to_maturity: 10,
    frequency: 2,
  })
  const [calcOutput, setCalcOutput] = useState<BondCalculatorOutput | null>(null)

  const loadSnapshot = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await getYieldCurve(config)
      setSnapshot(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load yield curve data')
    } finally {
      setLoading(false)
    }
  }, [config])

  const loadHistory = useCallback(async () => {
    try {
      setHistoryLoading(true)
      const data = await getHistoricalYields(config, historyRange)
      setHistory(data)
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [config, historyRange])

  useEffect(() => {
    loadSnapshot()
  }, [loadSnapshot])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // Run bond calculator on input change
  useEffect(() => {
    let cancelled = false
    calculateBond(config, calcInputs).then((res) => {
      if (!cancelled) setCalcOutput(res)
    })
    return () => {
      cancelled = true
    }
  }, [config, calcInputs])

  // Curve geometry helpers
  const curvePoints = snapshot?.curve_points ?? []
  const curve1m = snapshot?.curve_points_1m_ago ?? []
  const curve1y = snapshot?.curve_points_1y_ago ?? []

  const { minYield, maxYield, curveXCoords, getYCoord } = useMemo(() => {
    if (curvePoints.length === 0) {
      return { minYield: 0, maxYield: 6, curveXCoords: [], getYCoord: () => 0 }
    }
    const allYields = [
      ...curvePoints.map((p) => p.yield_pct),
      ...(show1mAgo ? curve1m.map((p) => p.yield_pct) : []),
      ...(show1yAgo ? curve1y.map((p) => p.yield_pct) : []),
    ]
    const minY = Math.max(0, Math.floor(Math.min(...allYields) * 2) / 2 - 0.5)
    const maxY = Math.ceil(Math.max(...allYields) * 2) / 2 + 0.5

    const chartW = 740
    const chartH = 260
    const paddingLeft = 50
    const paddingRight = 30
    const paddingTop = 20
    const paddingBottom = 40
    const plotW = chartW - paddingLeft - paddingRight
    const plotH = chartH - paddingTop - paddingBottom

    const count = curvePoints.length
    const xCoords = curvePoints.map((_, i) =>
      count > 1 ? paddingLeft + (i / (count - 1)) * plotW : paddingLeft + plotW / 2,
    )

    const getY = (val: number) => {
      const clamped = Math.max(minY, Math.min(maxY, val))
      return paddingTop + (1 - (clamped - minY) / (maxY - minY)) * plotH
    }

    return { minYield: minY, maxYield: maxY, curveXCoords: xCoords, getYCoord: getY }
  }, [curvePoints, curve1m, curve1y, show1mAgo, show1yAgo])

  // Historical chart geometry helpers
  const { histPoints, histMinY, histMaxY, getHistYCoord, getHistXCoord } = useMemo(() => {
    if (history.length === 0) {
      return {
        histPoints: [],
        histMinY: 0,
        histMaxY: 5,
        getHistYCoord: () => 0,
        getHistXCoord: () => 0,
      }
    }
    let vals: number[] = []
    if (historyMode === 'spread') {
      vals = history.map((p) => p.t10y2y ?? 0)
    } else {
      vals = [
        ...history.map((p) => p.dgs10 ?? 0),
        ...history.map((p) => p.aaa ?? 0),
        ...history.map((p) => p.baa ?? 0),
      ].filter((v) => v > 0)
    }
    const minY = Math.floor(Math.min(...vals) - 0.5)
    const maxY = Math.ceil(Math.max(...vals) + 0.5)

    const chartW = 740
    const chartH = 220
    const paddingLeft = 50
    const paddingRight = 30
    const paddingTop = 20
    const paddingBottom = 30
    const plotW = chartW - paddingLeft - paddingRight
    const plotH = chartH - paddingTop - paddingBottom

    const count = history.length
    const getX = (i: number) =>
      count > 1 ? paddingLeft + (i / (count - 1)) * plotW : paddingLeft + plotW / 2
    const getY = (val: number) => {
      const clamped = Math.max(minY, Math.min(maxY, val))
      return paddingTop + (1 - (clamped - minY) / (maxY - minY)) * plotH
    }

    return {
      histPoints: history,
      histMinY: minY,
      histMaxY: maxY,
      getHistYCoord: getY,
      getHistXCoord: getX,
    }
  }, [history, historyMode])

  const buildPath = (pts: YieldPoint[]) => {
    if (pts.length === 0 || curveXCoords.length === 0) return ''
    return pts
      .map((p, i) => {
        const x = curveXCoords[i] ?? 0
        const y = getYCoord(p.yield_pct)
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
  }

  const buildHistPath = (field: 't10y2y' | 'dgs10' | 'aaa' | 'baa') => {
    if (histPoints.length === 0) return ''
    const valid = histPoints
      .map((p, i) => {
        const val = p[field]
        if (val == null) return null
        return { x: getHistXCoord(i), y: getHistYCoord(val) }
      })
      .filter((p): p is { x: number; y: number } => p !== null)

    return valid.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ')
  }

  const isCurveInverted = (snapshot?.spread_10y_2y_bps ?? 0) < -5
  const isCurveFlat = Math.abs(snapshot?.spread_10y_2y_bps ?? 0) <= 5

  return (
    <main className="app__main">
      {error && (
        <div className="banner banner--error">
          <span className="banner__label">Error</span>
          <span className="banner__message">{error}</span>
        </div>
      )}

      {/* Benchmark KPI Strip */}
      <section className="kpi-band kpi-band--wrap" aria-label="Fixed Income Benchmarks">
        <div className="kpi__cell">
          <span className="kpi__label">US 10Y Benchmark</span>
          <span className="num kpi__value">{snapshot ? `${snapshot.us10y_yield.toFixed(2)}%` : '—'}</span>
          <span className="kpi__sub">Risk-free global benchmark</span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">US 2Y Treasury</span>
          <span className="num kpi__value">{snapshot ? `${snapshot.us2y_yield.toFixed(2)}%` : '—'}</span>
          <span className="kpi__sub">Monetary policy anchor</span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">2Y/10Y Spread (Recession Alert)</span>
          <span className={`num kpi__value ${isCurveInverted ? 'color--negative' : 'color--positive'}`}>
            {snapshot ? `${snapshot.spread_10y_2y_bps > 0 ? '+' : ''}${snapshot.spread_10y_2y_bps.toFixed(1)} bps` : '—'}
          </span>
          <span className="kpi__sub">
            {isCurveInverted ? '⚠️ Inversion Signal' : isCurveFlat ? 'Flat Curve' : 'Normal Upward Slope'}
          </span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">3M/10Y Spread</span>
          <span className={`num kpi__value ${(snapshot?.spread_10y_3m_bps ?? 0) < 0 ? 'color--negative' : 'color--positive'}`}>
            {snapshot ? `${snapshot.spread_10y_3m_bps > 0 ? '+' : ''}${snapshot.spread_10y_3m_bps.toFixed(1)} bps` : '—'}
          </span>
          <span className="kpi__sub">Short liquidity spread</span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">Moody's Baa Corporate</span>
          <span className="num kpi__value">{snapshot?.baa_yield ? `${snapshot.baa_yield.toFixed(2)}%` : '—'}</span>
          <span className="kpi__sub">
            {snapshot?.credit_spread_baa_10y_bps
              ? `+${snapshot.credit_spread_baa_10y_bps.toFixed(0)} bps vs 10Y UST`
              : 'Investment Grade'}
          </span>
        </div>
      </section>

      {/* Panel 1: US Treasury Term Structure (Yield Curve) */}
      <Panel
        title="US Treasury Term Structure (Yield Curve)"
        subtitle={snapshot?.as_of_date ? `Reference As-Of ${snapshot.as_of_date} • 1M to 30Y constant maturity` : undefined}
        padded
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 'var(--size-caption)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '12px', height: '3px', background: '#0f62fe', borderRadius: '1px' }} />
              <strong style={{ color: 'var(--text-primary)' }}>Current</strong>
            </span>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={show1mAgo}
                onChange={(e) => setShow1mAgo(e.target.checked)}
              />
              <span style={{ width: '12px', height: '2px', background: '#0072c3', borderTop: '1px dashed #0072c3' }} />
              <span style={{ color: 'var(--text-secondary)' }}>1M Ago</span>
            </label>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={show1yAgo}
                onChange={(e) => setShow1yAgo(e.target.checked)}
              />
              <span style={{ width: '12px', height: '2px', background: '#8a3ffc', borderTop: '1px dashed #8a3ffc' }} />
              <span style={{ color: 'var(--text-secondary)' }}>1Y Ago</span>
            </label>

            <button
              type="button"
              className="button button--quiet button--sm"
              onClick={() => {
                loadSnapshot()
                loadHistory()
              }}
              disabled={loading}
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        }
      >
        <div style={{ width: '100%', overflowX: 'auto' }}>
          <svg
            viewBox="0 0 740 260"
            style={{ width: '100%', height: 'auto', minWidth: '600px', display: 'block' }}
            onMouseLeave={() => setHoveredPointIndex(null)}
          >
            {/* Horizontal Grid lines */}
            {[...Array(6)].map((_, i) => {
              const yVal = minYield + (i / 5) * (maxYield - minYield)
              const y = getYCoord(yVal)
              return (
                <g key={i}>
                  <line
                    x1="50"
                    y1={y}
                    x2="710"
                    y2={y}
                    stroke="var(--line)"
                    strokeDasharray="2 4"
                    strokeWidth="1"
                  />
                  <text
                    x="42"
                    y={y + 4}
                    fill="var(--text-tertiary)"
                    fontSize="10"
                    textAnchor="end"
                    fontFamily="var(--font-mono)"
                  >
                    {yVal.toFixed(1)}%
                  </text>
                </g>
              )
            })}

            {/* Vertical guides and X labels */}
            {curvePoints.map((p, i) => {
              const x = curveXCoords[i] ?? 0
              return (
                <g key={p.tenor}>
                  <line
                    x1={x}
                    y1="20"
                    x2={x}
                    y2="220"
                    stroke="var(--line-weak)"
                    strokeWidth="1"
                  />
                  <text
                    x={x}
                    y="238"
                    fill="var(--text-secondary)"
                    fontSize="11"
                    textAnchor="middle"
                    fontFamily="var(--font-mono)"
                    fontWeight={hoveredPointIndex === i ? 'bold' : 'normal'}
                  >
                    {p.tenor}
                  </text>
                </g>
              )
            })}

            {/* 1 Year Ago Curve (Purple dashed) */}
            {show1yAgo && curve1y.length > 0 && (
              <path
                d={buildPath(curve1y)}
                fill="none"
                stroke="#8a3ffc"
                strokeWidth="1.75"
                strokeDasharray="4 3"
                opacity="0.8"
              />
            )}

            {/* 1 Month Ago Curve (Teal dashed) */}
            {show1mAgo && curve1m.length > 0 && (
              <path
                d={buildPath(curve1m)}
                fill="none"
                stroke="#0072c3"
                strokeWidth="1.75"
                strokeDasharray="3 3"
                opacity="0.85"
              />
            )}

            {/* Current Curve (Vibrant Blue solid) */}
            {curvePoints.length > 0 && (
              <path
                d={buildPath(curvePoints)}
                fill="none"
                stroke="#0f62fe"
                strokeWidth="2.5"
              />
            )}

            {/* Current Curve Vertex Dots & Hover Targets */}
            {curvePoints.map((p, i) => {
              const x = curveXCoords[i] ?? 0
              const y = getYCoord(p.yield_pct)
              const isHovered = hoveredPointIndex === i
              return (
                <g
                  key={`pt-${p.tenor}`}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredPointIndex(i)}
                >
                  <circle cx={x} cy={y} r="14" fill="transparent" />
                  <circle
                    cx={x}
                    cy={y}
                    r={isHovered ? 6 : 4}
                    fill="#0f62fe"
                    stroke="var(--surface-panel)"
                    strokeWidth="2"
                  />
                </g>
              )
            })}

            {/* Hover Tooltip Box */}
            {hoveredPointIndex !== null && curvePoints[hoveredPointIndex] && (
              (() => {
                const idx = hoveredPointIndex
                const cur = curvePoints[idx]
                const ago1m = curve1m[idx]
                const ago1y = curve1y[idx]
                const x = curveXCoords[idx] ?? 0
                const y = getYCoord(cur.yield_pct)

                const boxW = 150
                const boxH = 80
                const boxX = x > 560 ? x - boxW - 12 : x + 12
                const boxY = Math.max(15, Math.min(140, y - boxH / 2))

                return (
                  <g pointerEvents="none">
                    <line
                      x1={x}
                      y1="20"
                      x2={x}
                      y2="220"
                      stroke="#0f62fe"
                      strokeWidth="1"
                      strokeDasharray="2 2"
                    />
                    <rect
                      x={boxX}
                      y={boxY}
                      width={boxW}
                      height={boxH}
                      fill="var(--surface-raised)"
                      stroke="var(--line-strong)"
                      strokeWidth="1"
                      rx="4"
                      filter="drop-shadow(0 4px 10px rgba(0,0,0,0.4))"
                    />
                    <text
                      x={boxX + 10}
                      y={boxY + 18}
                      fill="var(--text-primary)"
                      fontSize="11"
                      fontWeight="bold"
                      fontFamily="var(--font-mono)"
                    >
                      Tenor: {cur.tenor} ({cur.years < 1 ? `${Math.round(cur.years * 12)} Mo` : `${cur.years} Yr`})
                    </text>
                    <text
                      x={boxX + 10}
                      y={boxY + 36}
                      fill="#0f62fe"
                      fontSize="11"
                      fontFamily="var(--font-mono)"
                    >
                      Today: {cur.yield_pct.toFixed(2)}%
                    </text>
                    {ago1m && (
                      <text
                        x={boxX + 10}
                        y={boxY + 52}
                        fill="#0072c3"
                        fontSize="10"
                        fontFamily="var(--font-mono)"
                      >
                        1M Ago: {ago1m.yield_pct.toFixed(2)}% ({(cur.yield_pct - ago1m.yield_pct) > 0 ? '+' : ''}
                        {((cur.yield_pct - ago1m.yield_pct) * 100).toFixed(0)} bps)
                      </text>
                    )}
                    {ago1y && (
                      <text
                        x={boxX + 10}
                        y={boxY + 68}
                        fill="#8a3ffc"
                        fontSize="10"
                        fontFamily="var(--font-mono)"
                      >
                        1Y Ago: {ago1y.yield_pct.toFixed(2)}% ({(cur.yield_pct - ago1y.yield_pct) > 0 ? '+' : ''}
                        {((cur.yield_pct - ago1y.yield_pct) * 100).toFixed(0)} bps)
                      </text>
                    )}
                  </g>
                )
              })()
            )}
          </svg>
        </div>
      </Panel>

      {/* Panel 2: Historical Yield Trends & Spread Inversion */}
      <Panel
        title="Historical Spread & Credit Trends"
        subtitle="Recession inversion monitors and investment grade credit risk premiums"
        padded
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Segmented
              ariaLabel="Historical series mode"
              options={[
                { value: 'spread', label: '10Y-2Y Spread' },
                { value: 'corporate', label: 'Corporate vs UST' },
              ]}
              value={historyMode}
              onChange={setHistoryMode}
            />

            <Segmented
              ariaLabel="Historical lookback range"
              options={[
                { value: '1M', label: '1M' },
                { value: '6M', label: '6M' },
                { value: '1Y', label: '1Y' },
                { value: '3Y', label: '3Y' },
                { value: '5Y', label: '5Y' },
                { value: 'MAX', label: 'MAX' },
              ]}
              value={historyRange}
              onChange={setHistoryRange}
            />
          </div>
        }
      >
        <div style={{ width: '100%', overflowX: 'auto' }}>
          {historyLoading ? (
            <div style={{ height: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
              Loading historical trend data...
            </div>
          ) : history.length === 0 ? (
            <div style={{ height: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
              No historical data available for selected range.
            </div>
          ) : (
            <svg
              viewBox="0 0 740 220"
              style={{ width: '100%', height: 'auto', minWidth: '600px', display: 'block' }}
            >
              {/* Grid Lines */}
              {[...Array(5)].map((_, i) => {
                const yVal = histMinY + (i / 4) * (histMaxY - histMinY)
                const y = getHistYCoord(yVal)
                return (
                  <g key={i}>
                    <line
                      x1="50"
                      y1={y}
                      x2="710"
                      y2={y}
                      stroke="var(--line)"
                      strokeDasharray="2 4"
                      strokeWidth="1"
                    />
                    <text
                      x="42"
                      y={y + 4}
                      fill="var(--text-tertiary)"
                      fontSize="10"
                      textAnchor="end"
                      fontFamily="var(--font-mono)"
                    >
                      {yVal.toFixed(1)}%
                    </text>
                  </g>
                )
              })}

              {/* Zero-line highlight if in spread mode */}
              {historyMode === 'spread' && histMinY <= 0 && histMaxY >= 0 && (
                <g>
                  <line
                    x1="50"
                    y1={getHistYCoord(0)}
                    x2="710"
                    y2={getHistYCoord(0)}
                    stroke="var(--negative)"
                    strokeWidth="1.5"
                    strokeDasharray="4 2"
                  />
                  <text
                    x="715"
                    y={getHistYCoord(0) + 4}
                    fill="var(--negative)"
                    fontSize="10"
                    fontFamily="var(--font-mono)"
                    fontWeight="bold"
                  >
                    Inversion (0%)
                  </text>
                </g>
              )}

              {/* Lines depending on mode */}
              {historyMode === 'spread' ? (
                <path
                  d={buildHistPath('t10y2y')}
                  fill="none"
                  stroke="#0f62fe"
                  strokeWidth="2"
                />
              ) : (
                <>
                  <path
                    d={buildHistPath('dgs10')}
                    fill="none"
                    stroke="#42be65"
                    strokeWidth="2"
                  />
                  <path
                    d={buildHistPath('aaa')}
                    fill="none"
                    stroke="#0f62fe"
                    strokeWidth="1.75"
                    strokeDasharray="3 2"
                  />
                  <path
                    d={buildHistPath('baa')}
                    fill="none"
                    stroke="#ff832b"
                    strokeWidth="2"
                  />
                </>
              )}

              {/* X Axis Dates */}
              {histPoints.length > 0 && (
                <>
                  <text
                    x="50"
                    y="205"
                    fill="var(--text-tertiary)"
                    fontSize="10"
                    fontFamily="var(--font-mono)"
                  >
                    {histPoints[0].date}
                  </text>
                  <text
                    x="710"
                    y="205"
                    fill="var(--text-tertiary)"
                    fontSize="10"
                    fontFamily="var(--font-mono)"
                    textAnchor="end"
                  >
                    {histPoints[histPoints.length - 1].date}
                  </text>
                </>
              )}
            </svg>
          )}
        </div>

        {historyMode === 'corporate' && (
          <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-2)', fontSize: '11px', color: 'var(--text-secondary)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '10px', height: '3px', background: '#42be65' }} /> 10-Year Treasury
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '10px', height: '3px', background: '#0f62fe', borderTop: '1px dashed #0f62fe' }} /> Moody's Aaa (High Quality)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '10px', height: '3px', background: '#ff832b' }} /> Moody's Baa (Corporate Spread)
            </span>
          </div>
        )}
      </Panel>

      {/* Panel 3: Institutional Bond Pricing & Risk Calculator */}
      <Panel
        title="Institutional Bond Pricing & Risk Calculator"
        subtitle="Duration, convexity, and interest rate shock stress testing"
        padded
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--space-4)' }}>
          {/* Inputs Panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div style={{ fontSize: 'var(--size-caption)', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}>
              Bond Parameters
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
              <label className="field">
                <span className="field__label">Face / Par Value ($)</span>
                <input
                  type="number"
                  className="field__input"
                  value={calcInputs.face_value}
                  step="100"
                  onChange={(e) =>
                    setCalcInputs({ ...calcInputs, face_value: Number(e.target.value) || 1000 })
                  }
                />
              </label>

              <label className="field">
                <span className="field__label">Annual Coupon (%)</span>
                <input
                  type="number"
                  className="field__input"
                  value={calcInputs.coupon_rate}
                  step="0.1"
                  onChange={(e) =>
                    setCalcInputs({ ...calcInputs, coupon_rate: Number(e.target.value) || 0 })
                  }
                />
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
              <label className="field">
                <span className="field__label">Yield to Maturity (%)</span>
                <input
                  type="number"
                  className="field__input"
                  value={calcInputs.ytm}
                  step="0.05"
                  onChange={(e) =>
                    setCalcInputs({ ...calcInputs, ytm: Math.max(0.01, Number(e.target.value) || 0.01) })
                  }
                />
              </label>

              <label className="field">
                <span className="field__label">Years to Maturity</span>
                <input
                  type="number"
                  className="field__input"
                  value={calcInputs.years_to_maturity}
                  step="0.5"
                  onChange={(e) =>
                    setCalcInputs({ ...calcInputs, years_to_maturity: Number(e.target.value) || 1 })
                  }
                />
              </label>
            </div>

            <label className="field">
              <span className="field__label">Coupon Payment Frequency</span>
              <select
                className="field__input"
                value={calcInputs.frequency}
                onChange={(e) =>
                  setCalcInputs({ ...calcInputs, frequency: Number(e.target.value) || 2 })
                }
              >
                <option value={2}>Semi-Annual (US Treasury Standard - 2/yr)</option>
                <option value={1}>Annual (Eurobond Standard - 1/yr)</option>
                <option value={4}>Quarterly (4/yr)</option>
              </select>
            </label>
          </div>

          {/* Computed Output Metrics */}
          <div>
            <div style={{ fontSize: 'var(--size-caption)', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px', marginBottom: 'var(--space-3)' }}>
              Pricing & Sensitivities
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
              <div className="card kpi" style={{ padding: 'var(--space-3)' }}>
                <span className="kpi__label">Bond Price (Clean)</span>
                <span className="kpi__value">${calcOutput ? calcOutput.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</span>
                <span className="kpi__caption">
                  {calcOutput && calcOutput.price > calcInputs.face_value
                    ? 'Trading at Premium'
                    : calcOutput && calcOutput.price < calcInputs.face_value
                    ? 'Trading at Discount'
                    : 'Trading at Par'}
                </span>
              </div>

              <div className="card kpi" style={{ padding: 'var(--space-3)' }}>
                <span className="kpi__label">Modified Duration</span>
                <span className="kpi__value">{calcOutput ? `${calcOutput.modified_duration.toFixed(2)} yrs` : '—'}</span>
                <span className="kpi__caption">Price sensitivity per 100 bps shift</span>
              </div>

              <div className="card kpi" style={{ padding: 'var(--space-3)' }}>
                <span className="kpi__label">Macaulay Duration</span>
                <span className="kpi__value">{calcOutput ? `${calcOutput.macaulay_duration.toFixed(2)} yrs` : '—'}</span>
                <span className="kpi__caption">Weighted cash flow horizon</span>
              </div>

              <div className="card kpi" style={{ padding: 'var(--space-3)' }}>
                <span className="kpi__label">Convexity & DV01</span>
                <span className="kpi__value">{calcOutput ? `${calcOutput.convexity.toFixed(1)}` : '—'}</span>
                <span className="kpi__caption">
                  DV01: ${calcOutput ? calcOutput.dv01.toFixed(2) : '—'} per bp
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Rate Shock Scenario Table */}
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div style={{ fontSize: 'var(--size-caption)', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px', marginBottom: 'var(--space-2)' }}>
            Interest Rate Shock Sensitivity Matrix (Stress Test)
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Rate Shift</th>
                  <th style={{ textAlign: 'right' }}>Shocked YTM</th>
                  <th style={{ textAlign: 'right' }}>Repriced Bond</th>
                  <th style={{ textAlign: 'right' }}>Price Change ($)</th>
                  <th style={{ textAlign: 'right' }}>Price Change (%)</th>
                </tr>
              </thead>
              <tbody>
                {calcOutput?.scenarios.map((sc) => {
                  const isGain = sc.price_change_dollars > 0
                  const isLoss = sc.price_change_dollars < 0
                  return (
                    <tr key={sc.shift_bps}>
                      <td style={{ fontWeight: 'bold' }}>
                        {sc.shift_bps > 0 ? `+${sc.shift_bps}` : sc.shift_bps} bps
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                        {sc.new_ytm.toFixed(2)}%
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                        ${sc.repriced_bond.toFixed(2)}
                      </td>
                      <td
                        style={{
                          textAlign: 'right',
                          fontFamily: 'var(--font-mono)',
                          color: isGain ? 'var(--positive)' : isLoss ? 'var(--negative)' : 'inherit',
                        }}
                      >
                        {isGain ? '+' : ''}${sc.price_change_dollars.toFixed(2)}
                      </td>
                      <td
                        style={{
                          textAlign: 'right',
                          fontFamily: 'var(--font-mono)',
                          color: isGain ? 'var(--positive)' : isLoss ? 'var(--negative)' : 'inherit',
                          fontWeight: 'bold',
                        }}
                      >
                        {isGain ? '+' : ''}{sc.price_change_pct.toFixed(2)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
    </main>
  )
}
