import { useCallback, useEffect, useState } from 'react'
import {
  addAlertRule,
  addWatchlistItem,
  deleteAlertRule,
  deleteWatchlistItem,
  type DataConfig,
  getWatchlistAndAlerts,
} from '../lib/api'
import { formatMoney, formatPercent, formatPercentSigned } from '../lib/format'
import type { OrderType, WatchlistResponse } from '../lib/types'

interface WatchlistModalProps {
  isOpen: boolean
  onClose: () => void
  config: DataConfig
  portfolioId: number
  baseCurrency: string
  onOpenTradeModal?: (ticker?: string, type?: OrderType) => void
}

export function WatchlistModal({
  isOpen,
  onClose,
  config,
  portfolioId,
  baseCurrency,
  onOpenTradeModal,
}: WatchlistModalProps) {
  const [data, setData] = useState<WatchlistResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'watchlist' | 'alerts' | 'add'>('watchlist')

  // Add Item State
  const [newTicker, setNewTicker] = useState('')
  const [newName, setNewName] = useState('')
  const [newTargetBuy, setNewTargetBuy] = useState('')
  const [newTargetSell, setNewTargetSell] = useState('')
  const [newNotes, setNewNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Add Rule State
  const [ruleMetric, setRuleMetric] = useState('price_below')
  const [ruleTicker, setRuleTicker] = useState('')
  const [ruleThreshold, setRuleThreshold] = useState('')
  const [ruleLabel, setRuleLabel] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getWatchlistAndAlerts(config, portfolioId)
      setData(res)
    } finally {
      setLoading(false)
    }
  }, [config, portfolioId])

  useEffect(() => {
    if (isOpen) {
      void loadData()
    }
  }, [isOpen, loadData])

  if (!isOpen) return null

  const handleAddWatchlist = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTicker.trim()) return
    setSaving(true)
    setError(null)
    try {
      await addWatchlistItem(
        config,
        {
          ticker: newTicker.trim().toUpperCase(),
          name: newName.trim(),
          target_buy_price: newTargetBuy ? Number(newTargetBuy) : null,
          target_sell_price: newTargetSell ? Number(newTargetSell) : null,
          notes: newNotes.trim(),
        },
        portfolioId,
      )
      setNewTicker('')
      setNewName('')
      setNewTargetBuy('')
      setNewTargetSell('')
      setNewNotes('')
      setActiveTab('watchlist')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add watchlist item')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteItem = async (id: number) => {
    await deleteWatchlistItem(config, id, portfolioId)
    await loadData()
  }

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ruleThreshold) return
    setSaving(true)
    setError(null)
    try {
      await addAlertRule(
        config,
        {
          metric: ruleMetric,
          ticker: ruleTicker.trim().toUpperCase() || null,
          threshold: Number(ruleThreshold),
          label: ruleLabel.trim(),
        },
        portfolioId,
      )
      setRuleThreshold('')
      setRuleLabel('')
      setActiveTab('alerts')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add alert rule')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteRule = async (id: number) => {
    await deleteAlertRule(config, id, portfolioId)
    await loadData()
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Watchlists and Smart Alerts"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        style={{
          width: 'min(860px, 96vw)',
          background: 'var(--surface-panel)',
          border: '1px solid rgba(0, 210, 255, 0.35)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.8), 0 0 30px rgba(0, 210, 255, 0.15)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 1.4rem',
            borderBottom: '1px solid var(--line)',
            background: 'var(--surface-header)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
                {loading && <span className="spinner spinner--on" style={{ marginRight: '0.5rem' }} />}
                Watchlists & Smart Alerts
              </h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Target buy/sell price alerts, macro guardrails, and portfolio risk limits
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div className="segmented" role="group">
              <button
                type="button"
                className="segmented__option"
                aria-pressed={activeTab === 'watchlist'}
                onClick={() => setActiveTab('watchlist')}
              >
                Watchlist ({data?.watchlist.length ?? 0})
              </button>
              <button
                type="button"
                className="segmented__option"
                aria-pressed={activeTab === 'alerts'}
                onClick={() => setActiveTab('alerts')}
              >
                Alerts ({data?.triggered_alerts.length ?? 0})
              </button>
              <button
                type="button"
                className="segmented__option"
                aria-pressed={activeTab === 'add'}
                onClick={() => setActiveTab('add')}
              >
                + Add Item / Rule
              </button>
            </div>
            <button
              type="button"
              className="button button--quiet button--mini"
              onClick={onClose}
              aria-label="Close modal"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '1rem 1.25rem', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div
              style={{
                padding: '0.65rem 0.85rem',
                background: 'rgba(218, 30, 40, 0.1)',
                borderLeft: '3px solid var(--negative)',
                marginBottom: '1rem',
                fontSize: '0.85rem',
                color: 'var(--negative)',
              }}
            >
              {error}
            </div>
          )}

          {/* Triggered Alerts Banner */}
          {data && data.triggered_alerts.length > 0 && activeTab !== 'alerts' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.6rem 0.85rem',
                background: 'rgba(210, 153, 34, 0.1)',
                borderLeft: '3px solid #d29922',
                marginBottom: '1rem',
                fontSize: '0.82rem',
              }}
            >
              <span>
                <strong>{data.triggered_alerts.length} Active Alert(s):</strong>{' '}
                {data.triggered_alerts[0].title}
              </span>
              <button
                type="button"
                className="button button--quiet button--mini"
                onClick={() => setActiveTab('alerts')}
              >
                View Alerts →
              </button>
            </div>
          )}

          {activeTab === 'watchlist' && data && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="grid__scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Name</th>
                      <th className="num">Price</th>
                      <th className="num">Target Buy</th>
                      <th className="num">Target Sell</th>
                      <th>Status</th>
                      <th>In Book</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.watchlist.map((item) => (
                      <tr key={item.id}>
                        <td className="num">
                          <strong>{item.ticker}</strong>
                        </td>
                        <td>
                          <div>{item.name}</div>
                          {item.notes && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                              {item.notes}
                            </div>
                          )}
                        </td>
                        <td className="num">
                          {formatMoney(item.last_price)} {item.currency}
                        </td>
                        <td className="num">
                          {item.target_buy_price ? `${formatMoney(item.target_buy_price)}` : '—'}
                          {item.distance_to_buy_pct !== null && (
                            <span
                              style={{
                                display: 'block',
                                fontSize: '0.7rem',
                                color: item.distance_to_buy_pct <= 0 ? 'var(--positive)' : 'var(--text-secondary)',
                              }}
                            >
                              ({formatPercentSigned(item.distance_to_buy_pct)})
                            </span>
                          )}
                        </td>
                        <td className="num">
                          {item.target_sell_price ? `${formatMoney(item.target_sell_price)}` : '—'}
                          {item.distance_to_sell_pct !== null && (
                            <span
                              style={{
                                display: 'block',
                                fontSize: '0.7rem',
                                color: item.distance_to_sell_pct <= 0 ? 'var(--negative)' : 'var(--text-secondary)',
                              }}
                            >
                              ({formatPercentSigned(item.distance_to_sell_pct)})
                            </span>
                          )}
                        </td>
                        <td>
                          <span
                            className="num pill-badge"
                            style={{
                              fontSize: '0.68rem',
                              padding: '2px 8px',
                              fontWeight: 600,
                              borderRadius: 'var(--radius-full)',
                              background:
                                item.status === 'BUY_ZONE'
                                  ? 'var(--positive-bg)'
                                  : item.status === 'TAKE_PROFIT'
                                    ? 'var(--warning-bg)'
                                    : 'var(--surface-raised)',
                              color:
                                item.status === 'BUY_ZONE'
                                  ? 'var(--positive)'
                                  : item.status === 'TAKE_PROFIT'
                                    ? 'var(--warning)'
                                    : 'var(--text-secondary)',
                              border:
                                item.status === 'BUY_ZONE'
                                  ? '1px solid rgba(0, 240, 118, 0.4)'
                                  : item.status === 'TAKE_PROFIT'
                                    ? '1px solid rgba(255, 183, 3, 0.4)'
                                    : '1px solid var(--line)',
                              boxShadow:
                                item.status === 'BUY_ZONE'
                                  ? '0 0 8px rgba(0, 240, 118, 0.25)'
                                  : item.status === 'TAKE_PROFIT'
                                    ? '0 0 8px rgba(255, 183, 3, 0.25)'
                                    : 'none',
                            }}
                          >
                            {item.status}
                          </span>
                        </td>
                        <td className="num">
                          {item.in_portfolio ? (
                            <span title={`Held in portfolio (${formatPercent(item.portfolio_weight)})`}>
                              ✓ {formatPercent(item.portfolio_weight)}
                            </span>
                          ) : (
                            <span style={{ opacity: 0.5 }}>—</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.35rem' }}>
                            {onOpenTradeModal && (
                              <button
                                type="button"
                                className="button button--quiet button--mini"
                                onClick={() => {
                                  onClose()
                                  onOpenTradeModal(item.ticker, 'BUY')
                                }}
                              >
                                Buy
                              </button>
                            )}
                            <button
                              type="button"
                              className="button button--quiet button--mini"
                              onClick={() => void handleDeleteItem(item.id)}
                              title="Delete watchlist item"
                            >
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'alerts' && data && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.88rem' }}>
                  Live Triggered Smart Alerts ({data.triggered_alerts.length}):
                </h4>
                {data.triggered_alerts.length === 0 ? (
                  <p className="muted">No active risk or price alerts triggered.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {data.triggered_alerts.map((al) => (
                      <div
                        key={al.id}
                        style={{
                          padding: '0.8rem 1rem',
                          background: 'var(--surface-raised)',
                          border: '1px solid var(--line)',
                          borderRadius: 'var(--radius-sm)',
                          boxShadow: 'var(--shadow-sm)',
                          borderLeft: `3px solid ${
                            al.severity === 'high' ? 'var(--negative)' : 'var(--warning)'
                          }`,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                            {al.title}
                          </span>
                          <span
                            className="num pill-badge"
                            style={{
                              fontSize: '0.68rem',
                              textTransform: 'uppercase',
                              padding: '2px 8px',
                              borderRadius: 'var(--radius-full)',
                              background: 'var(--surface-panel)',
                              border: '1px solid var(--line)',
                              color: 'var(--text-tertiary)',
                            }}
                          >
                            {al.category}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                          {al.message}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h4 style={{ margin: '1rem 0 0.5rem', fontSize: '0.88rem' }}>
                  Configured Alert Rules ({data.rules.length}):
                </h4>
                {data.rules.length === 0 ? (
                  <p className="muted">No custom alert rules configured yet.</p>
                ) : (
                  <div className="grid__scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Label</th>
                          <th>Metric</th>
                          <th>Ticker</th>
                          <th className="num">Threshold</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rules.map((rule) => (
                          <tr key={rule.id}>
                            <td>{rule.label}</td>
                            <td className="num">{rule.metric}</td>
                            <td className="num">{rule.ticker || 'PORTFOLIO'}</td>
                            <td className="num">{rule.threshold}</td>
                            <td>
                              <button
                                type="button"
                                className="button button--quiet button--mini"
                                onClick={() => void handleDeleteRule(rule.id)}
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'add' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
              {/* Form 1: Add Watchlist Item */}
              <form onSubmit={handleAddWatchlist} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <h4 style={{ margin: 0, fontSize: '0.88rem' }}>Add Watchlist Ticker</h4>
                <label className="field">
                  <span className="field__label">Symbol / Ticker *</span>
                  <input
                    type="text"
                    required
                    className="input num"
                    value={newTicker}
                    onChange={(e) => setNewTicker(e.target.value)}
                    placeholder="e.g. NVDA, AAPL, BTC-USD"
                  />
                </label>
                <label className="field">
                  <span className="field__label">Company / Asset Name</span>
                  <input
                    type="text"
                    className="input"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. NVIDIA Corporation"
                  />
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  <label className="field">
                    <span className="field__label">Target Buy Price</span>
                    <input
                      type="number"
                      step="any"
                      className="input num"
                      value={newTargetBuy}
                      onChange={(e) => setNewTargetBuy(e.target.value)}
                      placeholder="e.g. 125.00"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Target Sell Price</span>
                    <input
                      type="number"
                      step="any"
                      className="input num"
                      value={newTargetSell}
                      onChange={(e) => setNewTargetSell(e.target.value)}
                      placeholder="e.g. 165.00"
                    />
                  </label>
                </div>
                <label className="field">
                  <span className="field__label">Investment Notes / Thesis</span>
                  <input
                    type="text"
                    className="input"
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    placeholder="e.g. AI catalyst, watch Q3 margins"
                  />
                </label>
                <button
                  type="submit"
                  className="button button--primary button--sm"
                  disabled={saving || !newTicker.trim()}
                >
                  {saving ? 'Adding…' : '+ Add to Watchlist'}
                </button>
              </form>

              {/* Form 2: Add Custom Alert Rule */}
              <form onSubmit={handleAddRule} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <h4 style={{ margin: 0, fontSize: '0.88rem' }}>Add Custom Alert Rule</h4>
                <label className="field">
                  <span className="field__label">Metric Condition</span>
                  <select
                    className="input"
                    value={ruleMetric}
                    onChange={(e) => setRuleMetric(e.target.value)}
                  >
                    <option value="price_below">Price &lt;= Threshold (Buy Trigger)</option>
                    <option value="price_above">Price &gt;= Threshold (Take-Profit Trigger)</option>
                    <option value="drawdown_pct">Portfolio Drawdown &lt;= Threshold (%)</option>
                    <option value="var_95_pct">95% Daily VaR &lt;= Threshold (%)</option>
                    <option value="position_weight_pct">Position Weight &gt;= Threshold (%)</option>
                    <option value="yield_10y_above">10Y Yield &gt;= Threshold (%)</option>
                  </select>
                </label>
                {(ruleMetric === 'price_above' || ruleMetric === 'price_below') && (
                  <label className="field">
                    <span className="field__label">Ticker Symbol *</span>
                    <input
                      type="text"
                      required
                      className="input num"
                      value={ruleTicker}
                      onChange={(e) => setRuleTicker(e.target.value)}
                      placeholder="e.g. MSFT"
                    />
                  </label>
                )}
                <label className="field">
                  <span className="field__label">Threshold Value *</span>
                  <input
                    type="number"
                    step="any"
                    required
                    className="input num"
                    value={ruleThreshold}
                    onChange={(e) => setRuleThreshold(e.target.value)}
                    placeholder={ruleMetric.includes('pct') ? 'e.g. -10 for -10%' : 'e.g. 450.00'}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Alert Description / Label</span>
                  <input
                    type="text"
                    className="input"
                    value={ruleLabel}
                    onChange={(e) => setRuleLabel(e.target.value)}
                    placeholder="e.g. MSFT deep-value alert"
                  />
                </label>
                <button
                  type="submit"
                  className="button button--primary button--sm"
                  disabled={saving || !ruleThreshold}
                >
                  {saving ? 'Creating…' : '+ Create Alert Rule'}
                </button>
              </form>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.85rem 1.25rem',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)',
            fontSize: '0.78rem',
            color: 'var(--text-secondary)',
          }}
        >
          <span>Base Currency: {baseCurrency}</span>
          <button
            type="button"
            className="button button--quiet button--sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
