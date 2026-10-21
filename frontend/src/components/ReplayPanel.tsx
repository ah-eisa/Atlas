/**
 * Stress replay: the current positions over a past window.
 *
 * The question this answers is the one people actually ask - "if I had this
 * portfolio in that crash, what would it have done?" - and the framing is
 * stated on the panel, because it matters: today's weights are applied to
 * the prices of the chosen period. It is a stress test of the current mix,
 * not a reconstruction of what was owned at the time.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { TimeSeriesChart } from '../charts/TimeSeriesChart'
import { toLineData } from '../charts/series'
import type { SeriesSpec } from '../charts/TimeSeriesChart'
import { ApiError, fetchReplay, type DataConfig, type ReplayPayload } from '../lib/api'
import { formatDate, formatMoneyCompact, formatPercent, formatPercentSigned, signClass } from '../lib/format'
import type { HistoryPayload } from '../lib/types'
import { Panel } from './Panel'

interface ReplayPanelProps {
  config: DataConfig
  currency: string
  /** The first date the model can replay, for the custom range. */
  historyStart?: string
  /**
   * The full history. In snapshot mode there is no live endpoint to ask, so
   * the window is cut out of the committed series instead - the same
   * numbers, from the same data.
   */
  history?: HistoryPayload
}

type WindowKey = '3m' | '6m' | '12m' | 'all'

const WINDOWS: { key: WindowKey; label: string; months: number | null }[] = [
  { key: '3m', label: '3M', months: 3 },
  { key: '6m', label: '6M', months: 6 },
  { key: '12m', label: '12M', months: 12 },
  { key: 'all', label: 'All', months: null },
]

const NOTIONAL = 100_000

function startFor(window: WindowKey): string | undefined {
  const months = WINDOWS.find((item) => item.key === window)?.months
  if (months === null || months === undefined) return undefined
  const date = new Date()
  date.setMonth(date.getMonth() - months)
  return date.toISOString().slice(0, 10)
}

/** Cut a window out of the committed history and scale it to a notional. */
function replayFromHistory(
  history: HistoryPayload,
  start: string | undefined,
  end: string | undefined,
  notional: number,
): ReplayPayload | null {
  const from = start ? new Date(`${start}T00:00:00Z`).getTime() : -Infinity
  const to = end ? new Date(`${end}T00:00:00Z`).getTime() : Infinity
  const indices = history.dates
    .map((date, index) => ({ date, index, time: new Date(`${date}T00:00:00Z`).getTime() }))
    .filter((item) => item.time >= from && item.time <= to)
    .map((item) => item.index)
  if (indices.length < 2) return null

  const first = indices[0]
  const base = history.portfolio[first] || 1
  const portfolio = indices.map((index) => (history.portfolio[index] / base) * notional)
  const benchmark = indices.map((index) => (history.benchmark_rebased[index] / base) * notional)

  let peak = -Infinity
  let maxDrawdown = 0
  const drawdown = portfolio.map((value) => {
    peak = Math.max(peak, value)
    const dd = value / peak - 1
    maxDrawdown = Math.min(maxDrawdown, dd)
    return dd
  })

  const returns = portfolio.slice(1).map((value, index) => value / portfolio[index] - 1)
  const mean = returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1)
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length || 1)
  const worstIndex = returns.indexOf(Math.min(...returns))
  const bestIndex = returns.indexOf(Math.max(...returns))

  return {
    as_of: history.as_of,
    base_currency: history.base_currency,
    start_date: history.dates[indices[0]],
    end_date: history.dates[indices[indices.length - 1]],
    notional,
    dates: indices.map((index) => history.dates[index]),
    portfolio,
    benchmark,
    drawdown_pct: drawdown,
    return_pct: portfolio[portfolio.length - 1] / portfolio[0] - 1,
    annualized_return_pct: null,
    volatility_annualized_pct: Math.sqrt(variance * 252),
    max_drawdown: { pct: maxDrawdown, peak_date: null, trough_date: null },
    best_day: {
      date: bestIndex >= 0 ? history.dates[indices[bestIndex + 1]] : null,
      pct: bestIndex >= 0 ? returns[bestIndex] : null,
    },
    worst_day: {
      date: worstIndex >= 0 ? history.dates[indices[worstIndex + 1]] : null,
      pct: worstIndex >= 0 ? returns[worstIndex] : null,
    },
    observations: returns.length,
  }
}

export function ReplayPanel({ config, currency, historyStart, history }: ReplayPanelProps) {
  const [window, setWindow] = useState<WindowKey>('6m')
  const [customStart, setCustomStart] = useState(historyStart ?? '')
  const [customEnd, setCustomEnd] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [payload, setPayload] = useState<ReplayPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const live = config.source === 'api'

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true)
      setError(null)
      const params = useCustom
        ? { start: customStart || undefined, end: customEnd || undefined, notional: NOTIONAL }
        : { start: startFor(window), notional: NOTIONAL }
      try {
        if (live) {
          const result = await fetchReplay(config, params, signal)
          setPayload(result)
        } else if (history) {
          // The committed snapshot has no endpoint to ask: the window is cut
          // out of the series it already carries.
          const result = replayFromHistory(history, params.start, params.end, NOTIONAL)
          if (!result) {
            setError('That window has fewer than two trading days in the committed history.')
            setPayload(null)
          } else {
            setPayload(result)
          }
        }
      } catch (cause) {
        if (signal.aborted) return
        setError(
          cause instanceof ApiError || cause instanceof Error
            ? cause.message
            : String(cause),
        )
      } finally {
        if (!signal.aborted) setLoading(false)
      }
    },
    [config, live, history, window, customStart, customEnd, useCustom],
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const series = useMemo<SeriesSpec[]>(() => {
    if (!payload) return []
    const list: SeriesSpec[] = [
      {
        id: 'portfolio',
        label: 'Portfolio',
        color: 'var(--accent)',
        data: toLineData(payload.dates, payload.portfolio),
      },
    ]
    if (payload.benchmark.length === payload.dates.length) {
      list.push({
        id: 'benchmark',
        label: 'Benchmark',
        color: 'var(--viz-benchmark)',
        lineWidth: 1,
        dashed: true,
        data: toLineData(payload.dates, payload.benchmark),
      })
    }
    return list
  }, [payload])

  return (
    <Panel
      title="Stress replay"
      subtitle={
        payload
          ? `${formatDate(payload.start_date)} – ${formatDate(payload.end_date)}`
          : 'current positions, past window'
      }
      actions={
        <div className="segmented" role="group" aria-label="Replay window">
          {WINDOWS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={
                !useCustom && window === item.key
                  ? 'segmented__option segmented__option--active'
                  : 'segmented__option'
              }
              onClick={() => {
                setUseCustom(false)
                setWindow(item.key)
              }}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            className={useCustom ? 'segmented__option segmented__option--active' : 'segmented__option'}
            onClick={() => setUseCustom(true)}
          >
            Custom
          </button>
        </div>
      }
    >
      <div className="replay">
        {useCustom ? (
          <div className="replay__custom">
            <label className="field">
              <span className="field__label">From</span>
              <input
                className="input num"
                type="date"
                value={customStart}
                min={historyStart}
                onChange={(event) => setCustomStart(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">To</span>
              <input
                className="input num"
                type="date"
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        {error ? <div className="notice notice--error">{error}</div> : null}

        {loading && !payload ? (
          <div className="replay__loading">
            <span className="spinner spinner--on" aria-hidden="true" />
            <span>Rebuilding the window</span>
          </div>
        ) : null}

        {payload ? (
          <>
            <div className="replay__figures">
              <div className="replay__figure">
                <span className="replay__label">Return</span>
                <span className={`num replay__value ${signClass(payload.return_pct)}`}>
                  {formatPercentSigned(payload.return_pct)}
                </span>
              </div>
              <div className="replay__figure">
                <span className="replay__label">Max drawdown</span>
                <span className={`num replay__value ${signClass(payload.max_drawdown.pct)}`}>
                  {formatPercent(payload.max_drawdown.pct)}
                </span>
              </div>
              <div className="replay__figure">
                <span className="replay__label">Volatility</span>
                <span className="num replay__value">{formatPercent(payload.volatility_annualized_pct)}</span>
              </div>
              <div className="replay__figure">
                <span className="replay__label">Worst day</span>
                <span className={`num replay__value ${signClass(payload.worst_day.pct)}`}>
                  {formatPercentSigned(payload.worst_day.pct)}
                </span>
                <span className="replay__context">
                  {payload.worst_day.date ? formatDate(payload.worst_day.date) : '—'}
                </span>
              </div>
              <div className="replay__figure">
                <span className="replay__label">Notional</span>
                <span className="num replay__value">
                  {formatMoneyCompact(payload.notional)} {currency}
                </span>
              </div>
            </div>

            <TimeSeriesChart
              series={series}
              height={220}
              valueFormatter={(value) => formatMoneyCompact(value)}
              ariaLabel="Portfolio and benchmark over the replay window"
            />
          </>
        ) : null}

        <p className="replay__note">
          This applies today&apos;s weights to the prices of the chosen period. It is a
          stress test of the current mix, not a reconstruction of what was held at the
          time, and it says nothing about the positions you would have added or removed
          in between.
        </p>
      </div>
    </Panel>
  )
}
