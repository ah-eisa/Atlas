/**
 * Transactions / Trade Ledger View.
 *
 * Merged from PortfolioManager: Displays full order execution history,
 * closed trade realized gains/losses, win-rate metrics, and transaction auditing.
 */

import { useEffect, useMemo, useState } from 'react'

import { AnimatedNumber } from '../components/AnimatedNumber'
import { Panel } from '../components/Panel'
import {
  deleteTransaction,
  getRealizedPnlSummary,
  listTransactions,
  type DataConfig,
} from '../lib/api'
import {
  formatDate,
  formatMoney,
  formatMoneySigned,
  formatPercent,
  formatQuantity,
  signClass,
} from '../lib/format'
import type {
  PortfolioState,
  RealizedPnlSummary,
  Transaction,
} from '../lib/types'

interface TransactionsViewProps {
  state: PortfolioState
  config: DataConfig
  onReload: () => void
  onOpenTradeModal: (ticker?: string, type?: 'BUY' | 'SELL') => void
}

export default function TransactionsView({
  state,
  config,
  onReload,
  onOpenTradeModal,
}: TransactionsViewProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [summary, setSummary] = useState<RealizedPnlSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState<'ALL' | 'BUY' | 'SELL'>('ALL')
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const isLive = state.source === 'api'
  const currency = state.baseCurrency || 'USD'

  const loadData = async () => {
    if (!isLive) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [txs, pnlSummary] = await Promise.all([
        listTransactions(config),
        getRealizedPnlSummary(config),
      ])
      setTransactions(txs)
      setSummary(pnlSummary)
    } catch {
      // Graceful fallback
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [config, isLive])

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this transaction? Its effect on the position is reversed as well.')) return
    setDeletingId(id)
    setDeleteError(null)
    try {
      await deleteTransaction(config, id)
      await loadData()
      onReload()
    } catch (err) {
      // A purchase whose units a later sale used cannot be reversed (409).
      setDeleteError(err instanceof Error ? err.message : 'The transaction could not be deleted.')
    } finally {
      setDeletingId(null)
    }
  }

  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (filterType !== 'ALL' && tx.order_type !== filterType) return false
      if (search.trim() && !tx.ticker.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [transactions, filterType, search])

  if (!isLive) {
    return (
      <main className="app__main">
        <Panel title="Trade Ledger" subtitle="Snapshot mode">
          <div className="state state--inline">
            <span className="state__kicker">Demo snapshot mode</span>
            <span className="state__title">Realized trade ledger is available in Live API mode</span>
            <p className="state__detail">
              Switch to Live API mode to execute BUY/SELL orders, track transaction history, and record FIFO realized gains.
            </p>
          </div>
        </Panel>
      </main>
    )
  }

  return (
    <main className="app__main">
      {deleteError && (
        <div className="banner banner--error" role="alert">
          <span className="banner__label">Not deleted</span>
          <span className="banner__message">{deleteError}</span>
        </div>
      )}

      {/* Realized Performance & Trade KPI Cards */}
      <section className="kpi-band" aria-label="Trade Performance KPI Strip">
        <div className="kpi__cell">
          <span className="kpi__label">Total Realized P&L</span>
          <span className={`num kpi__value ${signClass(summary?.total_realized_pnl ?? 0)}`}>
            <AnimatedNumber
              value={summary?.total_realized_pnl ?? 0}
              format={formatMoneySigned}
            />{' '}
            <span className="kpi__unit">{currency}</span>
          </span>
          <span className="kpi__sub">Profit from closed positions</span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">Trade Win Rate</span>
          <span className="num kpi__value">
            {summary?.win_rate_pct !== null && summary?.win_rate_pct !== undefined
              ? formatPercent(summary.win_rate_pct, 1)
              : '—'}
          </span>
          <span className="kpi__sub">
            {summary?.winning_trades ?? 0} wins · {summary?.losing_trades ?? 0} losses
          </span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">Total Orders Executed</span>
          <span className="num kpi__value">{summary?.total_trades ?? 0}</span>
          <span className="kpi__sub">
            {summary?.total_buys ?? 0} buys · {summary?.total_sells ?? 0} sells
          </span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">Total Turn Over / Volume</span>
          <span className="num kpi__value">
            {formatMoney((summary?.total_buy_volume ?? 0) + (summary?.total_sell_volume ?? 0))}
          </span>
          <span className="kpi__sub">Cumulative trade value</span>
        </div>
      </section>

      {/* Transactions List */}
      <Panel
        title="Trade Ledger"
        subtitle={`${filteredTransactions.length} recorded orders`}
        actions={
          <button
            type="button"
            className="button button--primary button--sm"
            onClick={() => onOpenTradeModal()}
          >
            + Place Trade Order
          </button>
        }
      >
        <div className="holdings-toolbar">
          <div className="holdings-toolbar__search">
            <input
              className="holdings-toolbar__input"
              type="search"
              placeholder="Search ticker..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button
              type="button"
              className={`button button--mini ${filterType === 'ALL' ? 'button--primary' : 'button--quiet'}`}
              onClick={() => setFilterType('ALL')}
            >
              All Orders
            </button>
            <button
              type="button"
              className={`button button--mini ${filterType === 'BUY' ? 'button--primary' : 'button--quiet'}`}
              onClick={() => setFilterType('BUY')}
            >
              Buys
            </button>
            <button
              type="button"
              className={`button button--mini ${filterType === 'SELL' ? 'button--primary' : 'button--quiet'}`}
              onClick={() => setFilterType('SELL')}
            >
              Sells
            </button>
          </div>
        </div>

        <div className="grid__scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="grid__th">Date</th>
                <th className="grid__th">Side</th>
                <th className="grid__th">Symbol</th>
                <th className="grid__th grid__th--right">Quantity</th>
                <th className="grid__th grid__th--right">Execution Price</th>
                <th className="grid__th grid__th--right">Notional Value</th>
                <th className="grid__th grid__th--right">Realized P&L</th>
                <th className="grid__th">Notes</th>
                <th className="grid__th grid__th--right">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredTransactions.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: 'var(--space-8)' }}>
                    <span className="panel__subtitle">
                      {loading
                        ? 'Loading transactions...'
                        : 'No trades recorded yet. Click "+ Place Trade Order" to execute your first order.'}
                    </span>
                  </td>
                </tr>
              ) : (
                filteredTransactions.map((tx) => {
                  const notional = tx.quantity * tx.price
                  const isBuy = tx.order_type === 'BUY'
                  return (
                    <tr key={tx.id} className="grid__row">
                      <td className="grid__td num">{formatDate(tx.executed_at)}</td>
                      <td className="grid__td">
                        <span
                          className={`grid__tag ${
                            isBuy ? 'trade-pill--buy' : 'trade-pill--sell'
                          }`}
                        >
                          {tx.order_type}
                        </span>
                      </td>
                      <td className="grid__td num grid__ticker">{tx.ticker}</td>
                      <td className="grid__td grid__td--right num">
                        {formatQuantity(tx.quantity)}
                      </td>
                      <td className="grid__td grid__td--right num">{formatMoney(tx.price)}</td>
                      <td className="grid__td grid__td--right num grid__strong">
                        {formatMoney(notional)}
                      </td>
                      <td
                        className={`grid__td grid__td--right num ${
                          !isBuy ? signClass(tx.realized_pnl) : ''
                        }`}
                      >
                        {!isBuy ? formatMoneySigned(tx.realized_pnl) : '—'}
                      </td>
                      <td className="grid__td panel__subtitle">{tx.notes || '—'}</td>
                      <td className="grid__td grid__td--right">
                        <button
                          type="button"
                          className="button button--danger-text button--mini"
                          onClick={() => handleDelete(tx.id)}
                          disabled={deletingId === tx.id}
                          title="Delete transaction record"
                        >
                          &times;
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </main>
  )
}
