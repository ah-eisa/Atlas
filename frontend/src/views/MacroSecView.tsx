import { useCallback, useEffect, useMemo, useState } from 'react'
import { Panel, Segmented } from '../components/Panel'
import type { DataConfig } from '../lib/api'
import { getMacroHistory, getMacroSummary, getSecFilings } from '../lib/api'
import type {
  MacroHistoryPoint,
  MacroSummaryResponse,
  PortfolioState,
  SecFilingsResponse,
} from '../lib/types'

interface MacroSecViewProps {
  state: PortfolioState
  config: DataConfig
}

export default function MacroSecView({ state, config }: MacroSecViewProps) {
  // Main view mode: 'macro' or 'sec'
  const [activeTab, setActiveTab] = useState<'macro' | 'sec'>('macro')

  // Macro state
  const [macroSummary, setMacroSummary] = useState<MacroSummaryResponse | null>(null)
  const [selectedSeries, setSelectedSeries] = useState<string>('CPIAUCSL')
  const [macroRange, setMacroRange] = useState<'1Y' | '3Y' | '5Y' | 'MAX'>('5Y')
  const [macroHistory, setMacroHistory] = useState<MacroHistoryPoint[]>([])
  const [macroLoading, setMacroLoading] = useState(false)
  const [hoveredMacroIndex, setHoveredMacroIndex] = useState<number | null>(null)

  // SEC Filings state
  const portfolioTickers = useMemo(() => {
    const list = state.positions.map((p) => p.ticker.toUpperCase())
    return list.length > 0 ? list : ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL']
  }, [state.positions])

  const [selectedTicker, setSelectedTicker] = useState<string>(portfolioTickers[0] || 'AAPL')
  const [customTickerInput, setCustomTickerInput] = useState<string>('')
  const [formFilter, setFormFilter] = useState<'ALL' | '10-K' | '10-Q' | '8-K' | '4'>('ALL')
  const [secResponse, setSecResponse] = useState<SecFilingsResponse | null>(null)
  const [secLoading, setSecLoading] = useState(false)
  const [secError, setSecError] = useState<string | null>(null)

  // Load Macro Summary
  const loadMacroSummary = useCallback(async () => {
    try {
      const summary = await getMacroSummary(config)
      setMacroSummary(summary)
    } catch {
      // Handled gracefully
    }
  }, [config])

  // Load Macro History
  const loadMacroHistory = useCallback(async () => {
    try {
      setMacroLoading(true)
      const data = await getMacroHistory(config, selectedSeries, macroRange)
      setMacroHistory(data)
    } catch {
      setMacroHistory([])
    } finally {
      setMacroLoading(false)
    }
  }, [config, selectedSeries, macroRange])

  // Load SEC Filings
  const loadSecFilings = useCallback(async (ticker: string, form?: string) => {
    try {
      setSecLoading(true)
      setSecError(null)
      const filter = form === 'ALL' ? undefined : form
      const data = await getSecFilings(config, ticker, filter, 40)
      setSecResponse(data)
    } catch (err) {
      setSecError(err instanceof Error ? err.message : 'Failed to load SEC filings')
    } finally {
      setSecLoading(false)
    }
  }, [config])

  useEffect(() => {
    loadMacroSummary()
  }, [loadMacroSummary])

  useEffect(() => {
    loadMacroHistory()
  }, [loadMacroHistory])

  useEffect(() => {
    loadSecFilings(selectedTicker, formFilter)
  }, [selectedTicker, formFilter, loadSecFilings])

  // Current active indicator metadata
  const currentIndicator = useMemo(() => {
    if (!macroSummary) return null
    return macroSummary.indicators.find((ind) => ind.series_id === selectedSeries) || null
  }, [macroSummary, selectedSeries])

  // Macro Chart Geometry Helpers
  const { histMinY, histMaxY, getHistYCoord, getHistXCoord } = useMemo(() => {
    if (macroHistory.length === 0) {
      return { histMinY: 0, histMaxY: 10, getHistYCoord: () => 0, getHistXCoord: () => 0 }
    }
    const vals = macroHistory.map((p) => p.value)
    const minVal = Math.min(...vals)
    const maxVal = Math.max(...vals)
    const span = maxVal - minVal
    const pad = span > 0 ? span * 0.1 : 1
    const minY = Math.floor((minVal - pad) * 10) / 10
    const maxY = Math.ceil((maxVal + pad) * 10) / 10

    const chartW = 740
    const chartH = 240
    const paddingLeft = 50
    const paddingRight = 30
    const paddingTop = 20
    const paddingBottom = 30
    const plotW = chartW - paddingLeft - paddingRight
    const plotH = chartH - paddingTop - paddingBottom

    const count = macroHistory.length
    const getX = (i: number) =>
      count > 1 ? paddingLeft + (i / (count - 1)) * plotW : paddingLeft + plotW / 2
    const getY = (val: number) => {
      const clamped = Math.max(minY, Math.min(maxY, val))
      return paddingTop + (1 - (clamped - minY) / (maxY - minY)) * plotH
    }

    return { histMinY: minY, histMaxY: maxY, getHistYCoord: getY, getHistXCoord: getX }
  }, [macroHistory])

  const buildMacroPath = () => {
    if (macroHistory.length === 0) return ''
    return macroHistory
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getHistXCoord(i).toFixed(1)} ${getHistYCoord(pt.value).toFixed(1)}`)
      .join(' ')
  }

  const buildMacroAreaPath = () => {
    if (macroHistory.length === 0) return ''
    const linePath = buildMacroPath()
    const lastX = getHistXCoord(macroHistory.length - 1)
    const firstX = getHistXCoord(0)
    const baselineY = getHistYCoord(histMinY)
    return `${linePath} L ${lastX.toFixed(1)} ${baselineY.toFixed(1)} L ${firstX.toFixed(1)} ${baselineY.toFixed(1)} Z`
  }

  const handleCustomTickerSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const clean = customTickerInput.trim().toUpperCase()
    if (clean) {
      setSelectedTicker(clean)
      setCustomTickerInput('')
    }
  }

  return (
    <main className="app__main">
      {/* View Header */}
      <div className="view__header">
        <div>
          <h1 className="view__title">Macro & SEC Intelligence</h1>
          <p className="view__subtitle">
            Macroeconomic indicators from FRED and official audited regulatory filings from SEC EDGAR.
          </p>
        </div>

        <div className="view__actions">
          <Segmented
            ariaLabel="Module view switcher"
            options={[
              { value: 'macro', label: 'Macro Indicators' },
              { value: 'sec', label: 'SEC EDGAR Filings' },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />
        </div>
      </div>

      {activeTab === 'macro' ? (
        <>
          {/* Top Macro KPI Strip */}
          <section className="kpi-band kpi-band--wrap" aria-label="Macroeconomic Benchmarks">
            {macroSummary?.indicators.slice(0, 6).map((ind) => (
              <div
                key={ind.series_id}
                className="kpi__cell"
                style={{ cursor: 'pointer', background: selectedSeries === ind.series_id ? 'var(--surface-raised)' : undefined }}
                onClick={() => setSelectedSeries(ind.series_id)}
              >
                <span className="kpi__label">{ind.name}</span>
                <span className="num kpi__value">
                  {ind.latest_value.toFixed(ind.unit === '$T' ? 2 : 1)}
                  {ind.unit}
                </span>
                <span className="kpi__sub">
                  <span
                    className={
                      ind.change > 0
                        ? ind.series_id === 'UNRATE' || ind.series_id === 'CPIAUCSL'
                          ? 'color--negative'
                          : 'color--positive'
                        : ind.change < 0
                        ? ind.series_id === 'UNRATE' || ind.series_id === 'CPIAUCSL'
                          ? 'color--positive'
                          : 'color--negative'
                        : undefined
                    }
                  >
                    {ind.change > 0 ? '+' : ''}
                    {ind.change.toFixed(2)}
                    {ind.unit} ({ind.change_pct > 0 ? '+' : ''}
                    {ind.change_pct.toFixed(1)}%)
                  </span>
                </span>
              </div>
            ))}
          </section>

          {/* Primary Macro Time Series Chart */}
          <Panel
            title={currentIndicator?.name ?? 'Macro Trend'}
            subtitle={currentIndicator ? `Category: ${currentIndicator.category} • As-of ${currentIndicator.observation_date}` : undefined}
            padded
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <select
                  className="field__input"
                  style={{ height: '28px', padding: '0 8px', fontSize: '11px' }}
                  value={selectedSeries}
                  onChange={(e) => setSelectedSeries(e.target.value)}
                >
                  {macroSummary?.indicators.map((ind) => (
                    <option key={ind.series_id} value={ind.series_id}>
                      {ind.name} ({ind.series_id})
                    </option>
                  ))}
                </select>

                <Segmented
                  ariaLabel="Macro history lookback range"
                  options={[
                    { value: '1Y', label: '1Y' },
                    { value: '3Y', label: '3Y' },
                    { value: '5Y', label: '5Y' },
                    { value: 'MAX', label: 'MAX' },
                  ]}
                  value={macroRange}
                  onChange={setMacroRange}
                />
              </div>
            }
          >
            <div style={{ width: '100%', overflowX: 'auto' }}>
              {macroLoading ? (
                <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
                  Loading macroeconomic time series...
                </div>
              ) : macroHistory.length === 0 ? (
                <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
                  No historical data available for selected series.
                </div>
              ) : (
                <svg
                  viewBox="0 0 740 240"
                  style={{ width: '100%', height: 'auto', minWidth: '600px', display: 'block' }}
                  onMouseLeave={() => setHoveredMacroIndex(null)}
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
                          {yVal.toFixed(1)}
                          {currentIndicator?.unit}
                        </text>
                      </g>
                    )
                  })}

                  {/* Gradient Area Fill */}
                  <defs>
                    <linearGradient id="macroAreaGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0f62fe" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="#0f62fe" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  <path d={buildMacroAreaPath()} fill="url(#macroAreaGradient)" />

                  {/* Primary Line */}
                  <path d={buildMacroPath()} fill="none" stroke="#0f62fe" strokeWidth="2.2" />

                  {/* Vertices & Hover Targets */}
                  {macroHistory.map((pt, i) => {
                    const x = getHistXCoord(i)
                    const y = getHistYCoord(pt.value)
                    const isHovered = hoveredMacroIndex === i
                    return (
                      <g
                        key={`pt-${pt.date}`}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={() => setHoveredMacroIndex(i)}
                      >
                        <circle cx={x} cy={y} r="10" fill="transparent" />
                        <circle
                          cx={x}
                          cy={y}
                          r={isHovered ? 5 : 2.5}
                          fill="#0f62fe"
                          stroke="var(--surface-panel)"
                          strokeWidth="1.5"
                        />
                      </g>
                    )
                  })}

                  {/* Hover Tooltip */}
                  {hoveredMacroIndex !== null && macroHistory[hoveredMacroIndex] && (
                    (() => {
                      const idx = hoveredMacroIndex
                      const pt = macroHistory[idx]
                      const x = getHistXCoord(idx)
                      const y = getHistYCoord(pt.value)

                      const boxW = 120
                      const boxH = 50
                      const boxX = x > 600 ? x - boxW - 10 : x + 10
                      const boxY = Math.max(15, Math.min(160, y - boxH / 2))

                      return (
                        <g pointerEvents="none">
                          <line
                            x1={x}
                            y1="20"
                            x2={x}
                            y2="210"
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
                            rx="3"
                          />
                          <text
                            x={boxX + 10}
                            y={boxY + 18}
                            fill="var(--text-tertiary)"
                            fontSize="10"
                            fontFamily="var(--font-mono)"
                          >
                            {pt.date}
                          </text>
                          <text
                            x={boxX + 10}
                            y={boxY + 36}
                            fill="#0f62fe"
                            fontSize="12"
                            fontWeight="bold"
                            fontFamily="var(--font-mono)"
                          >
                            {pt.value.toFixed(2)} {currentIndicator?.unit}
                          </text>
                        </g>
                      )
                    })()
                  )}

                  {/* X Axis Dates */}
                  {macroHistory.length > 0 && (
                    <>
                      <text
                        x="50"
                        y="225"
                        fill="var(--text-tertiary)"
                        fontSize="10"
                        fontFamily="var(--font-mono)"
                      >
                        {macroHistory[0].date}
                      </text>
                      <text
                        x="710"
                        y="225"
                        fill="var(--text-tertiary)"
                        fontSize="10"
                        fontFamily="var(--font-mono)"
                        textAnchor="end"
                      >
                        {macroHistory[macroHistory.length - 1].date}
                      </text>
                    </>
                  )}
                </svg>
              )}
            </div>
          </Panel>

          {/* Macro Indicators Monitor Table */}
          <Panel
            title="Macroeconomic Indicators Roster"
            subtitle="Authoritative macroeconomic series monitored across monetary, price, and labor trends"
            padded
          >
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Indicator</th>
                    <th style={{ textAlign: 'left' }}>Category</th>
                    <th style={{ textAlign: 'right' }}>Latest Print</th>
                    <th style={{ textAlign: 'right' }}>Previous</th>
                    <th style={{ textAlign: 'right' }}>Change</th>
                    <th style={{ textAlign: 'right' }}>Observation Date</th>
                    <th style={{ textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {macroSummary?.indicators.map((ind) => {
                    const isSelected = selectedSeries === ind.series_id
                    return (
                      <tr
                        key={ind.series_id}
                        style={{
                          background: isSelected ? 'rgba(15, 98, 254, 0.08)' : undefined,
                        }}
                      >
                        <td style={{ fontWeight: 'bold' }}>
                          {ind.name}
                          <span style={{ marginLeft: '8px', color: 'var(--text-tertiary)', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                            [{ind.series_id}]
                          </span>
                        </td>
                        <td style={{ color: 'var(--text-secondary)' }}>{ind.category}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 'bold' }}>
                          {ind.latest_value.toFixed(ind.unit === '$T' ? 2 : 1)} {ind.unit}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                          {ind.previous_value.toFixed(ind.unit === '$T' ? 2 : 1)} {ind.unit}
                        </td>
                        <td
                          style={{
                            textAlign: 'right',
                            fontFamily: 'var(--font-mono)',
                            color: ind.change > 0 ? 'var(--positive)' : ind.change < 0 ? 'var(--negative)' : 'inherit',
                          }}
                        >
                          {ind.change > 0 ? '+' : ''}
                          {ind.change.toFixed(2)} ({ind.change_pct > 0 ? '+' : ''}
                          {ind.change_pct.toFixed(1)}%)
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                          {ind.observation_date}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            className="button button--quiet button--sm"
                            onClick={() => setSelectedSeries(ind.series_id)}
                          >
                            Chart
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : (
        <>
          {/* Tab B: SEC EDGAR Regulatory Filings */}
          {secError && (
            <div className="banner banner--error">
              <span className="banner__label">SEC Error</span>
              <span className="banner__message">{secError}</span>
            </div>
          )}

          {/* SEC Controls Panel */}
          <Panel
            title="SEC EDGAR Company Filings"
            subtitle={
              secResponse
                ? `${secResponse.company_name} (CIK: ${secResponse.cik}) • ${secResponse.filings.length} filings available`
                : 'Select or enter ticker symbol'
            }
            padded
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Segmented
                  ariaLabel="Form filter"
                  options={[
                    { value: 'ALL', label: 'All Forms' },
                    { value: '10-K', label: '10-K (Annual)' },
                    { value: '10-Q', label: '10-Q (Quarterly)' },
                    { value: '8-K', label: '8-K (Events)' },
                    { value: '4', label: 'Form 4 (Insider)' },
                  ]}
                  value={formFilter}
                  onChange={setFormFilter}
                />
              </div>
            }
          >
            {/* Portfolio Holdings Fast Switcher */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--size-caption)', color: 'var(--text-tertiary)' }}>Holdings:</span>
                {portfolioTickers.slice(0, 8).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`button button--sm ${selectedTicker === t ? 'button--selected' : 'button--quiet'}`}
                    onClick={() => setSelectedTicker(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Custom Ticker Search */}
              <form onSubmit={handleCustomTickerSubmit} style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <input
                  type="text"
                  placeholder="Enter Ticker (e.g. NVDA)..."
                  value={customTickerInput}
                  onChange={(e) => setCustomTickerInput(e.target.value)}
                  style={{
                    height: '28px',
                    padding: '0 8px',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--surface-raised)',
                    border: '1px solid var(--line)',
                    color: 'var(--text-primary)',
                    borderRadius: '2px',
                    width: '160px',
                  }}
                />
                <button type="submit" className="button button--quiet button--sm">
                  Search
                </button>
              </form>
            </div>

            {/* Filings Table */}
            {secLoading ? (
              <div style={{ height: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
                Fetching audited regulatory filings from SEC EDGAR...
              </div>
            ) : secResponse?.filings.length === 0 ? (
              <div style={{ height: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
                No filings found for form filter {formFilter}.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Form</th>
                      <th style={{ textAlign: 'left' }}>Filing Date</th>
                      <th style={{ textAlign: 'left' }}>Report Period</th>
                      <th style={{ textAlign: 'left' }}>Description / Subject</th>
                      <th style={{ textAlign: 'left' }}>Accession #</th>
                      <th style={{ textAlign: 'center' }}>Interactive Data</th>
                      <th style={{ textAlign: 'right' }}>Official Filing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {secResponse?.filings.map((f) => {
                      const is10K = f.form === '10-K'
                      const is10Q = f.form === '10-Q'
                      const is8K = f.form === '8-K'
                      const isForm4 = f.form === '4'

                      const formClass = is10K
                        ? 'trade-pill--buy'
                        : is10Q
                        ? 'badge--info'
                        : is8K
                        ? 'badge--warning'
                        : isForm4
                        ? 'badge--neutral'
                        : ''

                      return (
                        <tr key={f.accession_number || f.url}>
                          <td>
                            <span
                              className={`badge ${formClass}`}
                              style={{
                                padding: '2px 8px',
                                borderRadius: '2px',
                                fontWeight: 'bold',
                                fontFamily: 'var(--font-mono)',
                                fontSize: '11px',
                              }}
                            >
                              {f.form}
                            </span>
                          </td>
                          <td style={{ fontFamily: 'var(--font-mono)' }}>{f.filing_date}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                            {f.report_date || '—'}
                          </td>
                          <td style={{ maxWidth: '300px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {f.description}
                          </td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                            {f.accession_number}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {f.is_xbrl ? (
                              <span style={{ fontSize: '10px', color: 'var(--positive)', fontWeight: 'bold' }}>
                                ✓ XBRL
                              </span>
                            ) : (
                              <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>HTML</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <a
                              href={f.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="button button--quiet button--sm"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                            >
                              Open SEC Doc ↗
                            </a>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </main>
  )
}
