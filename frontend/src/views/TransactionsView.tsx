/**
 * The ledger: every trade, dividend, charge, corporate action, conversion and
 * hand edit, with what they add up to.
 *
 * The positions are rebuilt from these entries, so this is the book of
 * record. Across the top: the realised result, the net income, the charges
 * and the cash the portfolio holds. Below: income and charges by year, the
 * cash by currency, and the entries themselves, newest first, filterable by
 * kind. Deleting an entry rebuilds the positions without it; one that a later
 * entry depends on is refused, with the reason.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { AnimatedNumber } from '../components/AnimatedNumber'
import { LedgerEventModal } from '../components/LedgerEventModal'
import { Panel, Segmented } from '../components/Panel'
import {
  deleteLedgerEvent,
  deleteTransaction,
  getRealizedPnlSummary,
  listLedgerEvents,
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
  LedgerEvent,
  LedgerReport,
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

type Filter = 'all' | 'trades' | 'income' | 'charges' | 'actions' | 'cash' | 'edits'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'trades', label: 'Trades' },
  { value: 'income', label: 'Income' },
  { value: 'charges', label: 'Charges' },
  { value: 'actions', label: 'Corporate actions' },
  { value: 'cash', label: 'Conversions' },
  { value: 'edits', label: 'Hand edits' },
]

const KIND_LABELS: Record<string, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  FEE: 'Fee',
  TAX: 'Tax',
  SPLIT: 'Split',
  SYMBOL_CHANGE: 'Symbol change',
  SPINOFF: 'Spin-off',
  RETURN_OF_CAPITAL: 'Return of capital',
  FX: 'Conversion',
  ADJUSTMENT: 'Hand edit',
}

const KIND_FILTER: Record<string, Filter> = {
  BUY: 'trades',
  SELL: 'trades',
  DIVIDEND: 'income',
  RETURN_OF_CAPITAL: 'income',
  FEE: 'charges',
  TAX: 'charges',
  SPLIT: 'actions',
  SYMBOL_CHANGE: 'actions',
  SPINOFF: 'actions',
  FX: 'cash',
  ADJUSTMENT: 'edits',
}

/** One row of the ledger, whichever table it came from. */
interface Entry {
  key: string
  source: 'trade' | 'event'
  id: number
  kind: string
  date: string
  ticker: string | null
  detail: string
  /** Signed cash effect, in ``currency``; null for a corporate action. */
  cash: number | null
  currency: string | null
  realized: number | null
  note: string
  superseded: boolean
  deletable: boolean
}

function splitLabel(ratio: number): string {
  if (ratio >= 1) return `${formatQuantity(ratio)}-for-1`
  return `1-for-${formatQuantity(1 / ratio)}`
}

function tradeEntry(tx: Transaction): Entry {
  const fee = tx.fee ?? 0
  const tax = tx.tax ?? 0
  const gross = tx.quantity * tx.price
  const charges = [fee ? `fee ${formatMoney(fee)}` : '', tax ? `tax ${formatMoney(tax)}` : ''].filter(Boolean)
  return {
    key: `tx:${tx.id}`,
    source: 'trade',
    id: tx.id,
    kind: tx.order_type,
    date: tx.executed_at.slice(0, 10),
    ticker: tx.ticker,
    detail: `${formatQuantity(tx.quantity)} at ${formatMoney(tx.price)}${charges.length ? ` · ${charges.join(', ')}` : ''}`,
    cash: tx.order_type === 'BUY' ? -(gross + fee + tax) : gross - fee - tax,
    currency: tx.currency ?? null,
    realized: tx.order_type === 'SELL' ? tx.realized_pnl : null,
    note: tx.notes,
    superseded: tx.superseded ?? false,
    deletable: true,
  }
}

function eventEntry(event: LedgerEvent): Entry {
  const currency = event.currency
  let detail = ''
  let cash: number | null = null
  switch (event.kind) {
    case 'DIVIDEND':
      detail = `${formatMoney(event.amount)} gross${event.tax ? ` · ${formatMoney(event.tax)} withheld` : ''}`
      cash = event.amount - event.tax
      break
    case 'FEE':
    case 'TAX':
      detail = formatMoney(event.amount)
      cash = -event.amount
      break
    case 'RETURN_OF_CAPITAL':
      detail = `${formatMoney(event.amount)} returned`
      cash = event.amount
      break
    case 'SPLIT':
      detail = splitLabel(event.ratio)
      break
    case 'SYMBOL_CHANGE':
      detail = `Now ${event.new_ticker}${event.ratio !== 1 ? `, ${formatQuantity(event.ratio)} per unit` : ''}`
      break
    case 'SPINOFF':
      detail = `${formatQuantity(event.ratio)} ${event.new_ticker} per unit · ${formatPercent(event.cost_fraction, 1)} of the cost`
      break
    case 'FX':
      detail = `${formatMoney(event.amount)} ${event.currency} → ${formatMoney(event.to_amount)} ${event.to_currency}${event.fee ? ` · fee ${formatMoney(event.fee)}` : ''}`
      cash = -(event.amount + event.fee)
      break
    case 'ADJUSTMENT':
      detail =
        event.quantity > 0
          ? `Set to ${formatQuantity(event.quantity)} at ${formatMoney(event.price)}`
          : 'Removed from the portfolio'
      break
  }
  return {
    key: `ev:${event.id}`,
    source: 'event',
    id: event.id,
    kind: event.kind,
    date: event.occurred_on.slice(0, 10),
    ticker: event.ticker,
    detail,
    cash,
    currency,
    realized: null,
    note: event.note,
    superseded: event.superseded,
    deletable: event.kind !== 'ADJUSTMENT',
  }
}

const SOURCE_NOTES: Record<LedgerReport['dividends_source'], string> = {
  market: 'Dividends come from the market data, at the units held on each ex-date; any you record replace them.',
  recorded: 'Dividends are the ones recorded here.',
  in_prices:
    'These prices already include dividends (an older price cache), so dividends are not added as cash until prices are refreshed.',
  none: 'No dividends were paid in this period.',
}

export default function TransactionsView({ state, config, onReload, onOpenTradeModal }: TransactionsViewProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [events, setEvents] = useState<LedgerEvent[]>([])
  const [summary, setSummary] = useState<RealizedPnlSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)

  const isLive = state.source === 'api'
  const currency = state.baseCurrency || 'USD'
  const report = state.analytics?.summary?.ledger ?? null

  const loadData = useCallback(async () => {
    if (!isLive) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [txs, recorded, pnl] = await Promise.all([
        listTransactions(config),
        listLedgerEvents(config),
        getRealizedPnlSummary(config),
      ])
      setTransactions(txs)
      setEvents(recorded)
      setSummary(pnl)
    } catch {
      // The panels say plainly that nothing is recorded; the error banner
      // of the shell reports a connection problem.
    } finally {
      setLoading(false)
    }
  }, [config, isLive])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const entries = useMemo(
    () =>
      [...transactions.map(tradeEntry), ...events.map(eventEntry)].sort(
        (a, b) => b.date.localeCompare(a.date) || b.key.localeCompare(a.key),
      ),
    [transactions, events],
  )

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(
      (entry) =>
        (filter === 'all' || KIND_FILTER[entry.kind] === filter) &&
        (!q || (entry.ticker ?? '').toLowerCase().includes(q) || entry.note.toLowerCase().includes(q)),
    )
  }, [entries, filter, search])

  const handleDelete = async (entry: Entry) => {
    const what = KIND_LABELS[entry.kind]?.toLowerCase() ?? 'entry'
    if (!confirm(`Delete this ${what}? The positions are rebuilt without it.`)) return
    setDeleting(entry.key)
    setDeleteError(null)
    try {
      if (entry.source === 'trade') await deleteTransaction(config, entry.id)
      else await deleteLedgerEvent(config, entry.id)
      await loadData()
      onReload()
    } catch (err) {
      // An entry a later one depends on cannot be removed (409).
      setDeleteError(err instanceof Error ? err.message : 'The entry could not be deleted.')
    } finally {
      setDeleting(null)
    }
  }

  const handleSaved = () => {
    void loadData()
    onReload()
  }

  if (!isLive) {
    return (
      <main className="app__main">
        <Panel title="Ledger" subtitle="Snapshot mode">
          <div className="state state--inline">
            <span className="state__kicker">Demo snapshot mode</span>
            <span className="state__title">The ledger is available in Live API mode</span>
            <p className="state__detail">
              Switch to Live API mode to record trades, dividends, fees, taxes, corporate actions and
              currency conversions.
            </p>
          </div>
        </Panel>
      </main>
    )
  }

  const realized = report?.realized ?? summary?.total_realized_pnl ?? 0
  const charges = report ? report.fees + report.taxes + report.withholding : (summary?.total_fees ?? 0)

  return (
    <main className="app__main">
      {deleteError && (
        <div className="banner banner--error" role="alert">
          <span className="banner__label">Not deleted</span>
          <span className="banner__message">{deleteError}</span>
        </div>
      )}

      <section className="kpi-band" aria-label="What the ledger adds up to">
        <div className="kpi__cell">
          <span className="kpi__label">Realised result</span>
          <span className={`num kpi__value ${signClass(realized)}`}>
            <AnimatedNumber value={realized} format={formatMoneySigned} /> <span className="kpi__unit">{currency}</span>
          </span>
          <span className="kpi__sub">
            {summary?.total_sells ?? 0} sales · {summary?.winning_trades ?? 0} with a gain
            {summary?.win_rate_pct != null ? ` (${formatPercent(summary.win_rate_pct, 0)})` : ''}
          </span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">Net income</span>
          <span className={`num kpi__value ${signClass(report?.net_income ?? 0)}`}>
            <AnimatedNumber value={report?.net_income ?? 0} format={formatMoneySigned} />{' '}
            <span className="kpi__unit">{currency}</span>
          </span>
          <span className="kpi__sub">
            {formatMoney(report?.dividends ?? 0)} in dividends, less what was withheld and charged
          </span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">Fees and taxes</span>
          <span className="num kpi__value">
            <AnimatedNumber value={charges} format={formatMoney} /> <span className="kpi__unit">{currency}</span>
          </span>
          <span className="kpi__sub">
            Fees {formatMoney(report?.fees ?? summary?.total_fees ?? 0)} · taxes{' '}
            {formatMoney((report?.taxes ?? 0) + (report?.withholding ?? 0))}
          </span>
        </div>

        <div className="kpi__cell">
          <span className="kpi__label">Cash held</span>
          <span className="num kpi__value">
            <AnimatedNumber value={report?.cash_value ?? 0} format={formatMoney} />{' '}
            <span className="kpi__unit">{currency}</span>
          </span>
          <span className="kpi__sub">From sales and income, until spent or withdrawn</span>
        </div>
      </section>

      {report ? (
        <div className="row row--split">
          <Panel title="Income and charges" subtitle={`by year, in ${currency}`}>
            <div className="grid__scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th className="grid__th">Year</th>
                    <th className="grid__th grid__th--right">Dividends</th>
                    <th className="grid__th grid__th--right">Withheld</th>
                    <th className="grid__th grid__th--right">Fees</th>
                    <th className="grid__th grid__th--right">Taxes</th>
                    <th className="grid__th grid__th--right">Realised</th>
                  </tr>
                </thead>
                <tbody>
                  {report.by_year.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="grid__td ledger__empty">
                        Nothing earned or charged yet.
                      </td>
                    </tr>
                  ) : (
                    [...report.by_year].reverse().map((row) => (
                      <tr key={row.year} className="grid__row">
                        <td className="grid__td num grid__strong">{row.year}</td>
                        <td className="grid__td grid__td--right num pos">{formatMoney(row.dividends)}</td>
                        <td className="grid__td grid__td--right num">{formatMoney(row.withholding)}</td>
                        <td className="grid__td grid__td--right num">{formatMoney(row.fees)}</td>
                        <td className="grid__td grid__td--right num">{formatMoney(row.taxes)}</td>
                        <td className={`grid__td grid__td--right num ${signClass(row.realized)}`}>
                          {formatMoneySigned(row.realized)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="panel-note">{SOURCE_NOTES[report.dividends_source]}</p>
          </Panel>

          <Panel title="Cash" subtitle="what the portfolio holds, by currency">
            <div className="ledger-cash">
              {report.cash.length === 0 ? (
                <p className="ledger__empty">No cash: every sale and dividend has been spent or withdrawn.</p>
              ) : (
                report.cash.map((balance) => (
                  <div key={balance.currency} className="ledger-cash__row">
                    <span className="ledger-cash__currency">{balance.currency}</span>
                    <span className="num ledger-cash__balance">{formatMoney(balance.balance)}</span>
                    <span className="num muted">
                      {balance.currency === currency ? '' : `${formatMoney(balance.value_base)} ${currency} · `}
                      {formatPercent(balance.allocation_pct, 1)} of the portfolio
                    </span>
                  </div>
                ))
              )}
            </div>
            <dl className="metadata ledger-cash__money">
              <div>
                <dt>Deposits less withdrawals</dt>
                <dd className="num">
                  {formatMoneySigned(report.contributions_recorded)} {currency}
                </dd>
              </div>
              <div>
                <dt>Money assumed added</dt>
                <dd className="num">
                  {formatMoney(report.contributions_assumed)} {currency}
                  <span className="metadata__sub"> for purchases cash could not pay for</span>
                </dd>
              </div>
            </dl>
          </Panel>
        </div>
      ) : null}

      <Panel
        title="Ledger"
        subtitle={`${entries.length} entries · the positions are rebuilt from them`}
        actions={
          <div className="ledger__actions">
            <button type="button" className="button button--sm" onClick={() => setRecording(true)}>
              Record income, charge or action
            </button>
            <button type="button" className="button button--primary button--sm" onClick={() => onOpenTradeModal()}>
              Trade
            </button>
          </div>
        }
      >
        <div className="holdings-toolbar">
          <div className="holdings-toolbar__search">
            <input
              className="holdings-toolbar__input"
              type="search"
              placeholder="Search by ticker or note"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Segmented options={FILTERS} value={filter} onChange={setFilter} ariaLabel="Kind of entry" />
        </div>

        <div className="grid__scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="grid__th">Date</th>
                <th className="grid__th">Entry</th>
                <th className="grid__th">Holding</th>
                <th className="grid__th">Detail</th>
                <th className="grid__th grid__th--right">Cash</th>
                <th className="grid__th grid__th--right">Realised</th>
                <th className="grid__th">Note</th>
                <th className="grid__th grid__th--right">
                  <span className="sr-only">Delete</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={8} className="grid__td ledger__empty">
                    {loading
                      ? 'Loading the ledger…'
                      : entries.length === 0
                        ? 'Nothing recorded yet. Record a trade with Trade, and income or charges with Record.'
                        : 'No entries of this kind.'}
                  </td>
                </tr>
              ) : (
                shown.map((entry) => (
                  <tr
                    key={entry.key}
                    className={entry.superseded ? 'grid__row grid__row--superseded' : 'grid__row'}
                  >
                    <td className="grid__td num">{formatDate(entry.date)}</td>
                    <td className="grid__td">
                      <span className={`ledger-kind ledger-kind--${KIND_FILTER[entry.kind] ?? 'other'} ledger-kind--${entry.kind.toLowerCase()}`}>
                        {KIND_LABELS[entry.kind] ?? entry.kind}
                      </span>
                      {entry.superseded ? (
                        <span className="ledger__superseded" title="A later hand edit of this position replaced it">
                          replaced
                        </span>
                      ) : null}
                    </td>
                    <td className="grid__td num grid__ticker">{entry.ticker ?? '—'}</td>
                    <td className="grid__td num">{entry.detail}</td>
                    <td className={`grid__td grid__td--right num ${entry.cash !== null ? signClass(entry.cash) : ''}`}>
                      {entry.cash !== null ? (
                        <>
                          {formatMoneySigned(entry.cash)}
                          {entry.currency ? <span className="ledger__currency"> {entry.currency}</span> : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={`grid__td grid__td--right num ${entry.realized !== null ? signClass(entry.realized) : ''}`}>
                      {entry.realized !== null ? formatMoneySigned(entry.realized) : '—'}
                    </td>
                    <td className="grid__td panel__subtitle">{entry.note || '—'}</td>
                    <td className="grid__td grid__td--right">
                      {entry.deletable ? (
                        <button
                          type="button"
                          className="button button--danger-text button--mini"
                          onClick={() => void handleDelete(entry)}
                          disabled={deleting === entry.key}
                          aria-label={`Delete this ${KIND_LABELS[entry.kind]?.toLowerCase() ?? 'entry'}`}
                        >
                          &times;
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <LedgerEventModal
        isOpen={recording}
        positions={state.positions}
        config={config}
        baseCurrency={currency}
        onClose={() => setRecording(false)}
        onSaved={handleSaved}
      />
    </main>
  )
}
