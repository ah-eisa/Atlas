/**
 * Benchmark comparison.
 *
 * The performance chart already overlays the benchmark. This panel answers the
 * next question: *is the difference skill, style, or simply more risk?* It keeps
 * the regression statistics (alpha, beta, tracking error) next to the capture
 * ratios and the benchmark's own drawdown, each with its convention stated.
 */

import { useState } from 'react'

import { fetchBenchmark, type DataConfig, type BenchmarkComparison } from '../lib/api'
import {
  EM_DASH,
  formatPercent,
  formatPercentSigned,
  formatRatio,
  signClass,
} from '../lib/format'
import type { RiskPayload } from '../lib/types'
import { Panel } from './Panel'

interface BenchmarkPanelProps {
  risk: RiskPayload
  config: DataConfig
}

interface Cell {
  label: string
  value: string
  tone?: string
  context: string
}

export function BenchmarkPanel({ risk, config }: BenchmarkPanelProps) {
  const benchmark = risk.benchmark
  const [symbol, setSymbol] = useState('')
  const [comparison, setComparison] = useState<BenchmarkComparison | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const excess = risk.annualized_return_pct !== null && benchmark.annualized_return_pct !== null
    ? risk.annualized_return_pct - benchmark.annualized_return_pct
    : null

  const runComparison = async (event: React.FormEvent) => {
    event.preventDefault()
    const cleaned = symbol.trim().toUpperCase()
    if (!cleaned) return
    setBusy(true)
    setError(null)
    try {
      setComparison(await fetchBenchmark(config, cleaned))
    } catch (cause) {
      setComparison(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const cells: Cell[] = [
    {
      label: 'Jensen alpha',
      value: formatPercentSigned(benchmark.alpha_annualized_pct),
      tone: signClass(benchmark.alpha_annualized_pct),
      context: 'annualised, CAPM-adjusted',
    },
    {
      label: 'Tracking error',
      value: formatPercent(benchmark.tracking_error_pct),
      context: 'annualised active risk',
    },
    {
      label: 'Information ratio',
      value: formatRatio(benchmark.information_ratio),
      tone: signClass(benchmark.information_ratio),
      context: 'alpha per unit of active risk',
    },
    {
      label: 'Beta',
      value: formatRatio(risk.beta.value),
      context: `sensitivity to ${benchmark.name}`,
    },
  ]

  const capture = (value: number | null) =>
    value === null ? EM_DASH : `${formatRatio(value)}×`

  const rows: { label: string; value: string; tone?: string }[] = [
    {
      label: 'Portfolio annualised return',
      value: formatPercentSigned(risk.annualized_return_pct),
      tone: signClass(risk.annualized_return_pct),
    },
    {
      label: 'Benchmark annualised return',
      value: formatPercentSigned(benchmark.annualized_return_pct),
      tone: signClass(benchmark.annualized_return_pct),
    },
    {
      label: 'Excess annualised return',
      value: formatPercentSigned(excess),
      tone: signClass(excess),
    },
    {
      label: 'Benchmark volatility',
      value: formatPercent(benchmark.volatility_annualized_pct),
    },
    {
      label: 'Benchmark max drawdown',
      value: formatPercent(benchmark.max_drawdown_pct),
      tone: 'neg',
    },
    {
      label: 'Up / down capture',
      value: `${capture(benchmark.up_capture)} / ${capture(benchmark.down_capture)}`,
      tone:
        benchmark.up_capture !== null &&
        benchmark.down_capture !== null &&
        benchmark.up_capture > benchmark.down_capture
          ? 'pos'
          : undefined,
    },
    {
      label: 'Correlation to benchmark',
      value: formatRatio(benchmark.correlation),
    },
  ]

  return (
    <Panel
      title="Benchmark"
      subtitle={`${benchmark.name} (${benchmark.symbol}) · ${benchmark.observations} observations`}
      className="benchmark"
    >
      <div className="benchmark__cells">
        {cells.map((cell) => (
          <div key={cell.label} className="benchmark__cell">
            <span className="benchmark__label">{cell.label}</span>
            <span className={`num benchmark__value ${cell.tone ?? ''}`}>{cell.value}</span>
            <span className="benchmark__context">{cell.context}</span>
          </div>
        ))}
      </div>

      <table className="readout benchmark__readout">
        <caption className="sr-only">
          Portfolio and benchmark return and risk statistics over the common sample.
        </caption>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="readout__label">{row.label}</td>
              <td className={`readout__value num ${row.tone ?? ''}`}>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="panel-note">
        Alpha and beta are estimated from daily excess returns. A capture ratio above
        1.00 means the portfolio moved more than the benchmark in that direction.
      </p>

      <form className="benchmark__compare" onSubmit={(event) => void runComparison(event)}>
        <label className="field">
          <span className="field__label">Compare with another benchmark</span>
          <div className="field__inline">
            <input
              className="input num"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              placeholder="^STOXX50E"
              autoComplete="off"
            />
            <button type="submit" className="button button--quiet" disabled={busy || !symbol.trim()}>
              {busy ? 'Comparing' : 'Compare'}
            </button>
          </div>
        </label>
      </form>

      {error ? <p className="field__error">{error}</p> : null}

      {comparison ? (
        <table className="readout benchmark__readout">
          <caption className="sr-only">
            The same statistics against {comparison.symbol}.
          </caption>
          <tbody>
            <tr>
              <td className="readout__label">Benchmark</td>
              <td className="readout__value num">{comparison.symbol}</td>
            </tr>
            <tr>
              <td className="readout__label">Active return</td>
              <td className={`readout__value num ${signClass(comparison.active_return_pct)}`}>
                {formatPercentSigned(comparison.active_return_pct)}
              </td>
            </tr>
            <tr>
              <td className="readout__label">Jensen alpha</td>
              <td className={`readout__value num ${signClass(comparison.alpha_annualized_pct)}`}>
                {formatPercentSigned(comparison.alpha_annualized_pct)}
              </td>
            </tr>
            <tr>
              <td className="readout__label">Beta</td>
              <td className="readout__value num">{formatRatio(comparison.beta)}</td>
            </tr>
            <tr>
              <td className="readout__label">Tracking error</td>
              <td className="readout__value num">{formatPercent(comparison.tracking_error_pct)}</td>
            </tr>
            <tr>
              <td className="readout__label">Information ratio</td>
              <td className={`readout__value num ${signClass(comparison.information_ratio)}`}>
                {formatRatio(comparison.information_ratio)}
              </td>
            </tr>
            <tr>
              <td className="readout__label">Correlation</td>
              <td className="readout__value num">{formatRatio(comparison.correlation)}</td>
            </tr>
          </tbody>
        </table>
      ) : null}
    </Panel>
  )
}
