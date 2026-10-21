/**
 * Benchmark comparison.
 *
 * The performance chart already overlays the benchmark. This panel answers the
 * next question: *is the difference skill, style, or simply more risk?* It keeps
 * the regression statistics (alpha, beta, tracking error) next to the capture
 * ratios and the benchmark's own drawdown, each with its convention stated.
 */

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
}

interface Cell {
  label: string
  value: string
  tone?: string
  context: string
}

export function BenchmarkPanel({ risk }: BenchmarkPanelProps) {
  const benchmark = risk.benchmark
  const excess = risk.annualized_return_pct !== null && benchmark.annualized_return_pct !== null
    ? risk.annualized_return_pct - benchmark.annualized_return_pct
    : null

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
      className="panel--fill benchmark"
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
    </Panel>
  )
}
