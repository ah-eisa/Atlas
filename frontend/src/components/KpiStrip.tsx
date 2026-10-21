/**
 * The headline metrics band, directly beneath the top bar.
 *
 * Eight figures that answer "how risky is this, and what is it likely to do
 * next" without scrolling. Hairline-divided cells over a `--line` background —
 * the same technique as every other grid here, so these read as one continuous
 * instrument panel rather than as eight floating stat cards.
 *
 * Each cell is label / value / one line of context, because a risk number
 * without its convention (annualised? against which rate? over what window?)
 * is not interpretable.
 */

import {
  formatMoneyCompact,
  formatMonthYear,
  formatPercent,
  formatPercentSigned,
  formatRatio,
  signClass,
} from '../lib/format'
import type { MonteCarloPayload, RiskPayload, SummaryPayload } from '../lib/types'
import { AnimatedNumber } from './AnimatedNumber'

interface KpiStripProps {
  risk: RiskPayload
  montecarlo: MonteCarloPayload
  summary: SummaryPayload
  currency: string
}

interface Kpi {
  label: string
  /** Raw figure, so the cell can count into place. */
  raw: number | null
  format: (value: number | null | undefined) => string
  context: string
  tone?: string
}

export function KpiStrip({ risk, montecarlo, summary, currency }: KpiStripProps) {
  const var95 = risk.value_at_risk['95']
  const drawdown = risk.max_drawdown

  const drawdownWindow =
    drawdown.peak_date && drawdown.trough_date
      ? `${formatMonthYear(drawdown.peak_date)} – ${formatMonthYear(drawdown.trough_date)}`
      : 'no decline recorded'

  const withCurrency = (value: number | null | undefined) =>
    `${formatMoneyCompact(value)} ${currency}`

  const kpis: Kpi[] = [
    {
      label: 'Annualised return',
      raw: risk.annualized_return_pct,
      format: (value) => formatPercentSigned(value),
      tone: signClass(risk.annualized_return_pct),
      context: `geometric · ${risk.lookback_days}d sample`,
    },
    {
      label: 'Volatility',
      raw: risk.volatility_annualized_pct,
      format: (value) => formatPercent(value),
      context: `annualised · ${risk.lookback_days}d sample`,
    },
    {
      label: 'Sharpe',
      raw: risk.sharpe_ratio,
      format: formatRatio,
      tone: signClass(risk.sharpe_ratio),
      context: `excess return vs ${formatPercent(risk.risk_free_rate, 1)} rf`,
    },
    {
      label: 'Max drawdown',
      raw: drawdown.pct,
      format: (value) => formatPercent(value),
      tone: signClass(drawdown.pct),
      context: drawdownWindow,
    },
    {
      label: 'CVaR 95%',
      raw: var95?.cvar_value ?? null,
      format: withCurrency,
      tone: 'neg',
      context: `1-day expected shortfall · ${formatPercent(var95?.cvar_pct)}`,
    },
    {
      label: `Beta vs ${risk.beta.benchmark_name}`,
      raw: risk.beta.value,
      format: formatRatio,
      context:
        risk.beta.value !== null && risk.beta.value < 1
          ? 'less reactive than index'
          : 'more reactive than index',
    },
    {
      label: 'P(loss) 1Y',
      raw: montecarlo.probability_below_start_pct,
      format: (value) => formatPercent(value, 1),
      tone: montecarlo.probability_below_start_pct > 0.5 ? 'neg' : undefined,
      context: `${montecarlo.paths.toLocaleString('en-GB')} simulated paths`,
    },
    {
      label: 'Median 1Y',
      raw: montecarlo.median_value,
      format: withCurrency,
      tone: signClass(montecarlo.median_value - summary.total_value),
      context: `${formatPercentSigned(montecarlo.median_value / summary.total_value - 1)} on today`,
    },
  ]

  return (
    <section className="kpi" aria-label="Headline risk and outlook metrics">
      {kpis.map((kpi, index) => (
        <div key={kpi.label} className="kpi__cell">
          <span className="kpi__label">{kpi.label}</span>
          <AnimatedNumber
            value={kpi.raw}
            format={kpi.format}
            // Left-to-right cascade across the band.
            delay={120 + index * 45}
            className={`num kpi__value ${kpi.tone ?? ''}`}
          />
          <span className="kpi__context">{kpi.context}</span>
        </div>
      ))}
    </section>
  )
}
