/**
 * Equity curve with range and view toggles, plus a hairline-divided readout of
 * period changes underneath.
 *
 * Three views answer three different questions from the same series:
 *   Value     - what is it worth, against the benchmark rebased to the same start
 *   Return    - how much has it grown since the start of the selected range
 *   Drawdown  - how far below its all-time peak is it, right now
 */

import { useMemo, useState } from 'react'

import { toLineData } from '../charts/series'
import { chartTheme } from '../charts/theme'
import { TimeSeriesChart, type CrosshairState, type SeriesSpec } from '../charts/TimeSeriesChart'
import {
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatMoneySigned,
  formatPercent,
  formatPercentSigned,
  PERIOD_LABELS,
  signClass,
} from '../lib/format'
import { MOTION } from '../lib/motion'
import type { HistoryPayload, PeriodKey, ReturnsPayload, SummaryPayload } from '../lib/types'
import { Panel, Segmented } from './Panel'

type Range = '1w' | '1m' | 'ytd' | 'all'
type View = 'growth' | 'return' | 'drawdown'

const RANGES = [
  { value: '1w' as const, label: '1W' },
  { value: '1m' as const, label: '1M' },
  { value: 'ytd' as const, label: 'YTD' },
  { value: 'all' as const, label: 'All' },
]

const VIEWS = [
  { value: 'growth' as const, label: 'Growth' },
  { value: 'return' as const, label: 'Return' },
  { value: 'drawdown' as const, label: 'Drawdown' },
]

const READOUT_PERIODS: PeriodKey[] = ['day', 'week', 'month', 'ytd', 'all']

/**
 * First index within the selected range.
 *
 * Dates are compared as ISO strings, which sort chronologically, so no Date
 * objects are constructed per comparison.
 */
function rangeStartIndex(dates: string[], range: Range): number {
  if (range === 'all' || dates.length === 0) return 0

  const last = dates[dates.length - 1]
  let cutoff: string

  if (range === 'ytd') {
    cutoff = `${last.slice(0, 4)}-01-01`
  } else {
    const date = new Date(`${last}T00:00:00Z`)
    if (range === '1w') date.setUTCDate(date.getUTCDate() - 7)
    else date.setUTCMonth(date.getUTCMonth() - 1)
    cutoff = date.toISOString().slice(0, 10)
  }

  const index = dates.findIndex((day) => day >= cutoff)
  return index === -1 ? 0 : index
}

/** Growth of a series relative to its first value in the window, as a fraction. */
function rebaseToReturn(values: number[]): number[] {
  const base = values[0]
  if (!base) return values.map(() => 0)
  return values.map((value) => value / base - 1)
}

interface PerformancePanelProps {
  history: HistoryPayload
  summary: SummaryPayload
  returns: ReturnsPayload
  currency: string
}

export function PerformancePanel({ history, summary, returns, currency }: PerformancePanelProps) {
  const [range, setRange] = useState<Range>('all')
  const [view, setView] = useState<View>('growth')
  const [crosshair, setCrosshair] = useState<CrosshairState | null>(null)
  const theme = chartTheme()

  const series = useMemo<SeriesSpec[]>(() => {
    const start = rangeStartIndex(history.dates, range)
    const dates = history.dates.slice(start)
    const portfolio = history.portfolio.slice(start)
    const benchmark = history.benchmark_rebased.slice(start)

    if (view === 'drawdown') {
      return [
        {
          id: 'drawdown',
          label: 'Drawdown',
          color: theme.negative,
          lineWidth: 1,
          data: toLineData(dates, history.drawdown_pct.slice(start)),
        },
      ]
    }

    if (view === 'return') {
      return [
        {
          id: 'portfolio',
          label: 'Portfolio',
          color: theme.accent,
          data: toLineData(dates, rebaseToReturn(portfolio)),
        },
        {
          id: 'benchmark',
          label: history.benchmark_name,
          color: theme.benchmark,
          lineWidth: 1,
          dashed: true,
          data: toLineData(dates, rebaseToReturn(benchmark)),
        },
      ]
    }

    return [
      {
        id: 'portfolio',
        label: 'Portfolio',
        color: theme.accent,
        data: toLineData(dates, portfolio),
      },
      {
        id: 'benchmark',
        label: history.benchmark_name,
        color: theme.benchmark,
        lineWidth: 1,
        dashed: true,
        data: toLineData(dates, benchmark),
      },
    ]
  }, [history, range, view, theme])

  const isPercentView = view !== 'growth'
  const valueFormatter = useMemo(
    () => (value: number) => (isPercentView ? formatPercent(value, 1) : formatMoneyCompact(value)),
    [isPercentView],
  )

  // The crosshair readout falls back to the latest point when not hovering, so
  // the row always shows something rather than flickering empty.
  const latestDate = history.dates[history.dates.length - 1]
  const readoutDate = crosshair?.time ?? latestDate

  return (
    <Panel
      title="Performance"
      subtitle={
        view === 'growth' ? `${currency} growth index` : view === 'drawdown' ? 'percent below peak' : 'percent'
      }
      actions={
        <>
          <Segmented options={VIEWS} value={view} onChange={setView} ariaLabel="Chart view" />
          <Segmented options={RANGES} value={range} onChange={setRange} ariaLabel="Date range" />
        </>
      }
    >
      <div className="performance">
        <div className="performance__legend">
          <span className="performance__date num">{formatDate(readoutDate)}</span>
          {series.map((spec) => {
            const value = crosshair?.values[spec.id]
            const latest = spec.data[spec.data.length - 1]?.value
            const shown = value ?? latest
            return (
              <span key={spec.id} className="performance__legend-item">
                <span
                  className="performance__legend-key"
                  style={{ background: spec.color }}
                  aria-hidden="true"
                />
                <span className="performance__legend-label">{spec.label}</span>
                <span className="num performance__legend-value">
                  {view === 'drawdown'
                    ? formatPercent(shown)
                    : isPercentView
                      ? formatPercentSigned(shown)
                      : formatMoney(shown)}
                </span>
              </span>
            )
          })}
        </div>

        <TimeSeriesChart
          series={series}
          height={280}
          revealOnMount
          revealDelay={MOTION.stagger * 2}
          valueFormatter={valueFormatter}
          onCrosshair={setCrosshair}
          baselineValue={isPercentView ? 0 : undefined}
          ariaLabel={`Portfolio ${view} over ${range === 'all' ? 'the full history' : range}`}
        />

        <div className="performance__readout">
          {READOUT_PERIODS.map((period) => {
            const change = summary.changes[period]
            return (
              <div key={period} className="performance__cell">
                <span className="performance__cell-label">{PERIOD_LABELS[period]}</span>
                <span className={`num performance__cell-value ${signClass(change.pct)}`}>
                  {formatPercentSigned(change.pct)}
                </span>
                <span className={`num performance__cell-sub ${signClass(change.absolute)}`}>
                  {formatMoneySigned(change.absolute)}
                </span>
              </div>
            )
          })}
        </div>

        <div className="performance__stats">
          <span>
            <span className="performance__stat-label">Observations</span>
            <span className="num">{returns.observations}</span>
          </span>
          <span>
            <span className="performance__stat-label">Positive days</span>
            <span className="num">{formatPercent(returns.hit_rate_pct, 1)}</span>
          </span>
          <span>
            <span className="performance__stat-label">Best day</span>
            <span className="num pos">{formatPercentSigned(returns.best_day.pct)}</span>
            <span className="num muted">{formatDate(returns.best_day.date)}</span>
          </span>
          <span>
            <span className="performance__stat-label">Worst day</span>
            <span className="num neg">{formatPercentSigned(returns.worst_day.pct)}</span>
            <span className="num muted">{formatDate(returns.worst_day.date)}</span>
          </span>
        </div>

        {summary.changes.all.flows !== 0 ? (
          <div className="performance__flows">
            <span>
              Money you added or withdrew is not counted as return. Net added this year{' '}
              <span className="num">{formatMoneySigned(summary.changes.ytd.flows)}</span>, since
              the start <span className="num">{formatMoneySigned(summary.changes.all.flows)}</span>.
            </span>
          </div>
        ) : null}
      </div>
    </Panel>
  )
}
