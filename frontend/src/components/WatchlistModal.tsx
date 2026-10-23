/**
 * Watchlist window: price targets for symbols you follow, the alerts they
 * and your rules have triggered, and forms to add both.
 */

import { useCallback, useEffect, useState } from 'react'

import { Dialog } from './Dialog'
import {
  addAlertRule,
  addWatchlistItem,
  deleteAlertRule,
  deleteWatchlistItem,
  type DataConfig,
  getWatchlistAndAlerts,
} from '../lib/api'
import { formatMoney, formatPercent, formatPercentSigned } from '../lib/format'
import type { OrderType, WatchlistItem, WatchlistResponse } from '../lib/types'

type Tab = 'watchlist' | 'alerts' | 'add'

const STATUS_LABELS: Record<WatchlistItem['status'], string> = {
  BUY_ZONE: 'At buy target',
  TAKE_PROFIT: 'At sell target',
  WATCHING: 'Watching',
}

// What each rule watches, as a choice ("Warn me when …") and as a table label.
const RULE_OPTIONS: Record<string, string> = {
  price_below: 'A price falls to or below',
  price_above: 'A price rises to or above',
  drawdown_pct: 'The portfolio drawdown reaches',
  var_95_pct: 'The 95% daily value at risk reaches',
  position_weight_pct: 'A position grows to a weight of',
  yield_10y_above: 'The 10-year yield rises to',
}

const RULE_LABELS: Record<string, string> = {
  price_below: 'Price at or below',
  price_above: 'Price at or above',
  drawdown_pct: 'Drawdown',
  var_95_pct: '95% daily value at risk',
  position_weight_pct: 'Position weight',
  yield_10y_above: '10-year yield',
}

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
  const [activeTab, setActiveTab] = useState<Tab>('watchlist')

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
      setError(err instanceof Error ? err.message : 'The symbol was not added. Try again.')
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
      setError(err instanceof Error ? err.message : 'The rule was not added. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteRule = async (id: number) => {
    await deleteAlertRule(config, id, portfolioId)
    await loadData()
  }

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'watchlist', label: 'Watchlist', count: data?.watchlist.length },
    { key: 'alerts', label: 'Alerts', count: data?.triggered_alerts.length },
    { key: 'add', label: 'Add' },
  ]

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const index = tabs.findIndex((t) => t.key === activeTab)
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(index + step + tabs.length) % tabs.length]
    setActiveTab(next.key)
    document.getElementById(`watchlist-tab-${next.key}`)?.focus()
  }

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      size="xl"
      title="Watchlist and alerts"
      description={`Price targets for symbols you follow, and rules that warn you about the portfolio. Prices are in each symbol's own currency; the portfolio reports in ${baseCurrency}.`}
      className="watchlist"
    >
      <div className="tabs" role="tablist" aria-label="Watchlist sections">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            id={`watchlist-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            aria-controls={`watchlist-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className="tabs__tab"
            onClick={() => setActiveTab(tab.key)}
            onKeyDown={onTabKeyDown}
          >
            {tab.label}
            {tab.count !== undefined && <span className="tabs__count num">{tab.count}</span>}
          </button>
        ))}
        {loading && <span className="spinner spinner--on tabs__spinner" aria-label="Loading" />}
      </div>

      {error && (
        <div className="dialog__error" role="alert">
          {error}
        </div>
      )}

      {data && data.triggered_alerts.length > 0 && activeTab === 'watchlist' && (
        <div className="dialog__notice dialog__notice--warning dialog__notice--row">
          <span>
            {data.triggered_alerts.length === 1
              ? data.triggered_alerts[0].title
              : `${data.triggered_alerts.length} alerts are active, starting with: ${data.triggered_alerts[0].title}`}
          </span>
          <button type="button" className="button button--quiet button--sm" onClick={() => setActiveTab('alerts')}>
            See alerts
          </button>
        </div>
      )}

      <div
        id={`watchlist-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`watchlist-tab-${activeTab}`}
        className="tabs__panel"
      >
        {activeTab === 'watchlist' && data && (
          data.watchlist.length === 0 ? (
            <div className="empty">
              <p>Nothing on the watchlist yet. Add a symbol with the price you would buy or sell at.</p>
              <button type="button" className="button button--primary" onClick={() => setActiveTab('add')}>
                Add a symbol
              </button>
            </div>
          ) : (
            <div className="grid__scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Name</th>
                    <th className="num">Price</th>
                    <th className="num">Buy at</th>
                    <th className="num">Sell at</th>
                    <th>Status</th>
                    <th className="num">In portfolio</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
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
                        {item.notes && <div className="watchlist__note">{item.notes}</div>}
                      </td>
                      <td className="num">
                        {formatMoney(item.last_price)} {item.last_price !== null && item.currency}
                        {item.price_source === 'reference' && (
                          <span
                            className="watchlist__sub"
                            title="No live quote is available. This is a stored reference price, and it never triggers an alert."
                          >
                            Reference price
                          </span>
                        )}
                        {item.price_source === 'unavailable' && (
                          <span className="watchlist__sub">No price available</span>
                        )}
                      </td>
                      <td className="num">
                        {item.target_buy_price ? formatMoney(item.target_buy_price) : '—'}
                        {item.distance_to_buy_pct !== null && (
                          <span className={`watchlist__sub ${item.distance_to_buy_pct <= 0 ? 'pos' : ''}`}>
                            {formatPercentSigned(item.distance_to_buy_pct)} away
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {item.target_sell_price ? formatMoney(item.target_sell_price) : '—'}
                        {item.distance_to_sell_pct !== null && (
                          <span className={`watchlist__sub ${item.distance_to_sell_pct <= 0 ? 'neg' : ''}`}>
                            {formatPercentSigned(item.distance_to_sell_pct)} away
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={`status status--${item.status.toLowerCase().replace('_', '-')}`}>
                          {STATUS_LABELS[item.status]}
                        </span>
                      </td>
                      <td className="num">
                        {item.in_portfolio ? formatPercent(item.portfolio_weight) : '—'}
                      </td>
                      <td>
                        <div className="watchlist__actions">
                          {onOpenTradeModal && (
                            <button
                              type="button"
                              className="button button--quiet button--sm"
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
                            className="button button--quiet button--sm"
                            onClick={() => void handleDeleteItem(item.id)}
                            aria-label={`Remove ${item.ticker} from the watchlist`}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {activeTab === 'alerts' && data && (
          <div className="watchlist__alerts">
            <section>
              <h3 className="watchlist__heading">Active now</h3>
              {data.triggered_alerts.length === 0 ? (
                <p className="muted">No target or rule is triggered at current prices.</p>
              ) : (
                <ul className="alert-list">
                  {data.triggered_alerts.map((al) => (
                    <li key={al.id} className={`alert-list__item alert-list__item--${al.severity}`}>
                      <div className="alert-list__head">
                        <span className="alert-list__title">{al.title}</span>
                        <span className="alert-list__category">{al.category}</span>
                      </div>
                      <p className="alert-list__message">{al.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="watchlist__heading">Your rules</h3>
              {data.rules.length === 0 ? (
                <p className="muted">
                  No rules yet. A rule can watch a price, the portfolio drawdown, its value at risk,
                  a position's weight or the 10-year yield.
                </p>
              ) : (
                <div className="grid__scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Rule</th>
                        <th>Watches</th>
                        <th>Symbol</th>
                        <th className="num">Threshold</th>
                        <th>
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rules.map((rule) => (
                        <tr key={rule.id}>
                          <td>{rule.label}</td>
                          <td>{RULE_LABELS[rule.metric] ?? rule.metric}</td>
                          <td className="num">{rule.ticker || 'Whole portfolio'}</td>
                          <td className="num">{rule.threshold}</td>
                          <td>
                            <button
                              type="button"
                              className="button button--quiet button--sm"
                              onClick={() => void handleDeleteRule(rule.id)}
                              aria-label={`Delete the rule ${rule.label}`}
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'add' && (
          <div className="watchlist__forms">
            <form onSubmit={handleAddWatchlist} className="watchlist__form">
              <h3 className="watchlist__heading">Watch a symbol</h3>
              <label className="field">
                <span className="field__label">Symbol</span>
                <input
                  type="text"
                  required
                  className="input num"
                  value={newTicker}
                  onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                  placeholder="NVDA"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span className="field__label">Name (optional)</span>
                <input
                  type="text"
                  className="input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="NVIDIA Corp."
                />
              </label>
              <div className="dialog__grid">
                <label className="field">
                  <span className="field__label">Buy at or below</span>
                  <input
                    type="number"
                    step="any"
                    className="input num"
                    value={newTargetBuy}
                    onChange={(e) => setNewTargetBuy(e.target.value)}
                    placeholder="125.00"
                  />
                </label>
                <label className="field">
                  <span className="field__label">Sell at or above</span>
                  <input
                    type="number"
                    step="any"
                    className="input num"
                    value={newTargetSell}
                    onChange={(e) => setNewTargetSell(e.target.value)}
                    placeholder="165.00"
                  />
                </label>
              </div>
              <label className="field">
                <span className="field__label">Note (optional)</span>
                <input
                  type="text"
                  className="input"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Why you are watching it"
                />
              </label>
              <button type="submit" className="button button--primary" disabled={saving || !newTicker.trim()}>
                {saving ? 'Adding…' : 'Add to watchlist'}
              </button>
            </form>

            <form onSubmit={handleAddRule} className="watchlist__form">
              <h3 className="watchlist__heading">Add a rule</h3>
              <label className="field">
                <span className="field__label">Warn me when</span>
                <select className="input" value={ruleMetric} onChange={(e) => setRuleMetric(e.target.value)}>
                  {Object.entries(RULE_OPTIONS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {(ruleMetric === 'price_above' || ruleMetric === 'price_below') && (
                <label className="field">
                  <span className="field__label">Symbol</span>
                  <input
                    type="text"
                    required
                    className="input num"
                    value={ruleTicker}
                    onChange={(e) => setRuleTicker(e.target.value.toUpperCase())}
                    placeholder="MSFT"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
              <label className="field">
                <span className="field__label">
                  {ruleMetric.includes('pct') || ruleMetric === 'yield_10y_above' ? 'Threshold (%)' : 'Price'}
                </span>
                <input
                  type="number"
                  step="any"
                  required
                  className="input num"
                  value={ruleThreshold}
                  onChange={(e) => setRuleThreshold(e.target.value)}
                  placeholder={ruleMetric.includes('pct') ? '-10' : '450.00'}
                />
              </label>
              <label className="field">
                <span className="field__label">Name (optional)</span>
                <input
                  type="text"
                  className="input"
                  value={ruleLabel}
                  onChange={(e) => setRuleLabel(e.target.value)}
                  placeholder="MSFT below my entry"
                />
              </label>
              <button type="submit" className="button button--primary" disabled={saving || !ruleThreshold}>
                {saving ? 'Adding…' : 'Add rule'}
              </button>
            </form>
          </div>
        )}
      </div>
    </Dialog>
  )
}
