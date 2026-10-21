import { useCallback, useEffect, useMemo, useState } from 'react'
import { Panel, Segmented } from '../components/Panel'
import type { DataConfig } from '../lib/api'
import { calculateOption, getOptionChain } from '../lib/api'
import type {
  BlackScholesInput,
  BlackScholesOutput,
  OptionChainResponse,
  OptionContract,
  PortfolioState,
} from '../lib/types'

interface OptionsViewProps {
  state: PortfolioState
  config: DataConfig
}

export default function OptionsView({ state, config }: OptionsViewProps) {
  const [activeTab, setActiveTab] = useState<'chain' | 'calculator'>('chain')

  // Holdings ticker options
  const portfolioTickers = useMemo(() => {
    const list = state.positions.map((p) => p.ticker.toUpperCase())
    return list.length > 0 ? list : ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ']
  }, [state.positions])

  const [selectedTicker, setSelectedTicker] = useState<string>(portfolioTickers[0] || 'AAPL')
  const [customTicker, setCustomTicker] = useState<string>('')
  const [selectedExpiry, setSelectedExpiry] = useState<string | undefined>()
  const [chainData, setChainData] = useState<OptionChainResponse | null>(null)
  const [chainLoading, setChainLoading] = useState(false)
  const [chainError, setChainError] = useState<string | null>(null)

  // Black-Scholes Lab State
  const [bsInputs, setBsInputs] = useState<BlackScholesInput>({
    underlying_price: 180.0,
    strike_price: 180.0,
    dte: 45.0,
    volatility_pct: 28.0,
    risk_free_rate_pct: 4.5,
    dividend_yield_pct: 0.5,
  })
  const [bsOutput, setBsOutput] = useState<BlackScholesOutput | null>(null)

  // Load option chain
  const loadChain = useCallback(
    async (ticker: string, expiry?: string) => {
      try {
        setChainLoading(true)
        setChainError(null)
        const data = await getOptionChain(config, ticker, expiry)
        setChainData(data)
        if (!selectedExpiry && data.selected_expiration) {
          setSelectedExpiry(data.selected_expiration)
        }
      } catch (err) {
        setChainError(err instanceof Error ? err.message : 'Failed to load options chain')
      } finally {
        setChainLoading(false)
      }
    },
    [config, selectedExpiry],
  )

  useEffect(() => {
    loadChain(selectedTicker, selectedExpiry)
  }, [selectedTicker, selectedExpiry, loadChain])

  // Run Black-Scholes calculation
  useEffect(() => {
    let cancelled = false
    calculateOption(config, bsInputs).then((res) => {
      if (!cancelled) setBsOutput(res)
    })
    return () => {
      cancelled = true
    }
  }, [config, bsInputs])

  // Custom ticker search
  const handleCustomTicker = (e: React.FormEvent) => {
    e.preventDefault()
    const clean = customTicker.trim().toUpperCase()
    if (clean) {
      setSelectedTicker(clean)
      setSelectedExpiry(undefined)
      setCustomTicker('')
    }
  }

  // Group options by strike
  const strikesMap = useMemo(() => {
    if (!chainData) return new Map<number, { call?: OptionContract; put?: OptionContract }>()
    const map = new Map<number, { call?: OptionContract; put?: OptionContract }>()
    for (const c of chainData.calls) {
      map.set(c.strike, { ...map.get(c.strike), call: c })
    }
    for (const p of chainData.puts) {
      map.set(p.strike, { ...map.get(p.strike), put: p })
    }
    return map
  }, [chainData])

  const sortedStrikes = useMemo(() => {
    return [...strikesMap.keys()].sort((a, b) => a - b)
  }, [strikesMap])

  // Payoff Chart Geometry
  const { payoffMinY, payoffMaxY, getPayoffY, getPayoffX } = useMemo(() => {
    if (!bsOutput || bsOutput.payoff_curve.length === 0) {
      return { payoffMinY: -20, payoffMaxY: 20, getPayoffY: () => 0, getPayoffX: () => 0 }
    }
    const pts = bsOutput.payoff_curve
    const allPnl = [...pts.map((p) => p.call_payoff), ...pts.map((p) => p.put_payoff)]
    const minY = Math.floor(Math.min(...allPnl) - 2)
    const maxY = Math.ceil(Math.max(...allPnl) + 2)

    const chartW = 740
    const chartH = 220
    const paddingLeft = 50
    const paddingRight = 30
    const paddingTop = 20
    const paddingBottom = 30
    const plotW = chartW - paddingLeft - paddingRight
    const plotH = chartH - paddingTop - paddingBottom

    const count = pts.length
    const getX = (i: number) =>
      count > 1 ? paddingLeft + (i / (count - 1)) * plotW : paddingLeft + plotW / 2
    const getY = (val: number) => {
      const clamped = Math.max(minY, Math.min(maxY, val))
      return paddingTop + (1 - (clamped - minY) / (maxY - minY)) * plotH
    }

    return { payoffMinY: minY, payoffMaxY: maxY, getPayoffY: getY, getPayoffX: getX }
  }, [bsOutput])

  const buildPayoffPath = (field: 'call_payoff' | 'put_payoff') => {
    if (!bsOutput || bsOutput.payoff_curve.length === 0) return ''
    return bsOutput.payoff_curve
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getPayoffX(i).toFixed(1)} ${getPayoffY(pt[field]).toFixed(1)}`)
      .join(' ')
  }

  return (
    <main className="app__main">
      {/* Header */}
      <div className="view__header">
        <div>
          <h1 className="view__title">Options Derivatives & Greeks</h1>
          <p className="view__subtitle">
            Live options chain matrix, Black-Scholes pricing model, Greeks sensitivity laboratory, and payoff curves.
          </p>
        </div>

        <div className="view__actions">
          <Segmented
            ariaLabel="Options view switcher"
            options={[
              { value: 'chain', label: 'Option Chain Matrix' },
              { value: 'calculator', label: 'Black-Scholes & Greeks Lab' },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />
        </div>
      </div>

      {activeTab === 'chain' ? (
        <>
          {chainError && (
            <div className="banner banner--error">
              <span className="banner__label">Options Error</span>
              <span className="banner__message">{chainError}</span>
            </div>
          )}

          {/* Option Chain Control Bar */}
          <Panel
            title={`${selectedTicker} Options Chain`}
            subtitle={
              chainData
                ? `Underlying: $${chainData.underlying_price.toFixed(2)} • Expiration: ${chainData.selected_expiration} (${sortedStrikes.length} strikes)`
                : undefined
            }
            padded
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                {chainData?.expirations && chainData.expirations.length > 0 && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>Expiry:</span>
                    <select
                      className="field__input"
                      style={{ height: '28px', padding: '0 8px', fontSize: '11px' }}
                      value={selectedExpiry ?? chainData.selected_expiration}
                      onChange={(e) => setSelectedExpiry(e.target.value)}
                    >
                      {chainData.expirations.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <button
                  type="button"
                  className="button button--quiet button--sm"
                  onClick={() => loadChain(selectedTicker, selectedExpiry)}
                  disabled={chainLoading}
                >
                  {chainLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            }
          >
            {/* Holdings Selector and Search */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-3)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--size-caption)', color: 'var(--text-tertiary)' }}>Holdings:</span>
                {portfolioTickers.slice(0, 8).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`button button--sm ${selectedTicker === t ? 'button--selected' : 'button--quiet'}`}
                    onClick={() => {
                      setSelectedTicker(t)
                      setSelectedExpiry(undefined)
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <form onSubmit={handleCustomTicker} style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <input
                  type="text"
                  placeholder="Ticker (e.g. SPY)..."
                  value={customTicker}
                  onChange={(e) => setCustomTicker(e.target.value)}
                  style={{
                    height: '28px',
                    padding: '0 8px',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--surface-raised)',
                    border: '1px solid var(--line)',
                    color: 'var(--text-primary)',
                    borderRadius: '2px',
                    width: '140px',
                  }}
                />
                <button type="submit" className="button button--quiet button--sm">
                  Load
                </button>
              </form>
            </div>

            {/* Matrix Table */}
            {chainLoading ? (
              <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
                Loading options chain for {selectedTicker}...
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ width: '100%', fontSize: '11px' }}>
                  <thead>
                    <tr>
                      <th colSpan={6} style={{ textAlign: 'center', background: 'rgba(66, 190, 101, 0.08)', color: 'var(--positive)' }}>
                        CALLS
                      </th>
                      <th style={{ textAlign: 'center', background: 'var(--surface-raised)', color: 'var(--text-primary)' }}>
                        STRIKE
                      </th>
                      <th colSpan={6} style={{ textAlign: 'center', background: 'rgba(250, 77, 86, 0.08)', color: 'var(--negative)' }}>
                        PUTS
                      </th>
                    </tr>
                    <tr>
                      {/* Calls columns */}
                      <th style={{ textAlign: 'right' }}>Last</th>
                      <th style={{ textAlign: 'right' }}>Bid</th>
                      <th style={{ textAlign: 'right' }}>Ask</th>
                      <th style={{ textAlign: 'right' }}>Vol</th>
                      <th style={{ textAlign: 'right' }}>OI</th>
                      <th style={{ textAlign: 'right' }}>IV</th>
                      {/* Strike */}
                      <th style={{ textAlign: 'center', background: 'var(--surface-raised)' }}>$</th>
                      {/* Puts columns */}
                      <th style={{ textAlign: 'right' }}>IV</th>
                      <th style={{ textAlign: 'right' }}>OI</th>
                      <th style={{ textAlign: 'right' }}>Vol</th>
                      <th style={{ textAlign: 'right' }}>Bid</th>
                      <th style={{ textAlign: 'right' }}>Ask</th>
                      <th style={{ textAlign: 'right' }}>Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStrikes.map((strike) => {
                      const { call, put } = strikesMap.get(strike) || {}
                      const callItm = call?.in_the_money
                      const putItm = put?.in_the_money

                      return (
                        <tr key={strike}>
                          {/* Call Columns */}
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: callItm ? 'rgba(66, 190, 101, 0.08)' : undefined }}>
                            {call?.last_price != null ? `$${call.last_price.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: callItm ? 'rgba(66, 190, 101, 0.08)' : undefined }}>
                            {call?.bid != null ? `$${call.bid.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: callItm ? 'rgba(66, 190, 101, 0.08)' : undefined }}>
                            {call?.ask != null ? `$${call.ask.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', background: callItm ? 'rgba(66, 190, 101, 0.08)' : undefined }}>
                            {call?.volume ? call.volume.toLocaleString() : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', background: callItm ? 'rgba(66, 190, 101, 0.08)' : undefined }}>
                            {call?.open_interest ? call.open_interest.toLocaleString() : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: '#0f62fe', background: callItm ? 'rgba(66, 190, 101, 0.08)' : undefined }}>
                            {call?.implied_volatility != null ? `${(call.implied_volatility * 100).toFixed(0)}%` : '—'}
                          </td>

                          {/* Strike Center Column */}
                          <td style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 'bold', background: 'var(--surface-raised)', color: '#f1c21b' }}>
                            ${strike.toFixed(2)}
                          </td>

                          {/* Put Columns */}
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: '#0f62fe', background: putItm ? 'rgba(250, 77, 86, 0.08)' : undefined }}>
                            {put?.implied_volatility != null ? `${(put.implied_volatility * 100).toFixed(0)}%` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', background: putItm ? 'rgba(250, 77, 86, 0.08)' : undefined }}>
                            {put?.open_interest ? put.open_interest.toLocaleString() : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', background: putItm ? 'rgba(250, 77, 86, 0.08)' : undefined }}>
                            {put?.volume ? put.volume.toLocaleString() : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: putItm ? 'rgba(250, 77, 86, 0.08)' : undefined }}>
                            {put?.bid != null ? `$${put.bid.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: putItm ? 'rgba(250, 77, 86, 0.08)' : undefined }}>
                            {put?.ask != null ? `$${put.ask.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: putItm ? 'rgba(250, 77, 86, 0.08)' : undefined }}>
                            {put?.last_price != null ? `$${put.last_price.toFixed(2)}` : '—'}
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
      ) : (
        <>
          {/* Black-Scholes Lab Mode */}
          <Panel
            title="Black-Scholes Theoretical Pricing & The Greeks Lab"
            subtitle="Analytical closed-form European option evaluation, full first and second-order Greeks, and expiration payoff profiles"
            padded
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--space-4)' }}>
              {/* Inputs */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <div style={{ fontSize: 'var(--size-caption)', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}>
                  Option Parameters
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <label className="field">
                    <span className="field__label">Underlying Price ($S)</span>
                    <input
                      type="number"
                      className="field__input"
                      value={bsInputs.underlying_price}
                      step="1"
                      onChange={(e) =>
                        setBsInputs({ ...bsInputs, underlying_price: Math.max(0.1, Number(e.target.value) || 1) })
                      }
                    />
                  </label>

                  <label className="field">
                    <span className="field__label">Strike Price ($K)</span>
                    <input
                      type="number"
                      className="field__input"
                      value={bsInputs.strike_price}
                      step="1"
                      onChange={(e) =>
                        setBsInputs({ ...bsInputs, strike_price: Math.max(0.1, Number(e.target.value) || 1) })
                      }
                    />
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <label className="field">
                    <span className="field__label">Days to Expiration (DTE)</span>
                    <input
                      type="number"
                      className="field__input"
                      value={bsInputs.dte}
                      step="1"
                      onChange={(e) =>
                        setBsInputs({ ...bsInputs, dte: Math.max(1, Number(e.target.value) || 1) })
                      }
                    />
                  </label>

                  <label className="field">
                    <span className="field__label">Implied Volatility (IV %)</span>
                    <input
                      type="number"
                      className="field__input"
                      value={bsInputs.volatility_pct}
                      step="1"
                      onChange={(e) =>
                        setBsInputs({ ...bsInputs, volatility_pct: Math.max(1, Number(e.target.value) || 1) })
                      }
                    />
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <label className="field">
                    <span className="field__label">Risk-Free Rate (% r)</span>
                    <input
                      type="number"
                      className="field__input"
                      value={bsInputs.risk_free_rate_pct}
                      step="0.1"
                      onChange={(e) =>
                        setBsInputs({ ...bsInputs, risk_free_rate_pct: Number(e.target.value) || 0 })
                      }
                    />
                  </label>

                  <label className="field">
                    <span className="field__label">Dividend Yield (% q)</span>
                    <input
                      type="number"
                      className="field__input"
                      value={bsInputs.dividend_yield_pct}
                      step="0.1"
                      onChange={(e) =>
                        setBsInputs({ ...bsInputs, dividend_yield_pct: Number(e.target.value) || 0 })
                      }
                    />
                  </label>
                </div>
              </div>

              {/* Price Cards */}
              <div>
                <div style={{ fontSize: 'var(--size-caption)', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px', marginBottom: 'var(--space-3)' }}>
                  Theoretical Fair Value
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  {/* Call Card */}
                  <div className="card kpi" style={{ padding: 'var(--space-3)' }}>
                    <span className="kpi__label" style={{ color: 'var(--positive)' }}>CALL OPTION</span>
                    <span className="kpi__value">${bsOutput ? bsOutput.call_price.toFixed(2) : '—'}</span>
                    <span className="kpi__caption">
                      Intrinsic: ${bsOutput?.call_intrinsic.toFixed(2)} • Time: ${bsOutput?.call_time_value.toFixed(2)}
                    </span>
                  </div>

                  {/* Put Card */}
                  <div className="card kpi" style={{ padding: 'var(--space-3)' }}>
                    <span className="kpi__label" style={{ color: 'var(--negative)' }}>PUT OPTION</span>
                    <span className="kpi__value">${bsOutput ? bsOutput.put_price.toFixed(2) : '—'}</span>
                    <span className="kpi__caption">
                      Intrinsic: ${bsOutput?.put_intrinsic.toFixed(2)} • Time: ${bsOutput?.put_time_value.toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Greeks Grid */}
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <div style={{ fontSize: 'var(--size-caption)', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px', marginBottom: 'var(--space-2)' }}>
                    The Greeks Sensitivities
                  </div>

                  <table className="table" style={{ width: '100%', fontSize: '11px' }}>
                    <thead>
                      <tr>
                        <th>Greek</th>
                        <th style={{ textAlign: 'right' }}>Call</th>
                        <th style={{ textAlign: 'right' }}>Put</th>
                        <th style={{ textAlign: 'left' }}>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={{ fontWeight: 'bold' }}>Delta (Δ)</td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--positive)', fontWeight: 'bold' }}>
                          {bsOutput ? `+${bsOutput.call_greeks.delta.toFixed(3)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--negative)', fontWeight: 'bold' }}>
                          {bsOutput ? bsOutput.put_greeks.delta.toFixed(3) : '—'}
                        </td>
                        <td style={{ color: 'var(--text-tertiary)' }}>Price sensitivity per $1 underlying shift</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 'bold' }}>Gamma (Γ)</td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                          {bsOutput ? bsOutput.call_greeks.gamma.toFixed(4) : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                          {bsOutput ? bsOutput.put_greeks.gamma.toFixed(4) : '—'}
                        </td>
                        <td style={{ color: 'var(--text-tertiary)' }}>Rate of change in Delta per $1 shift</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 'bold' }}>Vega (ν)</td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: '#0f62fe' }}>
                          {bsOutput ? `+$${bsOutput.call_greeks.vega.toFixed(3)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: '#0f62fe' }}>
                          {bsOutput ? `+$${bsOutput.put_greeks.vega.toFixed(3)}` : '—'}
                        </td>
                        <td style={{ color: 'var(--text-tertiary)' }}>Sensitivity per 1% change in volatility</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 'bold' }}>Theta (Θ)</td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--negative)' }}>
                          {bsOutput ? `$${bsOutput.call_greeks.theta.toFixed(3)}/day` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--negative)' }}>
                          {bsOutput ? `$${bsOutput.put_greeks.theta.toFixed(3)}/day` : '—'}
                        </td>
                        <td style={{ color: 'var(--text-tertiary)' }}>Time decay loss per calendar day</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 'bold' }}>Rho (ρ)</td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                          {bsOutput ? `+$${bsOutput.call_greeks.rho.toFixed(3)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                          {bsOutput ? `-$${Math.abs(bsOutput.put_greeks.rho).toFixed(3)}` : '—'}
                        </td>
                        <td style={{ color: 'var(--text-tertiary)' }}>Sensitivity per 1% change in interest rates</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Expiration Payoff SVG Graph */}
            <div style={{ marginTop: 'var(--space-4)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
                <span style={{ fontSize: 'var(--size-caption)', textTransform: 'uppercase', color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}>
                  Expiration Profit & Loss (P&L) Payoff Profile
                </span>
                <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: '11px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ width: '12px', height: '3px', background: 'var(--positive)' }} /> Long Call P&L
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ width: '12px', height: '3px', background: 'var(--negative)' }} /> Long Put P&L
                  </span>
                </div>
              </div>

              <div style={{ width: '100%', overflowX: 'auto' }}>
                <svg
                  viewBox="0 0 740 220"
                  style={{ width: '100%', height: 'auto', minWidth: '600px', display: 'block' }}
                >
                  {/* Grid Lines */}
                  {[...Array(5)].map((_, i) => {
                    const yVal = payoffMinY + (i / 4) * (payoffMaxY - payoffMinY)
                    const y = getPayoffY(yVal)
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
                          ${yVal.toFixed(0)}
                        </text>
                      </g>
                    )
                  })}

                  {/* Zero P&L Line */}
                  <line
                    x1="50"
                    y1={getPayoffY(0)}
                    x2="710"
                    y2={getPayoffY(0)}
                    stroke="var(--line-strong)"
                    strokeWidth="1.5"
                  />
                  <text
                    x="715"
                    y={getPayoffY(0) + 4}
                    fill="var(--text-tertiary)"
                    fontSize="10"
                    fontFamily="var(--font-mono)"
                  >
                    $0 P&L
                  </text>

                  {/* Strike Price Vertical Line */}
                  <line
                    x1={getPayoffX(12)}
                    y1="20"
                    x2={getPayoffX(12)}
                    y2="190"
                    stroke="#f1c21b"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={getPayoffX(12)}
                    y="15"
                    fill="#f1c21b"
                    fontSize="10"
                    fontFamily="var(--font-mono)"
                    textAnchor="middle"
                  >
                    Strike ${bsInputs.strike_price.toFixed(0)}
                  </text>

                  {/* Call Payoff Line (Green) */}
                  <path d={buildPayoffPath('call_payoff')} fill="none" stroke="var(--positive)" strokeWidth="2.5" />

                  {/* Put Payoff Line (Red) */}
                  <path d={buildPayoffPath('put_payoff')} fill="none" stroke="var(--negative)" strokeWidth="2.5" />

                  {/* X Axis Labels */}
                  {bsOutput?.payoff_curve && bsOutput.payoff_curve.length > 0 && (
                    <>
                      <text
                        x="50"
                        y="205"
                        fill="var(--text-tertiary)"
                        fontSize="10"
                        fontFamily="var(--font-mono)"
                      >
                        ${bsOutput.payoff_curve[0].underlying_price.toFixed(0)}
                      </text>
                      <text
                        x="710"
                        y="205"
                        fill="var(--text-tertiary)"
                        fontSize="10"
                        fontFamily="var(--font-mono)"
                        textAnchor="end"
                      >
                        ${bsOutput.payoff_curve[bsOutput.payoff_curve.length - 1].underlying_price.toFixed(0)}
                      </text>
                    </>
                  )}
                </svg>
              </div>
            </div>
          </Panel>
        </>
      )}
    </main>
  )
}
