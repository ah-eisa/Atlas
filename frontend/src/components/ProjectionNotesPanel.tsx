/**
 * The assumptions and terminal percentiles behind the Monte Carlo fan.
 *
 * Kept separate from the chart so a reader can see exactly what was simulated:
 * the horizon, the fitted distribution, the correlation treatment, and the
 * values at each percentile. A projection without its method is marketing.
 */

import {
  formatDate,
  formatMoney,
  formatPercent,
  formatPercentSigned,
  signClass,
} from '../lib/format'
import type { MonteCarloPayload } from '../lib/types'
import { Panel } from './Panel'

interface ProjectionNotesPanelProps {
  montecarlo: MonteCarloPayload
  currency: string
}

const BANDS = ['p5', 'p25', 'p50', 'p75', 'p95'] as const

export function ProjectionNotesPanel({ montecarlo, currency }: ProjectionNotesPanelProps) {
  const horizonEnd = montecarlo.dates[montecarlo.dates.length - 1]
  const absolute = (value: number) => value / montecarlo.start_value - 1

  return (
    <Panel
      title="Projection detail"
      subtitle={`${montecarlo.horizon_days} trading days · simulation, not forecast`}
      className="projection-notes"
    >
      <div className="projection-notes__grid">
        <div>
          <div className="projection-notes__heading label">Terminal percentiles</div>
          <table className="readout projection-notes__table">
            <caption className="sr-only">
              Simulated portfolio value at each percentile after the projection horizon.
            </caption>
            <tbody>
              {BANDS.map((band) => {
                const value = montecarlo.final_values[band]
                const change = absolute(value)
                return (
                  <tr key={band}>
                    <td className="readout__label">
                      {band === 'p50' ? 'Median · p50' : `p${band.slice(1)}`}
                    </td>
                    <td className="readout__value num">{formatMoney(value)}</td>
                    <td className={`readout__value num ${signClass(change)}`}>
                      {formatPercentSigned(change, 1)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div>
          <div className="projection-notes__heading label">Simulation</div>
          <dl className="metadata">
            <div>
              <dt>Start value</dt>
              <dd className="num">
                {formatMoney(montecarlo.start_value)} {currency}
              </dd>
            </div>
            <div>
              <dt>Horizon ends</dt>
              <dd className="num">{formatDate(horizonEnd)}</dd>
            </div>
            <div>
              <dt>Paths</dt>
              <dd className="num">{montecarlo.paths.toLocaleString('en-GB')}</dd>
            </div>
            <div>
              <dt>Distribution</dt>
              <dd>{montecarlo.assumptions.distribution}</dd>
            </div>
            <div>
              <dt>Correlation</dt>
              <dd>{montecarlo.assumptions.correlation}</dd>
            </div>
            <div>
              <dt>Rebalancing</dt>
              <dd>{montecarlo.assumptions.rebalancing}</dd>
            </div>
            <div>
              <dt>Lookback</dt>
              <dd className="num">{montecarlo.assumptions.lookback_days} days</dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd>{montecarlo.assumptions.fees}</dd>
            </div>
          </dl>
        </div>
      </div>

      <p className="panel-note">
        Percentiles come from a bootstrap of historical daily returns, with the observed
        cross-asset correlation preserved. The median is not a target: roughly half of the
        simulated paths finished below it. The model does not know about regime changes,
        liquidity, taxes, or anything that has not happened yet.
      </p>

      <div className="projection-notes__probability">
        <span className="projection-notes__probability-label">Probability of loss</span>
        <span
          className={`num projection-notes__probability-value ${
            montecarlo.probability_below_start_pct > 0.5 ? 'neg' : ''
          }`}
        >
          {formatPercent(montecarlo.probability_below_start_pct, 1)}
        </span>
        <span className="projection-notes__probability-context">
          of simulated values ended below today&apos;s {formatMoney(montecarlo.start_value)}{' '}
          {currency}
        </span>
      </div>
    </Panel>
  )
}
