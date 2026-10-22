import { useCallback, useEffect, useState } from 'react'
import { Panel, Segmented } from '../components/Panel'
import {
  type DataConfig,
  getAttributionReport,
  getPortfolioXRay,
  getStressReport,
  runCustomStress,
} from '../lib/api'
import { consumePendingIntent, subscribeCommandIntent } from '../lib/commandBus'
import {
  formatMoney,
  formatPercent,
  formatPercentSigned,
  formatRatio,
  signClass,
} from '../lib/format'
import type {
  AttributionGroupBy,
  AttributionPeriod,
  AttributionReport,
  StressReport,
  StressShock,
  XRayReport,
} from '../lib/types'

interface LabViewProps {
  config: DataConfig
  portfolioId: number
  baseCurrency: string
}

type LabTab = 'xray' | 'stress' | 'attribution'

export function LabView({ config, portfolioId, baseCurrency }: LabViewProps) {
  const [activeTab, setActiveTab] = useState<LabTab>('xray')

  // X-Ray state
  const [xray, setXray] = useState<XRayReport | null>(null)
  const [xrayLoading, setXrayLoading] = useState(false)

  // Stress state
  const [stress, setStress] = useState<StressReport | null>(null)
  const [selectedScenarioKey, setSelectedScenarioKey] = useState<string>('gfc_2008')
  const [stressLoading, setStressLoading] = useState(false)
  const [customShock, setCustomShock] = useState<StressShock>({
    equity_pct: -0.15,
    rates_bps: 75,
    usd_pct: 0.05,
    gold_pct: 0.02,
    crypto_pct: -0.25,
  })

  // Attribution state
  const [attrPeriod, setAttrPeriod] = useState<AttributionPeriod>('all')
  const [attrGroupBy, setAttrGroupBy] = useState<AttributionGroupBy>('asset_class')
  const [attribution, setAttribution] = useState<AttributionReport | null>(null)
  const [attrLoading, setAttrLoading] = useState(false)

  const loadXray = useCallback(async () => {
    setXrayLoading(true)
    try {
      const data = await getPortfolioXRay(config, portfolioId)
      setXray(data)
    } finally {
      setXrayLoading(false)
    }
  }, [config, portfolioId])

  const loadStress = useCallback(async () => {
    setStressLoading(true)
    try {
      const data = await getStressReport(config, portfolioId)
      setStress(data)
      if (data.results.length > 0) {
        setSelectedScenarioKey((prev) =>
          data.results.some((r) => r.key === prev) ? prev : data.results[0].key,
        )
      }
    } finally {
      setStressLoading(false)
    }
  }, [config, portfolioId])

  const loadAttribution = useCallback(async () => {
    setAttrLoading(true)
    try {
      const data = await getAttributionReport(config, attrPeriod, attrGroupBy, portfolioId)
      setAttribution(data)
    } finally {
      setAttrLoading(false)
    }
  }, [config, portfolioId, attrPeriod, attrGroupBy])

  useEffect(() => {
    const initial = consumePendingIntent('xray')
    if (initial) {
      if (initial.tab === 'xray' || initial.tab === 'stress' || initial.tab === 'attribution') {
        setActiveTab(initial.tab)
      }
      if (initial.scenarioKey) {
        setSelectedScenarioKey(initial.scenarioKey)
      }
    }
    return subscribeCommandIntent('xray', (intent) => {
      if (intent.tab === 'xray' || intent.tab === 'stress' || intent.tab === 'attribution') {
        setActiveTab(intent.tab)
      }
      if (intent.scenarioKey) {
        setSelectedScenarioKey(intent.scenarioKey)
      }
    })
  }, [])

  useEffect(() => {
    void loadXray()
    void loadStress()
  }, [loadXray, loadStress])

  useEffect(() => {
    void loadAttribution()
  }, [loadAttribution])

  const handleRunCustomShock = async () => {
    setStressLoading(true)
    try {
      const data = await runCustomStress(config, customShock, portfolioId)
      setStress(data)
      setSelectedScenarioKey('custom')
    } finally {
      setStressLoading(false)
    }
  }

  const activeScenario =
    stress?.results.find((r) => r.key === selectedScenarioKey) ?? stress?.results[0] ?? null

  return (
    <main className="app__main">
      <div className="view-stack">
        <Panel
          title="Institutional Portfolio Lab"
          subtitle="Portfolio X-Ray diagnostics, multi-factor crisis stress testing, and Brinson-Fachler performance attribution"
          padded
          actions={
            <Segmented<LabTab>
              ariaLabel="Portfolio Lab module"
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { value: 'xray', label: '1. Portfolio X-Ray' },
                { value: 'stress', label: '2. Stress Lab' },
                { value: 'attribution', label: '3. Attribution Engine' },
              ]}
            />
          }
        >
          {activeTab === 'xray' && xray && (
            <div className="view-stack" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="kpi">
                <div className="kpi__cell">
                  <div className="kpi__label">Effective Holdings</div>
                  <div className="kpi__value num">
                    {formatRatio(xray.headline.effective_holdings)}
                  </div>
                  <div className="kpi__sub">1 / Herfindahl ({xray.positions} positions)</div>
                </div>
                <div className="kpi__cell">
                  <div className="kpi__label">Herfindahl Index (HHI)</div>
                  <div className="kpi__value num">
                    {xray.headline.herfindahl.toFixed(4)}
                  </div>
                  <div className="kpi__sub">Concentration index (0–1)</div>
                </div>
                <div className="kpi__cell">
                  <div className="kpi__label">Largest Position</div>
                  <div className="kpi__value num">
                    {formatPercent(xray.headline.largest_pct)}
                  </div>
                  <div className="kpi__sub">
                    Top-5 share: {formatPercent(xray.headline.top_five_pct)}
                  </div>
                </div>
                <div className="kpi__cell">
                  <div className="kpi__label">Diversification Ratio</div>
                  <div className="kpi__value num">
                    {xray.headline.diversification_ratio !== null
                      ? `${formatRatio(xray.headline.diversification_ratio)}x`
                      : '—'}
                  </div>
                  <div className="kpi__sub">Weighted asset vol / Portfolio vol</div>
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                  gap: '1rem',
                }}
              >
                <Panel
                  title="Automated X-Ray Diagnostic Alerts"
                  subtitle="Concentration, hidden correlation clusters, and volatility risk hogs"
                  padded
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    {xray.findings.map((finding, idx) => (
                      <div
                        key={`${finding.code}-${idx}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.75rem',
                          padding: '0.75rem 0.9rem',
                          border: '1px solid var(--border-subtle)',
                          borderLeft: `3px solid ${
                            finding.severity === 'high'
                              ? 'var(--negative)'
                              : finding.severity === 'medium'
                                ? '#d29922'
                                : 'var(--positive)'
                          }`,
                          background: 'var(--bg-elevated)',
                        }}
                      >
                        <span
                          className="num"
                          style={{
                            fontSize: '0.72rem',
                            textTransform: 'uppercase',
                            padding: '0.15rem 0.45rem',
                            fontWeight: 600,
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-subtle)',
                          }}
                        >
                          {finding.severity}
                        </span>
                        <span style={{ fontSize: '0.88rem' }}>{finding.message}</span>
                      </div>
                    ))}
                  </div>
                </Panel>

                <Panel
                  title="Correlation Overlap Clusters"
                  subtitle={`Positions moving together with daily return correlation ≥ ${formatRatio(xray.overlap.threshold)}`}
                  padded
                >
                  {xray.overlap.clusters.length === 0 ? (
                    <p className="muted">
                      No high-correlation overlap clusters detected above threshold.
                    </p>
                  ) : (
                    <div className="grid__scroll">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Cluster Constituents</th>
                            <th className="num">Combined Weight</th>
                          </tr>
                        </thead>
                        <tbody>
                          {xray.overlap.clusters.map((cluster, i) => (
                            <tr key={i}>
                              <td className="num">{cluster.tickers.join(' + ')}</td>
                              <td className="num">{formatPercent(cluster.combined_weight)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                  gap: '1rem',
                }}
              >
                <Panel
                  title="Risk Contribution vs. Capital Weight"
                  subtitle="Identifies 'Risk Hogs' where volatility share significantly exceeds capital allocation"
                  padded
                >
                  <div className="grid__scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Ticker</th>
                          <th className="num">Capital Weight</th>
                          <th className="num">Risk Share (Vol)</th>
                          <th className="num">Risk / Capital Ratio</th>
                        </tr>
                      </thead>
                      <tbody>
                        {xray.risk_vs_capital.map((row) => (
                          <tr key={row.ticker}>
                            <td className="num">{row.ticker}</td>
                            <td className="num">{formatPercent(row.weight)}</td>
                            <td className="num">{formatPercent(row.risk_share)}</td>
                            <td
                              className={`num ${row.risk_to_weight >= 1.5 ? 'neg' : ''}`}
                            >
                              {formatRatio(row.risk_to_weight)}x
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                <Panel
                  title="Multi-Dimensional Exposure Breakdown"
                  subtitle="Capital allocation across Asset Class, Region, and Currency"
                  padded
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      gap: '1rem',
                    }}
                  >
                    <div>
                      <h4
                        style={{
                          fontSize: '0.78rem',
                          textTransform: 'uppercase',
                          marginBottom: '0.5rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Asset Class
                      </h4>
                      {xray.exposure.asset_class.map((item) => (
                        <div
                          key={item.key}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '0.25rem 0',
                            borderBottom: '1px solid var(--border-subtle)',
                          }}
                        >
                          <span>{item.key}</span>
                          <span className="num">{formatPercent(item.weight)}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <h4
                        style={{
                          fontSize: '0.78rem',
                          textTransform: 'uppercase',
                          marginBottom: '0.5rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Region
                      </h4>
                      {xray.exposure.region.map((item) => (
                        <div
                          key={item.key}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '0.25rem 0',
                            borderBottom: '1px solid var(--border-subtle)',
                          }}
                        >
                          <span>{item.key}</span>
                          <span className="num">{formatPercent(item.weight)}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <h4
                        style={{
                          fontSize: '0.78rem',
                          textTransform: 'uppercase',
                          marginBottom: '0.5rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Currency
                      </h4>
                      {xray.exposure.currency.map((item) => (
                        <div
                          key={item.key}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '0.25rem 0',
                            borderBottom: '1px solid var(--border-subtle)',
                          }}
                        >
                          <span className="num">{item.key}</span>
                          <span className="num">{formatPercent(item.weight)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Panel>
              </div>
            </div>
          )}

          {activeTab === 'stress' && stress && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                  gap: '1rem',
                }}
              >
                <Panel
                  title="Scenario Builder (Multi-Factor Shock)"
                  subtitle="Simulate simultaneous shocks across Equities, Interest Rates, USD, Gold, and Crypto"
                  padded
                  actions={
                    <button
                      type="button"
                      className="button button--primary button--sm"
                      onClick={() => void handleRunCustomShock()}
                      disabled={stressLoading}
                    >
                      {stressLoading ? 'Calculating…' : 'Apply Custom Shock'}
                    </button>
                  }
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                      gap: '0.85rem',
                    }}
                  >
                    <label className="field">
                      <span className="field__label">Equities Move (%)</span>
                      <input
                        type="number"
                        step="1"
                        className="input num"
                        value={Math.round(customShock.equity_pct * 100)}
                        onChange={(e) =>
                          setCustomShock((s) => ({
                            ...s,
                            equity_pct: Number(e.target.value) / 100,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">Interest Rates (bps)</span>
                      <input
                        type="number"
                        step="25"
                        className="input num"
                        value={customShock.rates_bps}
                        onChange={(e) =>
                          setCustomShock((s) => ({
                            ...s,
                            rates_bps: Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">USD Move (%)</span>
                      <input
                        type="number"
                        step="1"
                        className="input num"
                        value={Math.round(customShock.usd_pct * 100)}
                        onChange={(e) =>
                          setCustomShock((s) => ({
                            ...s,
                            usd_pct: Number(e.target.value) / 100,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">Gold Move (%)</span>
                      <input
                        type="number"
                        step="1"
                        className="input num"
                        value={Math.round(customShock.gold_pct * 100)}
                        onChange={(e) =>
                          setCustomShock((s) => ({
                            ...s,
                            gold_pct: Number(e.target.value) / 100,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">Crypto Move (%)</span>
                      <input
                        type="number"
                        step="5"
                        className="input num"
                        value={Math.round(customShock.crypto_pct * 100)}
                        onChange={(e) =>
                          setCustomShock((s) => ({
                            ...s,
                            crypto_pct: Number(e.target.value) / 100,
                          }))
                        }
                      />
                    </label>
                  </div>
                </Panel>

                <Panel
                  title="Historical Crisis & Parametric Scenarios"
                  subtitle="Select any scenario to inspect position-by-position P&L impact"
                  padded
                >
                  <div className="grid__scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Scenario</th>
                          <th>Window / Type</th>
                          <th className="num">P&L ({baseCurrency})</th>
                          <th className="num">Impact %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stress.results.map((scen) => {
                          const isSelected = scen.key === activeScenario?.key
                          return (
                            <tr
                              key={scen.key}
                              onClick={() => setSelectedScenarioKey(scen.key)}
                              style={{
                                cursor: 'pointer',
                                background: isSelected ? 'var(--bg-elevated)' : undefined,
                              }}
                            >
                              <td>
                                <strong>{scen.name}</strong>
                              </td>
                              <td className="num">{scen.window}</td>
                              <td className={`num ${signClass(scen.pnl)}`}>
                                {formatMoney(scen.pnl)} {baseCurrency}
                              </td>
                              <td className={`num ${signClass(scen.pnl_pct)}`}>
                                {formatPercentSigned(scen.pnl_pct)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>

              {activeScenario && (
                <Panel
                  title={`Scenario Drilldown: ${activeScenario.name}`}
                  subtitle={activeScenario.description}
                  padded
                >
                  <div className="kpi" style={{ marginBottom: '1rem' }}>
                    <div className="kpi__cell">
                      <div className="kpi__label">NAV Before Shock</div>
                      <div className="kpi__value num">
                        {formatMoney(activeScenario.value_before)} {baseCurrency}
                      </div>
                    </div>
                    <div className="kpi__cell">
                      <div className="kpi__label">NAV After Shock</div>
                      <div className="kpi__value num">
                        {formatMoney(activeScenario.value_after)} {baseCurrency}
                      </div>
                    </div>
                    <div className="kpi__cell">
                      <div className="kpi__label">Estimated P&L Impact</div>
                      <div className={`kpi__value num ${signClass(activeScenario.pnl)}`}>
                        {formatMoney(activeScenario.pnl)} ({formatPercentSigned(activeScenario.pnl_pct)})
                      </div>
                    </div>
                    <div className="kpi__cell">
                      <div className="kpi__label">FX Translation Component</div>
                      <div className={`kpi__value num ${signClass(activeScenario.fx_pnl)}`}>
                        {formatMoney(activeScenario.fx_pnl)} {baseCurrency}
                      </div>
                    </div>
                  </div>

                  {activeScenario.positions.length > 0 && (
                    <div className="grid__scroll">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Ticker</th>
                            <th>Asset Class</th>
                            <th>Primary Factor</th>
                            <th className="num">Weight</th>
                            <th className="num">Beta / Dur</th>
                            <th className="num">Local Move</th>
                            <th className="num">Total Move</th>
                            <th className="num">Stressed P&L</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeScenario.positions.map((pos) => (
                            <tr key={pos.ticker}>
                              <td className="num">{pos.ticker}</td>
                              <td>{pos.asset_class}</td>
                              <td className="num">{pos.factor}</td>
                              <td className="num">{formatPercent(pos.weight)}</td>
                              <td className="num">{formatRatio(pos.sensitivity)}</td>
                              <td className={`num ${signClass(pos.price_move_pct)}`}>
                                {formatPercentSigned(pos.price_move_pct)}
                              </td>
                              <td className={`num ${signClass(pos.total_move_pct)}`}>
                                {formatPercentSigned(pos.total_move_pct)}
                              </td>
                              <td className={`num ${signClass(pos.pnl)}`}>
                                {formatMoney(pos.pnl)} {baseCurrency}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              )}
            </div>
          )}

          {activeTab === 'attribution' && attribution && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  alignItems: 'center',
                }}
              >
                <Segmented<AttributionGroupBy>
                  ariaLabel="Group By"
                  value={attrGroupBy}
                  onChange={setAttrGroupBy}
                  options={[
                    { value: 'asset_class', label: 'Asset Class' },
                    { value: 'region', label: 'Region' },
                    { value: 'currency', label: 'Currency' },
                  ]}
                />
                <Segmented<AttributionPeriod>
                  ariaLabel="Period"
                  value={attrPeriod}
                  onChange={setAttrPeriod}
                  options={[
                    { value: 'day', label: '1D' },
                    { value: 'week', label: '1W' },
                    { value: 'month', label: '1M' },
                    { value: 'ytd', label: 'YTD' },
                    { value: 'all', label: 'All' },
                  ]}
                />
              </div>

              <div className="kpi">
                <div className="kpi__cell">
                  <div className="kpi__label">Portfolio Return</div>
                  <div className={`kpi__value num ${signClass(attribution.totals.portfolio_return_pct)}`}>
                    {formatPercentSigned(attribution.totals.portfolio_return_pct)}
                  </div>
                  <div className="kpi__sub">
                    {attribution.start_date} → {attribution.end_date}
                  </div>
                </div>
                <div className="kpi__cell">
                  <div className="kpi__label">Benchmark Return</div>
                  <div className={`kpi__value num ${signClass(attribution.totals.benchmark_return_pct)}`}>
                    {formatPercentSigned(attribution.totals.benchmark_return_pct)}
                  </div>
                  <div className="kpi__sub">{attribution.benchmark_label}</div>
                </div>
                <div className="kpi__cell">
                  <div className="kpi__label">Active Return</div>
                  <div className={`kpi__value num ${signClass(attribution.totals.active_return_pct)}`}>
                    {formatPercentSigned(attribution.totals.active_return_pct)}
                  </div>
                  <div className="kpi__sub">Allocation + Selection + Interaction</div>
                </div>
                <div className="kpi__cell">
                  <div className="kpi__label">Allocation / Selection</div>
                  <div className="kpi__value num">
                    {formatPercentSigned(attribution.totals.allocation_pct)} /{' '}
                    {formatPercentSigned(attribution.totals.selection_pct)}
                  </div>
                  <div className="kpi__sub">
                    Interaction: {formatPercentSigned(attribution.totals.interaction_pct)}
                  </div>
                </div>
              </div>

              <Panel
                title="Brinson-Fachler Segment Decomposition"
                subtitle={attribution.basis}
                padded
              >
                <div className="grid__scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Segment</th>
                        <th className="num">Port. Weight</th>
                        <th className="num">Bench. Weight</th>
                        <th className="num">Port. Return</th>
                        <th className="num">Bench. Return</th>
                        <th className="num">Allocation</th>
                        <th className="num">Selection</th>
                        <th className="num">Interaction</th>
                        <th className="num">Total Active</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attribution.segments.map((seg) => (
                        <tr key={seg.key}>
                          <td>
                            <strong>{seg.key}</strong>
                          </td>
                          <td className="num">{formatPercent(seg.portfolio_weight)}</td>
                          <td className="num">{formatPercent(seg.benchmark_weight)}</td>
                          <td className={`num ${signClass(seg.portfolio_return_pct)}`}>
                            {formatPercentSigned(seg.portfolio_return_pct)}
                          </td>
                          <td className={`num ${signClass(seg.benchmark_return_pct)}`}>
                            {formatPercentSigned(seg.benchmark_return_pct)}
                          </td>
                          <td className={`num ${signClass(seg.allocation_pct)}`}>
                            {formatPercentSigned(seg.allocation_pct)}
                          </td>
                          <td className={`num ${signClass(seg.selection_pct)}`}>
                            {formatPercentSigned(seg.selection_pct)}
                          </td>
                          <td className={`num ${signClass(seg.interaction_pct)}`}>
                            {formatPercentSigned(seg.interaction_pct)}
                          </td>
                          <td className={`num ${signClass(seg.total_pct)}`}>
                            <strong>{formatPercentSigned(seg.total_pct)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          )}

          {(xrayLoading || attrLoading) && !xray && !attribution && (
            <p className="muted">Loading Portfolio Lab analytics…</p>
          )}
        </Panel>
      </div>
    </main>
  )
}

export default LabView
