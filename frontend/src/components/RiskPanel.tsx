/**
 * Risk metrics as a terminal readout: label, value, and one line of plain
 * English saying what the number actually means for this portfolio.
 *
 * Deliberately a table rather than a row of stat cards - the meanings are the
 * point, and they need the horizontal room.
 */

import {
  formatDate,
  formatMoney,
  formatPercent,
  formatPercentSigned,
  formatRatio,
  signClass,
  EM_DASH,
} from '../lib/format'
import type { RiskPayload } from '../lib/types'
import { Panel } from './Panel'

interface RiskPanelProps {
  risk: RiskPayload
  currency: string
}

interface Row {
  label: string
  value: string
  meaning: string
  tone?: string
}

/** Build the readout rows, weaving the computed figures into their meanings. */
function buildRows(risk: RiskPayload, currency: string): Row[] {
  const var95 = risk.value_at_risk['95']
  const var99 = risk.value_at_risk['99']
  const drawdown = risk.max_drawdown
  const beta = risk.beta.value
  const money = (value: number | null) => `${formatMoney(value)} ${currency}`

  const drawdownMeaning = drawdown.peak_date
    ? `Worst peak-to-trough fall, ${formatDate(drawdown.peak_date)} to ${formatDate(drawdown.trough_date)}. ` +
      (drawdown.recovery_date
        ? `Recovered ${formatDate(drawdown.recovery_date)}.`
        : 'Not yet recovered.')
    : 'No decline recorded over the sample.'

  const betaMeaning =
    beta === null
      ? 'Not available.'
      : `A 1% move in the ${risk.beta.benchmark_name} has historically moved this portfolio about ${formatRatio(beta)}%. ` +
        (beta < 1 ? 'Less reactive than the index.' : 'More reactive than the index.')

  return [
    {
      label: 'Annualised return',
      value: formatPercentSigned(risk.annualized_return_pct),
      tone: signClass(risk.annualized_return_pct),
      meaning: 'Geometric mean daily return, compounded over the risk sample. It is not the same as the change in portfolio value when contributions are being made.',
    },
    {
      label: 'Volatility (ann.)',
      value: formatPercent(risk.volatility_annualized_pct),
      meaning: `Standard deviation of daily returns, annualised over ${risk.trading_days_per_year} trading days. Higher means a wider spread of outcomes.`,
    },
    {
      label: 'Downside deviation',
      value: formatPercent(risk.downside_deviation_pct),
      meaning: 'Volatility counting only returns below the risk-free rate, so upside swings are not penalised.',
    },
    {
      label: 'Sharpe ratio',
      value: formatRatio(risk.sharpe_ratio),
      tone: signClass(risk.sharpe_ratio),
      meaning: `Excess return per unit of total risk, against a ${formatPercent(risk.risk_free_rate, 1)} risk-free rate. Above 1.0 is usually considered strong.`,
    },
    {
      label: 'Sortino ratio',
      value: formatRatio(risk.sortino_ratio),
      tone: signClass(risk.sortino_ratio),
      meaning: 'Excess return per unit of downside risk only. Exceeds Sharpe when losses are rarer than gains.',
    },
    {
      label: 'Calmar ratio',
      value: formatRatio(risk.calmar_ratio),
      tone: signClass(risk.calmar_ratio),
      meaning: 'Annualised return divided by the absolute maximum drawdown. A compact reward-to-pain measure; it says nothing about recovery time.',
    },
    {
      label: 'Max drawdown',
      value: formatPercent(drawdown.pct),
      tone: signClass(drawdown.pct),
      meaning: drawdownMeaning,
    },
    {
      label: 'VaR 95% (hist.)',
      value: money(var95?.historical_value ?? null),
      tone: 'neg',
      meaning: `On the worst 5% of days the portfolio lost at least this much, read directly from the observed return distribution (${formatPercent(var95?.historical_pct)} of value).`,
    },
    {
      label: 'CVaR 95% (hist.)',
      value: money(var95?.cvar_value ?? null),
      tone: 'neg',
      meaning: `The average loss on the days beyond the 95% VaR threshold (${formatPercent(var95?.cvar_pct)} of value). Expected shortfall is more sensitive to the tail than VaR.`,
    },
    {
      label: 'VaR 95% (param.)',
      value: money(var95?.parametric_value ?? null),
      tone: 'neg',
      meaning: 'The same threshold assuming returns are normally distributed.',
    },
    {
      label: 'VaR 99% (hist.)',
      value: money(var99?.historical_value ?? null),
      tone: 'neg',
      meaning: `The worst 1% of days (${formatPercent(var99?.historical_pct)} of value). Where it exceeds the parametric figure, real losses have fatter tails than a normal distribution predicts.`,
    },
    {
      label: 'CVaR 99% (hist.)',
      value: money(var99?.cvar_value ?? null),
      tone: 'neg',
      meaning: `Average loss beyond the 99% threshold (${formatPercent(var99?.cvar_pct)} of value). This is the tail scenario a capital buffer should survive, not a typical day.`,
    },
    {
      label: 'VaR 99% (param.)',
      value: money(var99?.parametric_value ?? null),
      tone: 'neg',
      meaning: 'The 1% threshold under a normal distribution, shown for contrast.',
    },
    {
      label: `Beta vs ${risk.beta.benchmark_name}`,
      value: formatRatio(beta),
      meaning: betaMeaning,
    },
  ]
}

export function RiskPanel({ risk, currency }: RiskPanelProps) {
  const rows = buildRows(risk, currency)

  return (
    <Panel
      title="Risk"
      subtitle={`${risk.lookback_days} trading days · rf ${formatPercent(risk.risk_free_rate, 1)}`}
    >
      <table className="readout">
        <caption className="sr-only">
          Risk metrics with plain-English interpretations, computed over{' '}
          {risk.lookback_days} trading days.
        </caption>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="readout__label">{row.label}</td>
              <td className={`readout__value num ${row.tone ?? ''}`}>{row.value || EM_DASH}</td>
              <td className="readout__meaning">{row.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {risk.warnings.length > 0 ? (
        <div className="notice notice--warning">
          <span className="notice__title">Risk warnings</span>
          <ul>
            {risk.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  )
}
