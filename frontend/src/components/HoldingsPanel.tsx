/**
 * Dense, sortable holdings grid built on TanStack Table.
 *
 * Each row leads with the instrument and its ninety-session trend. The grid
 * filters by asset class and by text, and a click on a row opens the holding
 * up close (see HoldingInspector). In live editable mode each row also
 * carries Trade, Edit and Delete.
 */

import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'

import {
  formatDate,
  formatMoney,
  formatMoneySigned,
  formatPercent,
  formatPercentSigned,
  formatPrice,
  formatQuantity,
  signClass,
} from '../lib/format'
import { assetClassColor } from '../lib/assetColors'
import type { Holding } from '../lib/types'
import { HoldingInspector } from './HoldingInspector'
import { Panel, Segmented } from './Panel'
import { Sparkline } from './Sparkline'

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    text: sortFn_text,
  },
})

const column = createColumnHelper<typeof features, Holding>()

/** Right-aligned monospaced cell; the default for every figure in the grid. */
function Num({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={tone ? `num ${tone}` : 'num'}>{children}</span>
}

/** Functional sort affordance - direction only, no decorative iconography. */
function SortCaret({ direction }: { direction: false | 'asc' | 'desc' }) {
  if (!direction) return null
  return (
    <svg className="grid__caret" width="7" height="4" viewBox="0 0 7 4" aria-hidden="true">
      <path d={direction === 'asc' ? 'M0 4 L3.5 0 L7 4 Z' : 'M0 0 L3.5 4 L7 0 Z'} fill="currentColor" />
    </svg>
  )
}

interface HoldingsPanelProps {
  holdings: Holding[]
  totalValue: number
  currency: string
  editable?: boolean
  onAddPosition?: () => void
  onEditHolding?: (holding: Holding) => void
  onDeleteHolding?: (holding: Holding) => void
  onOpenTradeModal?: (ticker?: string, type?: 'BUY' | 'SELL') => void
}

export function HoldingsPanel({
  holdings,
  totalValue,
  currency,
  editable = false,
  onAddPosition,
  onEditHolding,
  onDeleteHolding,
  onOpenTradeModal,
}: HoldingsPanelProps) {
  const [filterQuery, setFilterQuery] = useState('')
  const [assetClass, setAssetClass] = useState('all')
  const [inspected, setInspected] = useState<Holding | null>(null)

  // One filter per asset class the portfolio actually holds, largest first.
  const classOptions = useMemo(() => {
    const counts = new Map<string, number>()
    holdings.forEach((holding) => counts.set(holding.asset_class, (counts.get(holding.asset_class) ?? 0) + 1))
    return [
      { value: 'all', label: `All (${holdings.length})` },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({ value: key, label: `${key} (${count})` })),
    ]
  }, [holdings])

  // A filter for a class that is no longer held falls back to everything.
  const activeClass = classOptions.some((option) => option.value === assetClass) ? assetClass : 'all'

  const filteredHoldings = useMemo(() => {
    const q = filterQuery.trim().toLowerCase()
    return holdings.filter(
      (h) =>
        (activeClass === 'all' || h.asset_class === activeClass) &&
        (!q ||
          h.ticker.toLowerCase().includes(q) ||
          h.name.toLowerCase().includes(q) ||
          h.asset_class.toLowerCase().includes(q) ||
          (h.region && h.region.toLowerCase().includes(q))),
    )
  }, [holdings, filterQuery, activeClass])

  const tableColumns = useMemo(
    () =>
      column.columns([
        column.accessor('ticker', {
          header: 'Instrument',
          sortFn: 'text',
          cell: (info) => (
            <span className="grid__ticker-cell">
              <span
                className="grid__mark"
                style={{ background: assetClassColor(info.row.original.asset_class) }}
                aria-hidden="true"
              >
                {info.getValue().replace(/[.-].*$/, '').slice(0, 4)}
              </span>
              <span className="grid__instrument">
                <span className="num grid__ticker">{info.getValue()}</span>
                <span className="grid__name">
                  {info.row.original.name} · <span className="grid__class">{info.row.original.asset_class}</span>
                </span>
              </span>
            </span>
          ),
        }),
        column.display({
          id: 'sparkline',
          header: '90D trend',
          cell: (info) => (
            <Sparkline
              values={info.row.original.sparkline}
              width={96}
              height={28}
              strokeWidth={1.75}
              ariaLabel={`${info.row.original.ticker} price over the last 90 trading days`}
            />
          ),
        }),
        column.accessor('region', {
          header: 'Region',
          sortFn: 'text',
          cell: (info) => <span className="grid__tag">{info.getValue() ?? '—'}</span>,
        }),
        column.accessor('acquired', {
          header: 'Acquired',
          sortFn: 'text',
          cell: (info) => <span className="num grid__date">{formatDate(info.getValue())}</span>,
        }),
        column.accessor('quantity', {
          header: 'Quantity',
          sortFn: 'basic',
          meta: { align: 'right' },
          cell: (info) => <Num>{formatQuantity(info.getValue())}</Num>,
        }),
        // The price is shown as it is quoted (Bitcoin in USD), with the
        // currency written beside it. Shown converted alone, a USD price in an
        // AED portfolio read as if the asset cost 3.67 times as much.
        column.accessor('price_native', {
          header: 'Price',
          sortFn: 'basic',
          meta: { align: 'right' },
          cell: (info) => {
            const holding = info.row.original
            const converted = holding.currency !== currency
            return (
              <span className="grid__price">
                <span className="num">{formatPrice(info.getValue(), holding.currency)}</span>
                {converted ? (
                  <span className="grid__price-base num" title={`Converted to ${currency} at today's rate`}>
                    {formatPrice(holding.price_base, currency)}
                  </span>
                ) : null}
              </span>
            )
          },
        }),
        column.accessor('value_base', {
          header: `Value (${currency})`,
          sortFn: 'basic',
          meta: { align: 'right' },
          cell: (info) => <Num tone="grid__strong">{formatMoney(info.getValue())}</Num>,
        }),
        column.accessor('allocation_pct', {
          header: 'Weight',
          sortFn: 'basic',
          meta: { align: 'right' },
          cell: (info) => {
            const weight = info.getValue()
            const heaviest = info.table.options.data.reduce(
              (max, holding) => Math.max(max, holding.allocation_pct),
              0,
            )
            const share = heaviest > 0 ? (weight / heaviest) * 100 : 0
            return (
              <span className="grid__weight">
                <span className="num">{formatPercent(weight, 1)}</span>
                <span className="grid__weight-track" aria-hidden="true">
                  <span
                    className="grid__weight-bar"
                    style={{ width: `${share}%`, background: assetClassColor(info.row.original.asset_class) }}
                  />
                </span>
              </span>
            )
          },
        }),
        column.accessor('unrealized_pnl', {
          header: `Unrealised (${currency})`,
          sortFn: 'basic',
          meta: { align: 'right' },
          cell: (info) => (
            <Num tone={signClass(info.getValue())}>{formatMoneySigned(info.getValue())}</Num>
          ),
        }),
        column.accessor('unrealized_pnl_pct', {
          header: 'P&L %',
          sortFn: 'basic',
          meta: { align: 'right' },
          cell: (info) => (
            <Num tone={signClass(info.getValue())}>{formatPercentSigned(info.getValue())}</Num>
          ),
        }),
        column.accessor('day_change_pct', {
          header: 'Day',
          sortFn: 'basic',
          meta: { align: 'right' },
          cell: (info) => (
            <Num tone={signClass(info.getValue())}>{formatPercentSigned(info.getValue())}</Num>
          ),
        }),
        column.display({
          id: 'actions',
          header: 'Actions',
          meta: { align: 'right' },
          cell: (info) =>
            editable ? (
              // The row itself opens the holding; its buttons do their own thing.
              <div className="grid__actions" onClick={(event) => event.stopPropagation()}>
                {onOpenTradeModal && (
                  <button
                    type="button"
                    className="button button--quiet button--mini"
                    onClick={() => onOpenTradeModal(info.row.original.ticker)}
                    title={`Trade ${info.row.original.ticker}`}
                  >
                    Trade
                  </button>
                )}
                {onEditHolding && (
                  <button
                    type="button"
                    className="button button--quiet button--mini"
                    onClick={() => onEditHolding(info.row.original)}
                    title={`Edit ${info.row.original.ticker}`}
                  >
                    Edit
                  </button>
                )}
                {onDeleteHolding && (
                  <button
                    type="button"
                    className="button button--danger-text button--mini"
                    onClick={() => onDeleteHolding(info.row.original)}
                    title={`Delete ${info.row.original.ticker}`}
                  >
                    &times;
                  </button>
                )}
              </div>
            ) : null,
        }),
      ]),
    [editable, onEditHolding, onDeleteHolding, onOpenTradeModal, currency],
  )

  const table = useTable({
    features,
    columns: tableColumns,
    data: filteredHoldings,
    initialState: { sorting: [{ id: 'value_base', desc: true }] },
  })

  const totalPnl = useMemo(
    () => holdings.reduce((sum, holding) => sum + holding.unrealized_pnl, 0),
    [holdings],
  )

  const largest = holdings.reduce<Holding | null>(
    (top, holding) => (top === null || holding.value_base > top.value_base ? holding : top),
    null,
  )

  return (
    <Panel
      title="Holdings"
      subtitle={
        largest
          ? `${holdings.length} positions · largest is ${largest.name} at ${formatPercent(largest.allocation_pct, 1)} · values in ${currency}`
          : `No positions · values in ${currency}`
      }
      actions={
        editable ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            {onOpenTradeModal && (
              <button
                type="button"
                className="button button--primary button--sm"
                onClick={() => onOpenTradeModal()}
                title="Execute a trade order"
              >
                + Trade Order
              </button>
            )}
            {onAddPosition && (
              <button
                type="button"
                className="button button--quiet button--sm"
                onClick={onAddPosition}
                title="Add a new position manually"
              >
                + Add Asset
              </button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="holdings-toolbar">
        <div className="holdings-toolbar__search">
          <input
            className="holdings-toolbar__input"
            type="search"
            placeholder="Filter holdings by ticker or name..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
          {filterQuery && (
            <button
              type="button"
              className="button button--quiet button--mini"
              onClick={() => setFilterQuery('')}
            >
              Clear
            </button>
          )}
        </div>
        {classOptions.length > 2 ? (
          <Segmented options={classOptions} value={activeClass} onChange={setAssetClass} ariaLabel="Asset class" />
        ) : null}
        <div className="holdings-toolbar__meta">
          <span className="panel__subtitle">
            Showing {filteredHoldings.length} of {holdings.length} positions · click one to see it up close
          </span>
        </div>
      </div>

      <div className="grid__scroll">
        <table className="grid">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const align = (header.column.columnDef.meta as { align?: string } | undefined)?.align
                  const sorted = header.column.getIsSorted()
                  const sortable = header.column.getCanSort()
                  return (
                    <th
                      key={header.id}
                      data-column={header.column.id}
                      className={align === 'right' ? 'grid__th grid__th--right' : 'grid__th'}
                      aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className="grid__sort"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <table.FlexRender header={header} />
                          <SortCaret direction={sorted} />
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="grid__row grid__row--open"
                tabIndex={0}
                aria-label={`${row.original.ticker}, ${row.original.name}: open the details`}
                onClick={() => setInspected(row.original)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setInspected(row.original)
                  }
                }}
              >
                {row.getAllCells().map((cell) => {
                  const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align
                  return (
                    <td
                      key={cell.id}
                      data-column={cell.column.id}
                      className={align === 'right' ? 'grid__td grid__td--right' : 'grid__td'}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="grid__total">
              <td className="grid__td" colSpan={6}>
                {filteredHoldings.length === holdings.length ? 'Total' : 'Total, all positions'}
              </td>
              <td className="grid__td grid__td--right">
                <Num tone="grid__strong">{formatMoney(totalValue)}</Num>
              </td>
              <td className="grid__td grid__td--right">
                <Num>{formatPercent(1, 1)}</Num>
              </td>
              <td className="grid__td grid__td--right">
                <Num tone={signClass(totalPnl)}>{formatMoneySigned(totalPnl)}</Num>
              </td>
              <td className="grid__td" colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>

      <HoldingInspector
        holding={inspected}
        totalValue={totalValue}
        currency={currency}
        onClose={() => setInspected(null)}
        onTrade={
          editable && onOpenTradeModal
            ? (ticker) => {
                setInspected(null)
                onOpenTradeModal(ticker)
              }
            : undefined
        }
        onEdit={
          editable && onEditHolding
            ? (holding) => {
                setInspected(null)
                onEditHolding(holding)
              }
            : undefined
        }
      />
    </Panel>
  )
}
